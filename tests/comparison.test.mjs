import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectChanges, formatChanges, resolveComparison } from "../extensions/porthole/lib/changes.mjs";
import { tools as tourTools } from "../extensions/porthole/lib/tour.mjs";
import { createPortholeHarness } from "./support/porthole-harness.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);

function makeRepo() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "porthole-comparison-")));
    const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    run(["init", "-b", "main", "-q"]);
    run(["config", "user.email", "t@example.com"]);
    run(["config", "user.name", "t"]);
    run(["config", "commit.gpgsign", "false"]);
    const commit = (message) => {
        run(["add", "-A"]);
        run(["commit", "-qm", message]);
        return run(["rev-parse", "HEAD"]);
    };
    return { root, run, commit };
}

function lines(count, prefix = "line") {
    return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

test("a branch comparison records its merge-base and the resolved tip", async () => {
    const { root, run, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(5));
        const base = commit("base");
        run(["checkout", "-qb", "feature"]);
        writeFileSync(join(root, "a.js"), lines(6));
        const tip = commit("feature");
        run(["checkout", "-q", "main"]);
        writeFileSync(join(root, "b.js"), lines(2));
        commit("main moved on");
        run(["checkout", "-q", "feature"]);

        const resolved = await resolveComparison({ since: "main" }, { cwd: root });
        assert.equal(resolved.kind, "revisions");
        assert.equal(resolved.base, base);
        assert.equal(resolved.target, tip);
        assert.equal(resolved.label, "main...HEAD");
        assert.deepEqual(resolved.renames, {});
        assert.equal(resolved.renamesComplete, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("porthole_changes prints a comparison that resolves to the same revisions", async () => {
    const { root, run, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(5));
        commit("base");
        run(["checkout", "-qb", "feature"]);
        writeFileSync(join(root, "a.js"), lines(7));
        commit("feature");

        const model = await collectChanges({ since: "main" }, { cwd: root });
        const printed = /pass comparison: (\{.*\})$/m.exec(formatChanges(model));
        assert.ok(printed, "the inventory names the argument to copy");
        const argument = JSON.parse(printed[1]);
        assert.deepEqual(argument, model.recordComparison);
        assert.match(argument.since, /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/);

        writeFileSync(join(root, "a.js"), lines(9));
        commit("feature moved after the inventory");
        const resolved = await resolveComparison(argument, { cwd: root });
        assert.equal(`${resolved.base}..${resolved.target}`, argument.since);
        assert.equal(resolved.label, "main...HEAD");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a root commit is recorded as that commit's own changes against the empty tree", async () => {
    const { root, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(3));
        const rootCommit = commit("root");
        const model = await collectChanges({}, { cwd: root });
        assert.deepEqual(model.recordComparison, { since: `${rootCommit}^!`, label: "the last commit" });

        const resolved = await resolveComparison(model.recordComparison, { cwd: root });
        assert.equal(resolved.base, null);
        assert.equal(resolved.target, rootCommit);

        writeFileSync(join(root, "a.js"), lines(4));
        const second = commit("second");
        const single = await resolveComparison({ since: `${second}^!` }, { cwd: root });
        assert.equal(single.base, rootCommit);
        assert.equal(single.target, second);
        const inventory = await collectChanges({ since: `${second}^!` }, { cwd: root });
        assert.equal(inventory.files.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uncommitted and staged comparisons are recorded as live changes since HEAD", async () => {
    const { root, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(3));
        const head = commit("base");
        writeFileSync(join(root, "a.js"), lines(4));
        assert.deepEqual((await collectChanges({}, { cwd: root })).recordComparison, { since: "uncommitted" });

        const live = await resolveComparison({ since: "uncommitted" }, { cwd: root });
        assert.equal(live.kind, "live");
        assert.equal(live.base, head);
        assert.equal(live.target, null);
        assert.deepEqual(live.notes, []);

        const staged = await resolveComparison({ since: "staged" }, { cwd: root });
        assert.equal(staged.kind, "live");
        assert.match(staged.notes.join(" "), /index is not durable/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unborn repository records live changes against the empty tree", async () => {
    const { root } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(3));
        const live = await resolveComparison({ since: "uncommitted" }, { cwd: root });
        assert.equal(live.kind, "live");
        assert.equal(live.base, null);
        const ref = await resolveComparison({ since: "main" }, { cwd: root });
        assert.match(ref.unavailable, /no HEAD commit/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("renames are collected only for the Tour's step files", async () => {
    const { root, run, commit } = makeRepo();
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "old.js"), lines(30, "kept"));
        writeFileSync(join(root, "other-old.js"), lines(30, "other"));
        const base = commit("base");
        run(["mv", "src/old.js", "src/new.js"]);
        run(["mv", "other-old.js", "other-new.js"]);
        const tip = commit("rename");

        const resolved = await resolveComparison(
            { since: `${base}..${tip}` },
            { cwd: root, files: [join(root, "src", "new.js")] },
        );
        assert.deepEqual(resolved.renames, { "src/new.js": "src/old.js" });
        assert.equal(resolved.renamesComplete, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid comparisons throw and unresolvable ones report unavailable", async () => {
    const { root, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(3));
        commit("base");
        await assert.rejects(resolveComparison({ since: "--output=x" }, { cwd: root }), /Invalid revision/);
        await assert.rejects(resolveComparison({ since: "no-such-branch" }, { cwd: root }), /could not resolve/);
        await assert.rejects(resolveComparison({}, { cwd: root }), /exactly one/);
        await assert.rejects(resolveComparison({ since: "main", pr: 3 }, { cwd: root }), /exactly one/);
        await assert.rejects(resolveComparison({ pr: 0 }, { cwd: root }), /positive/);
        await assert.rejects(resolveComparison("main", { cwd: root }), /must be an object/);

        const missingPr = await resolveComparison({ pr: 7 }, {
            cwd: root,
            runGh: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), title: "x" }) }),
        });
        assert.match(missingPr.unavailable, /not available in this clone/);
    } finally { rmSync(root, { recursive: true, force: true }); }

    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "porthole-comparison-norepo-")));
    try {
        const resolved = await resolveComparison({ since: "uncommitted" }, { cwd: outside });
        assert.equal(resolved.unavailable, "not a git repository");
    } finally { rmSync(outside, { recursive: true, force: true }); }
});

