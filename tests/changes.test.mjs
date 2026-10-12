import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    changes,
    collectChanges,
    formatChanges,
    isNoise,
    mergeHunks,
    parseNameStatus,
    parseNumstat,
    parseHunks,
} from "../extensions/porthole/lib/changes.mjs";
import { runCommand } from "../extensions/porthole/lib/command.mjs";

// --- parsing: no git, no filesystem -----------------------------------------

test("a modification becomes the range it occupies in the new file", () => {
    const [hunk] = parseHunks(["+++ b/src/a.js", "@@ -12,3 +12,7 @@ function foo(", "+x"].join("\n"));
    assert.deepEqual(
        { file: hunk.file, start: hunk.start, end: hunk.end, context: hunk.context },
        { file: "src/a.js", start: 12, end: 18, context: "function foo(" },
    );
});

test("a hunk header without commas is one line on each side", () => {
    // Taken from real `git diff --unified=0` output.
    const [hunk] = parseHunks(["+++ b/a.js", "@@ -20 +16 @@ line 18"].join("\n"));
    assert.equal(hunk.start, 16);
    assert.equal(hunk.end, 16);
});

test("a pure deletion still earns a stop, at the line the code followed", () => {
    const [hunk] = parseHunks(["+++ b/a.js", "@@ -5,4 +4,0 @@ line 3"].join("\n"));
    assert.equal(hunk.deletion, true);
    assert.equal(hunk.start, 4);
    assert.equal(hunk.end, 4);
});

test("a deletion at the very start of a file clamps to line 1, never 0", () => {
    const [hunk] = parseHunks(["+++ b/a.js", "@@ -1,3 +0,0 @@"].join("\n"));
    assert.equal(hunk.start, 1);
    assert.equal(hunk.end, 1);
});

test("each hunk is attributed to the file it was under", () => {
    const hunks = parseHunks(
        ["+++ b/one.js", "@@ -1 +1 @@", "diff --git a/two.js b/two.js", "+++ b/two.js", "@@ -5,2 +5,2 @@"].join("\n"),
    );
    assert.deepEqual(hunks.map((h) => h.file), ["one.js", "two.js"]);
});

test("a hunk against /dev/null is skipped rather than attributed to the last file", () => {
    const hunks = parseHunks(
        ["+++ b/one.js", "@@ -1 +1 @@", "diff --git a/gone.js b/gone.js", "+++ /dev/null", "@@ -5,2 +0,0 @@"].join("\n"),
    );
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].file, "one.js");
});

test("hunks close together merge, and far apart do not", () => {
    const near = mergeHunks([
        { file: "a", start: 1, end: 5, context: "", deletion: false, hunks: 1 },
        { file: "a", start: 16, end: 20, context: "", deletion: false, hunks: 1 },
    ]);
    assert.equal(near.length, 1, "a gap of exactly ten should merge");
    assert.equal(near[0].hunks, 2);

    const far = mergeHunks([
        { file: "a", start: 1, end: 5, context: "", deletion: false, hunks: 1 },
        { file: "a", start: 17, end: 20, context: "", deletion: false, hunks: 1 },
    ]);
    assert.equal(far.length, 2, "a gap of eleven should not merge");
});

