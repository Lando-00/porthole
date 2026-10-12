const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vscode-extension", "src");
const REPO_MODULE = path.join(SRC, "repo.js");

function runGit(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function initialiseRepository(root) {
    fs.mkdirSync(root, { recursive: true });
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Porthole Tests"]);
    runGit(root, ["config", "user.email", "porthole@example.invalid"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(root, "file.txt"), "one\n", "utf8");
    runGit(root, ["add", "file.txt"]);
    runGit(root, ["commit", "--quiet", "-m", "initial"]);
}

function loadRepoModule() {
    const mocks = new Map([
        ["vscode", { workspace: { workspaceFolders: [] } }],
        [path.join(SRC, "session.js"), { sessionRoot: () => "C:\\sessions" }],
    ]);
    const originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
        if (mocks.has(request)) return mocks.get(request);
        let resolved;
        try {
            resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
            resolved = null;
        }
        if (resolved && mocks.has(resolved)) return mocks.get(resolved);
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[REPO_MODULE];
    try {
        return require(REPO_MODULE);
    } finally {
        Module._load = originalLoad;
    }
}

test("Tour revision lookup returns full commits for packed refs and linked worktrees", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-commit-"));
    const repository = path.join(root, "repository");
    const linked = path.join(root, "linked");
    const repo = loadRepoModule();

    try {
        initialiseRepository(repository);
        const expected = runGit(repository, ["rev-parse", "HEAD"]);
        runGit(repository, ["pack-refs", "--all", "--prune"]);

        const packed = await repo.gitRevision(repository);
        assert.equal(packed.commit, expected);
        assert.equal(packed.commit.length, 40);
        assert.equal(packed.branch, runGit(repository, ["rev-parse", "--abbrev-ref", "HEAD"]));

        runGit(repository, ["checkout", "--quiet", "--detach", expected]);
        const detached = await repo.gitRevision(repository);
        assert.equal(detached.commit, expected);
        assert.equal(detached.branch, null);

        runGit(repository, ["worktree", "add", "--quiet", "-b", "linked-tour-test", linked]);
        const worktree = await repo.gitRevision(linked);
        assert.equal(worktree.commit, expected);
        assert.equal(worktree.branch, "linked-tour-test");
        assert.equal(worktree.repo, path.resolve(linked));

        const missing = await repo.gitRevision(path.join(root, "not-a-repository"));
        assert.deepEqual(missing, {
            repo: path.resolve(root, "not-a-repository"),
            branch: null,
            commit: null,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Tour revision lookup accepts a junction or symlink to the repository root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-tour-alias-"));
    const repository = path.join(root, "repository");
    const alias = path.join(root, "alias");
    const repo = loadRepoModule();

    try {
        initialiseRepository(repository);
        const expected = runGit(repository, ["rev-parse", "HEAD"]);
        fs.symlinkSync(repository, alias, process.platform === "win32" ? "junction" : "dir");

        const aliased = await repo.gitRevision(alias);
        assert.equal(aliased.commit, expected);
        assert.equal(aliased.repo, path.resolve(alias));
        assert.equal(repo.sameRepository(alias, repository), true);

        fs.mkdirSync(path.join(repository, "nested"));
        assert.equal((await repo.gitRevision(path.join(alias, "nested"))).commit, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Tour revision batches coalesce repositories and share a bounded lookup window", async () => {
    const repo = loadRepoModule();
    const calls = [];
    const commit = "a".repeat(40);
    const fakeExec = (_command, args, _options, callback) => {
        calls.push(args[1]);
        setImmediate(() => callback(null, `${args[1]}\n${commit}\nmain\n`));
        return { kill() {} };
    };

    const first = path.resolve("C:\\repo-a");
    const second = path.resolve("C:\\repo-b");
    const revisions = await repo.gitRevisions(
        [first, first, second],
        { timeoutMs: 100, execFile: fakeExec },
    );

    assert.equal(calls.length, 2);
    assert.equal(revisions.get(first).commit, commit);
    assert.equal(revisions.get(second).commit, commit);
    assert.equal(
        repo.revisionState({ commit }, revisions.get(first)),
        "same-revision",
    );
    assert.equal(
        repo.revisionState({ commit: "b".repeat(40) }, revisions.get(first)),
        "revision-changed",
    );
    assert.equal(repo.revisionState({ commit: null }, revisions.get(first)), "unknown");
});

test("a hung Tour revision lookup resolves as unknown within its budget", async () => {
    const repo = loadRepoModule();
    let killed = false;
    const started = Date.now();
    const result = await repo.gitRevision("C:\\repo", {
        timeoutMs: 30,
        execFile: () => ({
            kill() {
                killed = true;
            },
        }),
    });

    assert.equal(killed, true);
    assert.equal(result.commit, null);
    assert.ok(Date.now() - started < 500, "lookup should not outlive its small budget");
});

test("an exhausted revision budget starts no child", async () => {
    const repo = loadRepoModule();
    const exec = () => assert.fail("exhausted allowance started Git");
    for (const timeoutMs of [0, -1]) {
        assert.equal((await repo.gitRevision("C:\\repo", { timeoutMs, execFile: exec })).commit, null);
        const result = await repo.gitRevisions(["C:\\repo"], { timeoutMs, execFile: exec });
        assert.equal([...result.values()][0].commit, null);
    }
});

test("revision lookup refuses a different repository root even when HEAD resolves", async () => {
    const repo = loadRepoModule();
    const result = await repo.gitRevision("C:\\repo", {
        execFile: (_command, _args, _options, callback) => {
            setImmediate(() => callback(null, `${path.resolve("C:\\other")}\n${"a".repeat(40)}\nmain\n`));
            return { kill() {} };
        },
    });
    assert.equal(result.commit, null);
});

test("revision batches cap simultaneous Git children and stop admission at the deadline", async () => {
    const repo = loadRepoModule();
    let at = 0;
    let active = 0;
    let peak = 0;
    let calls = 0;
    const paths = Array.from({ length: 20 }, (_, i) => path.resolve(`repo-${i}`));
    const results = await repo.gitRevisions(paths, {
        timeoutMs: 100,
        now: () => at,
        execFile: (_command, args, _options, callback) => {
            calls += 1;
            active += 1;
            peak = Math.max(peak, active);
            setImmediate(() => {
                at = 100;
                active -= 1;
                callback(null, `${args[1]}\n${"a".repeat(40)}\nmain\n`);
            });
            return { kill() {} };
        },
    });
    assert.equal(peak, 4);
    assert.equal(calls, 4);
    assert.equal([...results.values()].filter((value) => value.commit !== null).length, 4);
    assert.equal(results.size, 20);
});