test("a locally available PR records its merge-base and head", async () => {
    const { root, run, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(3));
        const base = commit("base");
        run(["checkout", "-qb", "pr"]);
        writeFileSync(join(root, "a.js"), lines(5));
        const head = commit("pr");
        run(["checkout", "-q", "main"]);
        const resolved = await resolveComparison({ pr: 12, label: "PR 12\nsession expiry" }, {
            cwd: root,
            runGh: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: head, baseRefOid: base, title: "t" }) }),
        });
        assert.equal(resolved.base, base);
        assert.equal(resolved.target, head);
        assert.equal(resolved.label, "PR 12 session expiry");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("labels are sanitised and bounded", async () => {
    const { root, commit } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), lines(3));
        commit("base");
        const resolved = await resolveComparison({ since: "uncommitted", label: `x\u0007${"y".repeat(300)}` }, { cwd: root });
        assert.equal(resolved.label.length, 120);
        assert.doesNotMatch(resolved.label, /[\u0000-\u001f]/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- porthole_tour ------------------------------------------------------------

function tourRoute(requests, { recorded = true } = {}) {
    return {
        tour: (payload) => {
            requests.push(payload);
            return {
                ok: true,
                result: {
                    tourId: payload.tourId || "tour",
                    steps: payload.steps.length,
                    active: false,
                    library: 1,
                    ...(recorded && payload.comparison ? { comparisonRecorded: true } : {}),
                },
            };
        },
    };
}

async function withTourWindow(options, body) {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession("55555555-5555-5555-5555-555555555555", process.cwd());
        const requests = [];
        harness.addWindow({ windowId: "3333333333333333", session, routes: tourRoute(requests, options) });
        await body({ harness, definitions: tourTools(() => session), requests });
    } finally {
        await harness.dispose();
    }
}

const STEP = { file: THIS_FILE, startLine: 1, stepTitle: "Here", narration: "A step." };

test("porthole_tour sends a resolved comparison and reports it as recorded", async () => {
    await withTourWindow({}, async ({ harness, definitions, requests }) => {
        const text = await harness.invokeTool(definitions, "porthole_tour", {
            tourId: "compared", activate: false, steps: [STEP], comparison: { since: "uncommitted" },
        });
        assert.equal(requests.length, 1);
        const sent = requests[0].comparison;
        assert.equal(sent.kind, "live");
        assert.match(sent.base || "", /^[0-9a-f]{40}$|^$/);
        assert.equal(sent.target, null);
        assert.deepEqual(Object.keys(sent).sort(), ["base", "kind", "label", "renames", "renamesComplete", "target"]);
        assert.match(text, /Recorded comparison: uncommitted changes/);
    });
});

test("porthole_tour without a comparison sends the payload unchanged", async () => {
    await withTourWindow({}, async ({ harness, definitions, requests }) => {
        const text = await harness.invokeTool(definitions, "porthole_tour", { tourId: "plain", activate: false, steps: [STEP] });
        assert.equal(Object.hasOwn(requests[0], "comparison"), false);
        assert.doesNotMatch(text, /comparison/i);
    });
});

test("an invalid comparison refuses the Tour before contacting the companion", async () => {
    await withTourWindow({}, async ({ harness, definitions, requests }) => {
        const text = await harness.invokeTool(definitions, "porthole_tour", {
            tourId: "bad", steps: [STEP], comparison: { since: "--evil" },
        });
        assert.equal(requests.length, 0);
        assert.match(text, /invalid comparison/);
        assert.match(text, /Nothing was published/);
    });
});

test("an older companion that ignores the comparison is reported", async () => {
    await withTourWindow({ recorded: false }, async ({ harness, definitions }) => {
        const text = await harness.invokeTool(definitions, "porthole_tour", {
            tourId: "old", activate: false, steps: [STEP], comparison: { since: "uncommitted" },
        });
        assert.match(text, /did not record the comparison; update the Porthole companion/);
    });
});