test("merging is transitive, but never across files", () => {
    const merged = mergeHunks([
        { file: "a", start: 1, end: 2, context: "", deletion: false, hunks: 1 },
        { file: "a", start: 8, end: 9, context: "", deletion: false, hunks: 1 },
        { file: "a", start: 15, end: 16, context: "", deletion: false, hunks: 1 },
        { file: "b", start: 17, end: 18, context: "", deletion: false, hunks: 1 },
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual([merged[0].start, merged[0].end, merged[0].hunks], [1, 16, 3]);
    assert.equal(merged[1].file, "b");
});

test("noise is matched on whole path segments, not substrings", () => {
    assert.equal(isNoise("package-lock.json"), true);
    assert.equal(isNoise("a/dist/b.js"), true);
    assert.equal(isNoise("x.min.js"), true);
    assert.equal(isNoise("web/assets/logo.svg"), true);
    assert.equal(isNoise("src/dist-helper.js"), false, "dist-helper is not in dist/");
    assert.equal(isNoise("src/build.js"), false, "a file called build is not the build directory");
});

test("machine-readable rename metadata preserves both paths and line counts", () => {
    const [entry] = parseNameStatus("R100\0old file.js\0new file.js\0");
    assert.deepEqual(entry, { status: "R100", oldPath: "old file.js", path: "new file.js" });
    const counts = parseNumstat("0\t0\t\0old file.js\0new file.js\0");
    assert.deepEqual(counts.get("new file.js"), { added: 0, removed: 0, binary: false });
});

test("the formatted output tells the model these are candidates, not a tour", () => {
    const out = formatChanges({
        description: "main...HEAD",
        auto: null,
        candidates: [{ file: "a.js", start: 1, end: 4, context: "fn", deletion: false, hunks: 1, counts: { added: 3, removed: 1 } }],
        files: [{ file: "a.js", path: "a.js", status: "M", added: 3, removed: 1 }],
        mode: "candidates",
        inventoryComplete: true,
        coordinateBasis: "working tree",
        totals: { added: 3, removed: 1 },
        deleted: [],
        skipped: 0,
        truncated: false,
        total: 1,
    });
    assert.match(out, /candidate steps, not a tour/);
    assert.match(out, /porthole_tour/);
    assert.match(out, /git's guess/);
});

// --- against a real repository ----------------------------------------------

function makeRepo() {
    // The native realpath because macOS hands out a symlinked temp dir and the
    // Windows runner an 8.3 short one; git reports the resolved long path, which
    // would make every path comparison here disagree.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "porthole-changes-")));
    const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    run(["init", "-b", "main", "-q"]);
    // Set locally: a CI machine may have no identity, and a global signing key
    // would otherwise hang the commit waiting for a passphrase.
    run(["config", "user.email", "t@example.com"]);
    run(["config", "user.name", "t"]);
    run(["config", "commit.gpgsign", "false"]);
    return { root, run };
}

function numbered(count, prefix = "line") {
    return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

async function inRepo(root, fn) {
    const previous = process.cwd();
    process.chdir(root);
    try {
        return await fn();
    } finally {
        process.chdir(previous);
    }
}

test("an uncommitted edit is found without being asked, at the lines edited", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(40));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        const lines = numbered(40).split("\n");
        lines[19] = "CHANGED";
        writeFileSync(join(root, "a.js"), lines.join("\n"));

        const out = await inRepo(root, () => changes({}));
        assert.match(out, /uncommitted changes/);
        assert.match(out, /Auto-detected/);
        assert.match(out, /^M .*[/\\]a\.js\s+\(\+1 -1\)$/m);
        assert.match(out, /^\s+20\s/m, `expected a candidate at line 20:\n${out}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a file created but never added is still offered - the autopilot case", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(10));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        writeFileSync(join(root, "brand-new.js"), numbered(12));

        const out = await inRepo(root, () => changes({}));
        assert.match(out, /brand-new\.js/, `untracked files must not vanish:\n${out}`);
        assert.match(out, /new file, 12 lines/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a branch is compared against its merge-base, not against the branch tip", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(10));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        run(["checkout", "-q", "-b", "feature"]);
        writeFileSync(join(root, "mine.js"), numbered(6));
        run(["add", "-A"]);
        run(["commit", "-qm", "mine"]);

        run(["checkout", "-q", "main"]);
        writeFileSync(join(root, "theirs.js"), numbered(6));
        run(["add", "-A"]);
        run(["commit", "-qm", "theirs"]);
        run(["checkout", "-q", "feature"]);

        const out = await inRepo(root, () => changes({}));
        assert.match(out, /mine\.js/);
        assert.doesNotMatch(
            out,
            /theirs\.js/,
            `three-dot comparison must exclude what landed on main afterwards:\n${out}`,
        );
        const fullRef = await collectChanges({ since: "refs/heads/main" }, { cwd: root });
        assert.match(fullRef.description, /refs\/heads\/main\.\.\.HEAD/);
        assert.equal(fullRef.files.some((entry) => entry.path === "theirs.js"), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a deleted file is reported as unwalkable, never as a candidate step", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "keep.js"), numbered(20));
        writeFileSync(join(root, "gone.js"), numbered(20));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        unlinkSync(join(root, "gone.js"));
        const lines = numbered(20).split("\n");
        lines[4] = "CHANGED";
        writeFileSync(join(root, "keep.js"), lines.join("\n"));

        const model = await inRepo(root, () => collectChanges({}));
        const out = formatChanges(model);
        assert.match(out, /^D .*gone\.js.*deleted; no current-file step/m);
        assert.equal(model.candidates.some((entry) => entry.file.endsWith("gone.js")), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a large new file is capped rather than offered whole", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "seed.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        writeFileSync(join(root, "big.js"), numbered(300));
        run(["add", "-A"]);

        const out = await inRepo(root, () => changes({}));
        assert.match(out, /1-80\s+new file, 300 lines - pick sub-ranges/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("generated files are skipped and counted", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(10));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        writeFileSync(join(root, "package-lock.json"), '{"a":1}');
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(join(root, "dist", "bundle.js"), numbered(5));
        const lines = numbered(10).split("\n");
        lines[2] = "CHANGED";
        writeFileSync(join(root, "a.js"), lines.join("\n"));
        run(["add", "-A"]);

        const model = await inRepo(root, () => collectChanges({}));
        assert.equal(model.files.filter((entry) => entry.noise).length, 2);
        assert.equal(model.candidates.some((entry) => entry.path === "package-lock.json"), false);
        assert.match(formatChanges(model), /package-lock\.json/);
        const all = await inRepo(root, () => collectChanges({ includeAll: true }));
        assert.equal(all.candidates.some((entry) => entry.path === "package-lock.json"), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("too many candidates are truncated with a way out", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "seed.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        for (let i = 0; i < 8; i += 1) writeFileSync(join(root, `f${i}.js`), numbered(3));
        run(["add", "-A"]);

        const out = await inRepo(root, () => changes({ limit: 3 }));
        assert.match(out, /showing 3 of 8 candidates/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("outside a repository it explains itself instead of throwing", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "porthole-norepo-")));
    try {
        const out = await inRepo(root, () => changes({}));
        assert.equal(out, "porthole: not a git repository, so there is nothing to compare.");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an unresolvable ref is named rather than silently compared to something else", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        const out = await inRepo(root, () => changes({ since: "no-such-branch" }));
        assert.match(out, /could not resolve 'no-such-branch'/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("since and pr together is refused rather than one being ignored", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        const out = await inRepo(root, () => changes({ since: "main", pr: 7 }));
        assert.match(out, /either 'since' or 'pr', not both/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// --- pull requests, with gh injected ----------------------------------------

test("a PR that is not checked out returns labelled inventory rather than wrong current-file steps", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(10));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        const runGh = (args) => {
            if (args[1] === "view") {
                return JSON.stringify({
                    headRefOid: "0000000000000000000000000000000000000000",
                    headRefName: "someone-else",
                    baseRefName: "main",
                    title: "Their change",
                    changedFiles: 1,
                    url: "https://github.com/Lando-00/porthole/pull/42",
                });
            }
            return JSON.stringify([[{ filename: "src/theirs.js", status: "added", additions: 10, deletions: 0 }]]);
        };

        const out = await inRepo(root, () => changes({ pr: 42 }, null, { runGh }));
        assert.match(out, /not checked out/);
        assert.match(out, /inventory-only/);
        assert.match(out, /0 candidate step/);
        assert.match(out, /theirs\.js/);
        assert.doesNotMatch(out, /Run 'gh pr checkout/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a checked-out pull request is compared against its base branch", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(10));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        run(["checkout", "-q", "-b", "feature"]);
        writeFileSync(join(root, "mine.js"), numbered(6));
        run(["add", "-A"]);
        run(["commit", "-qm", "mine"]);

        const head = run(["rev-parse", "HEAD"]).trim();
        const runGh = () =>
            JSON.stringify({ headRefOid: head, baseRefOid: run(["rev-parse", "main"]).trim(), headRefName: "feature", baseRefName: "main", title: "Mine" });

        const out = await inRepo(root, () => changes({ pr: 7 }, null, { runGh }));
        assert.match(out, /PR 7 "Mine"/);
        assert.match(out, /mine\.js/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("gh being absent is reported as a missing tool, not as an empty diff", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);

        const out = await inRepo(root, () => changes({ pr: 1 }, null, { runGh: () => null }));
        assert.match(out, /GitHub CLI availability, authentication/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// --- spec resolution ---------------------------------------------------------

test("source content that looks like a file header cannot redirect a subsequent hunk", () => {
    const hunks = parseHunks([
        "diff --git a/source.md b/source.md", "+++ b/source.md",
        "@@ -0,0 +1 @@", "+++ b/not-a-file.js",
        "@@ -10 +11 @@", "-old", "+new",
    ].join("\n"));
    assert.equal(hunks.length, 2);
    assert.equal(hunks[1].file, "source.md");
});

test("deleted-only, rename-only and binary-only comparisons remain visible", async () => {
    for (const kind of ["deleted", "renamed", "binary"]) {
        const { root, run } = makeRepo();
        try {
            writeFileSync(join(root, "a.js"), numbered(10));
            writeFileSync(join(root, "image.png"), Buffer.from([0, 1, 2]));
            run(["add", "-A"]);
            run(["commit", "-qm", "base"]);
            if (kind === "deleted") unlinkSync(join(root, "a.js"));
            if (kind === "renamed") run(["mv", "a.js", "moved.js"]);
            if (kind === "binary") writeFileSync(join(root, "image.png"), Buffer.from([0, 1, 3]));
            const result = await collectChanges({}, { cwd: root });
            assert.equal(result.files.length, 1);
            assert.equal(result.mode, "inventory-only");
            assert.doesNotMatch(formatChanges(result), /no changes found/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test("a subdirectory caller receives absolute candidate paths", async () => {
    const { root, run } = makeRepo();
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "a.js"), numbered(10));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        writeFileSync(join(root, "src", "a.js"), "changed\n" + numbered(10));
        const result = await collectChanges({}, { cwd: join(root, "src") });
        assert.equal(result.candidates[0].file, join(root, "src", "a.js"));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("staged evidence names its coordinate basis rather than claiming current-file alignment", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(30));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        const lines = numbered(30).split("\n");
        lines[19] = "changed";
        writeFileSync(join(root, "a.js"), lines.join("\n"));
        run(["add", "-A"]);
        writeFileSync(join(root, "a.js"), numbered(100, "prefix") + "\n" + lines.join("\n"));
        const result = await collectChanges({ since: "staged" }, { cwd: root });
        assert.equal(result.coordinateBasis, "index");
        assert.equal(result.candidates[0].start, 20);
        assert.match(formatChanges(result), /not guaranteed current-file locations/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a very large single line falls back to inventory even for limit one", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        writeFileSync(join(root, "a.js"), "x".repeat(800_000));
        const index = readFileSync(join(root, ".git", "index"));
        const result = await collectChanges({ limit: 1 }, { cwd: root });
        assert.equal(result.mode, "inventory-only");
        assert.equal(result.files.length, 1);
        assert.match(result.inventoryReason, /output-limit/);
        assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large file inventories do not request a patch", async () => {
    const { root, run } = makeRepo();
    const commands = [];
    try {
        writeFileSync(join(root, "base.js"), "base");
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        for (let i = 0; i < 51; i += 1) writeFileSync(join(root, `file-${i}.js`), "new");
        const result = await collectChanges({}, {
            cwd: root,
            runCommand: (command, args, options) => {
                commands.push(args);
                return runCommand(command, args, options);
            },
        });
        assert.equal(result.files.length, 51);
        assert.equal(result.mode, "inventory-only");
        assert.equal(commands.some((args) => args.includes("--unified=0")), false);
        assert.match(formatChanges(result), /line counts unknown/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root commits and unborn repositories are explicit comparisons", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        const initial = await collectChanges({}, { cwd: root });
        assert.match(initial.description, /no HEAD commit/);
        assert.equal(initial.files.length, 1);
        run(["add", "-A"]);
        const staged = await collectChanges({ since: "staged" }, { cwd: root });
        assert.match(staged.description, /empty tree/);
        run(["commit", "-qm", "root"]);
        const committed = await collectChanges({}, { cwd: root });
        assert.equal(committed.files.length, 1);
        assert.equal(committed.files[0].status, "A");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spaces and non-ASCII names retain their exact paths", async () => {
    const { root, run } = makeRepo();
    const name = "space \u00e9.js";
    try {
        writeFileSync(join(root, name), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        writeFileSync(join(root, name), "new\n" + numbered(5));
        const result = await collectChanges({}, { cwd: root });
        assert.equal(result.files[0].file, join(root, name));
        assert.equal(result.candidates[0].file, join(root, name));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("incomplete remote PR metadata is never described as complete coverage", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        const result = await collectChanges({ pr: 7 }, {
            cwd: root,
            runGh: (args) => JSON.stringify(args[0] === "pr"
                ? { headRefOid: "a".repeat(40), title: "remote", changedFiles: 5, url: "https://github.com/Lando-00/porthole/pull/7" }
                : [[{ filename: "remote.js", status: "added", additions: 10, deletions: 0 }]]),
        });
        assert.equal(result.inventoryComplete, false);
        assert.match(formatChanges(result), /INCOMPLETE INVENTORY/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("oversized formatted inventories report a limit instead of silent truncation", () => {
    const text = formatChanges({
        description: "example",
        mode: "inventory-only",
        coordinateBasis: "working tree",
        inventoryComplete: true,
        files: [{ file: "C:\\repo\\a.js", status: "M", added: 1, removed: 0 }],
        candidates: [],
        resultBytes: 32,
    });
    assert.match(text, /No complete inventory is shown/);
});

test("a revision argument cannot turn into an output-writing Git option", async () => {
    const { root, run } = makeRepo();
    try {
        writeFileSync(join(root, "a.js"), numbered(5));
        run(["add", "-A"]);
        run(["commit", "-qm", "base"]);
        const out = await changes({ since: "--output=unwanted..HEAD" }, null, { cwd: root });
        assert.match(out, /Invalid revision/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PR history without a local merge-base falls back to a labelled remote inventory", async () => {
    const root = process.cwd();
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const result = await collectChanges({ pr: 7 }, {
        cwd: root,
        runGit: (args) => {
            if (args.includes("--show-toplevel")) return `${root}\n`;
            if (args.includes("HEAD^{commit}")) return `${head}\n`;
            if (args.includes(`${base}^{commit}`)) return `${base}\n`;
            if (args.includes("merge-base")) return { ok: false, code: 1, stdout: "", stderr: "" };
            assert.fail(`unexpected local Git request: ${args.join(" ")}`);
        },
        runGh: (args) => JSON.stringify(args[0] === "pr"
            ? { headRefOid: head, baseRefOid: base, title: "shallow", changedFiles: 1, url: "https://github.com/Lando-00/porthole/pull/7" }
            : [[{ filename: "source.js", status: "modified", additions: 1, deletions: 1 }]]),
    });
    assert.equal(result.mode, "inventory-only");
    assert.equal(result.inventoryComplete, true);
    assert.match(result.inventoryReason, /history is unavailable/);
});

test("a stalled untracked-file open cannot hold the change result beyond its read budget", async () => {
    let release;
    let closed = false;
    const root = process.cwd();
    const start = performance.now();
    const result = await collectChanges({ since: "uncommitted" }, {
        cwd: root,
        limits: { gitMs: 30 },
        runGit: (args) => {
            if (args.includes("--show-toplevel")) return `${root}\n`;
            if (args.includes("HEAD^{commit}")) return `${"a".repeat(40)}\n`;
            if (args.includes("ls-files")) return "late.js\0";
            if (args.includes("diff")) return "";
            assert.fail(`unexpected Git request: ${args.join(" ")}`);
        },
        fs: {
            lstat: async () => ({ size: 4, isFile: () => true }),
            open: () => new Promise((resolveOpen) => { release = resolveOpen; }),
        },
    });
    assert.ok(performance.now() - start < 1000);
    assert.equal(result.files[0].added, null);
    assert.match(result.files[0].countNote, /exceeded its budget/);
    release({
        read: () => assert.fail("expired open must not start another read"),
        close: async () => { closed = true; },
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(closed, true);
});
