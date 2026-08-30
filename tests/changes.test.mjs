import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    changes,
    formatChanges,
    isNoise,
    mergeHunks,
    numstatPath,
    parseHunks,
    resolveSpec,
} from "../extensions/porthole/lib/changes.mjs";

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
        ["+++ b/one.js", "@@ -1 +1 @@", "+++ b/two.js", "@@ -5,2 +5,2 @@"].join("\n"),
    );
    assert.deepEqual(hunks.map((h) => h.file), ["one.js", "two.js"]);
});

test("a hunk against /dev/null is skipped rather than attributed to the last file", () => {
    const hunks = parseHunks(
        ["+++ b/one.js", "@@ -1 +1 @@", "+++ /dev/null", "@@ -5,2 +0,0 @@"].join("\n"),
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

test("a renamed path in numstat reduces to the name it has now", () => {
    assert.equal(numstatPath("old.js => new.js"), "new.js");
    assert.equal(numstatPath("src/{old => new}/a.js"), "src/new/a.js");
    assert.equal(numstatPath("plain.js"), "plain.js");
});

test("the formatted output tells the model these are candidates, not a tour", () => {
    const out = formatChanges({
        description: "main...HEAD",
        auto: null,
        candidates: [{ file: "a.js", start: 1, end: 4, context: "fn", deletion: false, hunks: 1, counts: { added: 3, removed: 1 } }],
        files: ["a.js"],
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
    // realpathSync because macOS hands out a symlinked temp dir and git reports
    // the resolved one, which would make every path comparison here disagree.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "porthole-changes-")));
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
        assert.match(out, /^a\.js\s+\(\+1 -1\)$/m);
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

        const out = await inRepo(root, () => changes({}));
        assert.match(out, /Deleted, so they cannot be walked: gone\.js/);

        const candidateSection = out.split("Deleted, so they")[0];
        assert.doesNotMatch(candidateSection, /gone\.js/);
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
        assert.match(out, /1-80\s+new file, 30[01] lines - pick sub-ranges/);
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

        const out = await inRepo(root, () => changes({}));
        assert.match(out, /2 file\(s\) skipped as generated or binary/);
        assert.doesNotMatch(out, /package-lock/);

        const all = await inRepo(root, () => changes({ includeAll: true }));
        assert.match(all, /package-lock\.json/);
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), "porthole-norepo-")));
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

test("a pull request that is not checked out is refused, with no steps offered", async () => {
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
                });
            }
            return "src/theirs.js";
        };

        const out = await inRepo(root, () => changes({ pr: 42 }, null, { runGh }));
        assert.match(out, /is not checked out here/);
        assert.match(out, /gh pr checkout 42/);
        assert.doesNotMatch(
            out,
            /candidate steps, not a tour/,
            `a refused PR must offer no steps at all:\n${out}`,
        );
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
            JSON.stringify({ headRefOid: head, headRefName: "feature", baseRefName: "main", title: "Mine" });

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
        assert.match(out, /GitHub CLI \(gh\) is not available/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// --- spec resolution ---------------------------------------------------------

test("resolveSpec prefers the merge-base for a branch and a plain range for a commit", () => {
    const run = (args) => {
        const joined = args.join(" ");
        if (joined.includes("status --porcelain")) return "";
        if (joined.includes("refs/heads/main")) return "abc";
        if (joined.includes("refs/heads/")) return null;
        if (joined.includes("refs/remotes/")) return null;
        if (joined.includes("^{commit}")) return "abc";
        return "";
    };

    assert.deepEqual(resolveSpec({ since: "main" }, run).spec, ["main...HEAD"]);
    assert.deepEqual(resolveSpec({ since: "abc123" }, run).spec, ["abc123..HEAD"]);
    assert.deepEqual(resolveSpec({ since: "a..b" }, run).spec, ["a..b"]);
    assert.deepEqual(resolveSpec({ since: "staged" }, run).spec, ["--cached"]);
});
