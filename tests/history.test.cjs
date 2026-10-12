const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const history = require("../vscode-extension/src/history");
const revcontent = require("../vscode-extension/src/revcontent");

function git(cwd, args, options = {}) {
    return execFileSync("git", args, {
        cwd,
        encoding: options.encoding ?? "utf8",
        input: options.input,
        stdio: ["pipe", "pipe", "pipe"],
    }).trim();
}

function repository() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "porthole-history-")));
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Porthole Tests"]);
    git(root, ["config", "user.email", "porthole@example.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "core.autocrlf", "false"]);
    return root;
}

function write(root, relPath, contents) {
    const absolute = path.join(root, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
    return absolute;
}

function commit(root, message) {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "-m", message]);
    return git(root, ["rev-parse", "HEAD"]);
}

test("readRevisionFile distinguishes text, binary, missing data, and size limits", async () => {
    const root = repository();
    try {
        write(root, "text.txt", "hello\n");
        write(root, "binary.dat", Buffer.from([65, 0, 66]));
        const oid = commit(root, "files");

        assert.deepEqual(await history.readRevisionFile(root, oid, "text.txt"), {
            ok: true,
            text: "hello\n",
        });
        assert.equal((await history.readRevisionFile(root, oid, "binary.dat")).reason, "binary");
        assert.equal((await history.readRevisionFile(root, "f".repeat(40), "text.txt")).reason, "missing-object");
        assert.equal((await history.readRevisionFile(root, oid, "missing.txt")).reason, "missing-path");
        assert.equal(
            (await history.readRevisionFile(root, oid, "text.txt", { maxFileBytes: 3 })).reason,
            "too-large",
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("hasCommit accepts commits and refuses missing or invalid object IDs", async () => {
    const root = repository();
    try {
        write(root, "file.txt", "one\n");
        const oid = commit(root, "initial");
        assert.equal(await history.hasCommit(root, oid), true);
        assert.equal(await history.hasCommit(root, "e".repeat(40)), false);
        assert.equal(await history.hasCommit(root, "HEAD"), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("savedMatchesTarget compares filtered working files with target blobs", async () => {
    const root = repository();
    try {
        write(root, ".gitattributes", "*.txt text eol=lf\n");
        const absolute = write(root, "file.txt", "one\n");
        const oid = commit(root, "initial");
        assert.equal(await history.savedMatchesTarget(root, oid, "file.txt", absolute), true);

        write(root, "file.txt", "one\r\n");
        assert.equal(await history.savedMatchesTarget(root, oid, "file.txt", absolute), true);

        write(root, "file.txt", "changed\n");
        assert.equal(await history.savedMatchesTarget(root, oid, "file.txt", absolute), false);

        const newFile = write(root, "new.txt", "new\n");
        assert.equal(await history.savedMatchesTarget(root, oid, "new.txt", newFile), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("changedRanges reports added, modified, and deleted working-file coordinates", async () => {
    const root = repository();
    try {
        write(root, "file.txt", "one\ntwo\nthree\n");
        const base = commit(root, "initial");
        const comparison = { kind: "live", base, target: null };

        write(root, "file.txt", "one\ninserted\ntwo\nthree\n");
        assert.deepEqual((await history.changedRanges(root, comparison, "file.txt")).hunks, [{
            start: 2,
            end: 2,
            kind: "added",
            removedLines: 0,
        }]);

        write(root, "file.txt", "one\nchanged\nthree\n");
        assert.deepEqual((await history.changedRanges(root, comparison, "file.txt")).hunks, [{
            start: 2,
            end: 2,
            kind: "modified",
            removedLines: 1,
        }]);

        write(root, "file.txt", "one\nthree\n");
        assert.deepEqual((await history.changedRanges(root, comparison, "file.txt")).hunks, [{
            start: 2,
            end: 2,
            kind: "deleted",
            removedLines: 1,
        }]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("changedRanges handles whole new files and paths absent from the base", async () => {
    const root = repository();
    try {
        write(root, "tracked.txt", "tracked\n");
        const base = commit(root, "initial");
        write(root, "new.txt", "first\nsecond\n");

        assert.deepEqual(
            await history.changedRanges(
                root,
                { kind: "live", base: null, target: null },
                "new.txt",
            ),
            {
                ok: true,
                hunks: [{
                    start: 1,
                    end: 2,
                    kind: "added",
                    removedLines: 0,
                }],
            },
        );
        assert.deepEqual(
            await history.changedRanges(
                root,
                { kind: "live", base, target: null },
                "new.txt",
            ),
            {
                ok: true,
                hunks: [{
                    start: 1,
                    end: 2,
                    kind: "added",
                    removedLines: 0,
                }],
            },
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("changedRanges follows an old rename path and ignores line-ending-only changes", async () => {
    const root = repository();
    try {
        write(root, "old.txt", "one\ntwo\n");
        const base = commit(root, "initial");
        fs.renameSync(path.join(root, "old.txt"), path.join(root, "new.txt"));
        write(root, "new.txt", "one\r\nchanged\r\n");

        const renamed = await history.changedRanges(
            root,
            { kind: "revisions", base, target: base },
            "new.txt",
            "old.txt",
        );
        assert.deepEqual(renamed.hunks, [{
            start: 2,
            end: 2,
            kind: "modified",
            removedLines: 1,
        }]);

        write(root, "new.txt", "one\r\ntwo\r\n");
        assert.deepEqual(
            (await history.changedRanges(
                root,
                { kind: "revisions", base, target: base },
                "new.txt",
                "old.txt",
            )).hunks,
            [],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("changedRanges anchors an end-of-file deletion to the last remaining line", async () => {
    const root = repository();
    try {
        write(root, "file.txt", "one\ntwo\nthree\n");
        const base = commit(root, "initial");
        write(root, "file.txt", "one\ntwo\n");
        assert.deepEqual(
            (await history.changedRanges(
                root,
                { kind: "live", base, target: null },
                "file.txt",
            )).hunks,
            [{
                start: 2,
                end: 2,
                kind: "deleted",
                removedLines: 1,
            }],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("changedRanges reports a missing working file", async () => {
    const root = repository();
    try {
        write(root, "file.txt", "one\n");
        const base = commit(root, "initial");
        fs.unlinkSync(path.join(root, "file.txt"));
        assert.equal(
            (await history.changedRanges(
                root,
                { kind: "live", base, target: null },
                "file.txt",
            )).reason,
            "missing-file",
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("lastChanges groups commits and attributes unsaved buffer lines as uncommitted", async () => {
    const root = repository();
    try {
        write(root, "file.txt", "alpha\nbeta\ngamma\n");
        const first = commit(root, "initial lines");
        write(root, "file.txt", "alpha\nbeta changed\ngamma\n");
        const second = commit(root, "change middle");
        const saved = fs.readFileSync(path.join(root, "file.txt"), "utf8");

        const result = await history.lastChanges(root, "file.txt", 1, 3, saved);
        assert.equal(result.ok, true);
        assert.deepEqual(result.groups.map((group) => group.oid), [first, second]);
        assert.deepEqual(result.groups[0].finalLines, [1, 3]);
        assert.deepEqual(result.groups[1].finalLines, [2]);
        assert.equal(result.groups[0].previous, null);

        const unsaved = await history.lastChanges(
            root,
            "file.txt",
            1,
            3,
            "alpha\nbeta changed\nunsaved\n",
        );
        const uncommitted = unsaved.groups.find((group) => group.uncommitted);
        assert.deepEqual(uncommitted.finalLines, [3]);
        assert.equal(uncommitted.author, null);
        assert.equal(uncommitted.summary, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("lastChanges exposes rename ancestry and leaves root commits without previous", async () => {
    const root = repository();
    try {
        const original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
        write(root, "old.txt", original);
        const first = commit(root, "root");
        git(root, ["mv", "old.txt", "new.txt"]);
        write(root, "new.txt", original.replace("one\n", "changed\n"));
        const second = commit(root, "rename and edit");
        const contents = fs.readFileSync(path.join(root, "new.txt"), "utf8");

        const result = await history.lastChanges(root, "new.txt", 1, 2, contents);
        const changed = result.groups.find((group) => group.oid === second);
        const rootGroup = result.groups.find((group) => group.oid === first);
        assert.deepEqual(changed.previous, { oid: first, path: "old.txt" });
        assert.equal(rootGroup.previous, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("lastChanges treats an untracked path as wholly uncommitted and enforces the line cap", async () => {
    const root = repository();
    try {
        write(root, "tracked.txt", "tracked\n");
        commit(root, "initial");
        write(root, "fresh.txt", "one\ntwo\n");

        const untracked = await history.lastChanges(root, "fresh.txt", 1, 2, "one\ntwo\n");
        assert.equal(untracked.ok, true);
        assert.deepEqual(untracked.groups, [{
            oid: "0".repeat(40),
            author: null,
            time: null,
            summary: null,
            finalLines: [1, 2],
            origStart: 1,
            previous: null,
            filename: "fresh.txt",
            uncommitted: true,
        }]);

        assert.deepEqual(
            await history.lastChanges(root, "tracked.txt", 1, 2001, "tracked\n"),
            { ok: false, reason: "too-many-lines" },
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("lastChanges distinguishes a directory that is not a repository", async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "porthole-no-repo-")));
    try {
        const result = await history.lastChanges(root, "file.txt", 1, 1, "one\n");
        assert.equal(result.ok, false);
        assert.equal(result.reason, "not-repository");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("parseBlamePorcelain parses metadata once and groups repeated commits", () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const sample = [
        `${first} 10 20 1`,
        "author Ada",
        "author-mail <ada@example.invalid>",
        "author-time 100",
        "author-tz +0000",
        "committer Ada",
        "committer-mail <ada@example.invalid>",
        "committer-time 100",
        "committer-tz +0000",
        "summary First change",
        "boundary",
        "filename old name.txt",
        "\tone",
        `${second} 4 21 1`,
        "author Grace",
        "author-time 200",
        "summary Rename edit",
        `previous ${first} old name.txt`,
        "filename new name.txt",
        "\ttwo",
        `${first} 11 22`,
        "\tthree",
        "",
    ].join("\n");

    assert.deepEqual(history.parseBlamePorcelain(sample), [
        {
            oid: first,
            author: "Ada",
            time: 100000,
            summary: "First change",
            finalLines: [20, 22],
            origStart: 10,
            previous: null,
            filename: "old name.txt",
            uncommitted: false,
        },
        {
            oid: second,
            author: "Grace",
            time: 200000,
            summary: "Rename edit",
            finalLines: [21],
            origStart: 4,
            previous: { oid: first, path: "old name.txt" },
            filename: "new name.txt",
            uncommitted: false,
        },
    ]);
});

test("toRepoRelative emits POSIX paths and refuses files outside the repository", () => {
    const root = path.resolve("C:\\repo");
    assert.equal(
        history.toRepoRelative(root, path.join(root, "src", "file.js")),
        "src/file.js",
    );
    assert.equal(history.toRepoRelative(root, path.resolve("C:\\other\\file.js")), null);
});

test("revision content URIs preserve the file path and provider failures are explanatory", async () => {
    const vscode = {
        Uri: {
            from(value) {
                return value;
            },
        },
    };
    const oid = "a".repeat(40);
    const uri = revcontent.revisionUri(vscode, {
        repo: "C:\\repo",
        oid,
        path: "src/file.js",
    });
    assert.equal(uri.scheme, "porthole-rev");
    assert.equal(uri.path, "/src/file.js");
    assert.deepEqual(JSON.parse(uri.query), {
        repo: "C:\\repo",
        oid,
        path: "src/file.js",
    });

    const original = history.readRevisionFile;
    const provider = new revcontent.RevisionContentProvider();
    try {
        assert.equal(
            await provider.provideTextDocumentContent({
                query: JSON.stringify({ repo: "C:\\repo", oid: "empty", path: "src/file.js" }),
            }),
            "",
        );
        history.readRevisionFile = async () => ({ ok: false, reason: "binary" });
        assert.equal(await provider.provideTextDocumentContent(uri), "Binary file — not shown");
        history.readRevisionFile = async () => ({ ok: false, reason: "missing-object" });
        assert.equal(
            await provider.provideTextDocumentContent(uri),
            "Commit aaaaaaa is not available in this clone; fetch it to see this side.",
        );
        history.readRevisionFile = async () => ({ ok: false, reason: "missing-path" });
        assert.equal(
            await provider.provideTextDocumentContent(uri),
            "src/file.js does not exist at aaaaaaa.",
        );
        history.readRevisionFile = async () => ({ ok: false, reason: "too-large" });
        assert.equal(
            await provider.provideTextDocumentContent(uri),
            "File too large to show (over 4 MiB).",
        );
        assert.equal(
            await provider.provideTextDocumentContent({ query: "not-json" }),
            "Could not read this revision.",
        );
    } finally {
        history.readRevisionFile = original;
    }
});

test("revision content registration stores the provider disposable", () => {
    const disposable = { dispose() {} };
    let registration;
    const vscode = {
        workspace: {
            registerTextDocumentContentProvider(scheme, provider) {
                registration = { scheme, provider };
                return disposable;
            },
        },
    };
    const context = { subscriptions: [] };
    assert.equal(revcontent.register(vscode, context), disposable);
    assert.equal(registration.scheme, "porthole-rev");
    assert.ok(registration.provider instanceof revcontent.RevisionContentProvider);
    assert.deepEqual(context.subscriptions, [disposable]);
});
