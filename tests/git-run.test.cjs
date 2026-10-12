const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
    runGit,
    GIT_CONCURRENCY,
    resetLimiterForTests,
} = require("../vscode-extension/src/gitrun");

function repository() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "porthole-git-run-")));
    require("node:child_process").execFileSync("git", ["init", "--quiet"], { cwd: root });
    require("node:child_process").execFileSync("git", ["config", "user.name", "Porthole Tests"], { cwd: root });
    require("node:child_process").execFileSync("git", ["config", "user.email", "porthole@example.invalid"], { cwd: root });
    require("node:child_process").execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    return root;
}

function fakeChild(onStart) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
        if (child.exitCode !== null) return;
        child.killed = true;
        child.exitCode = 1;
        setImmediate(() => child.emit("close", null, "SIGKILL"));
    };
    setImmediate(() => onStart(child));
    return child;
}

test.afterEach(() => {
    resetLimiterForTests();
});

test("runGit returns stdout for a successful command", async () => {
    const root = repository();
    try {
        const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root });
        assert.equal(result.ok, true);
        assert.equal(result.code, 0);
        assert.equal(result.stdout.trim(), "true");
        assert.ok(Buffer.isBuffer(result.stdoutBuffer));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("runGit reports a command failure with its exit code", async () => {
    const root = repository();
    try {
        const result = await runGit(["rev-parse", "--verify", "not-a-real-ref"], { cwd: root });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "command-failed");
        assert.notEqual(result.code, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("runGit times out and kills its owned child", async () => {
    let child;
    const result = await runGit(["status"], {
        timeoutMs: 20,
        spawn: () => {
            child = fakeChild(() => {});
            return child;
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.equal(child.killed, true);
});

test("runGit caps stdout and reports output-limit", async () => {
    const result = await runGit(["status"], {
        maxStdoutBytes: 4,
        spawn: () => fakeChild((child) => {
            child.stdout.write("12345");
        }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "output-limit");
    assert.equal(result.stdout, "1234");
});

test("runGit delivers stdin to Git", async () => {
    const root = repository();
    try {
        const expected = require("node:child_process").execFileSync(
            "git",
            ["hash-object", "--stdin"],
            { cwd: root, input: "hello\n", encoding: "utf8" },
        ).trim();
        const result = await runGit(["hash-object", "--stdin"], {
            cwd: root,
            stdin: Buffer.from("hello\n"),
        });
        assert.equal(result.ok, true);
        assert.equal(result.stdout.trim(), expected);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("runGit reports an asynchronous spawn failure", async () => {
    const result = await runGit(["status"], {
        spawn: () => {
            const child = fakeChild(() => {
                const error = new Error("missing git");
                error.code = "ENOENT";
                child.emit("error", error);
            });
            return child;
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "spawn");
    assert.match(result.error, /ENOENT/);
});

test("runGit admits no more than four children at once", async () => {
    let live = 0;
    let peak = 0;
    const spawn = () => fakeChild((child) => {
        live += 1;
        peak = Math.max(peak, live);
        setTimeout(() => {
            live -= 1;
            child.exitCode = 0;
            child.emit("close", 0, null);
        }, 15);
    });

    const results = await Promise.all(
        Array.from({ length: 12 }, () => runGit(["status"], { spawn, timeoutMs: 1000 })),
    );
    assert.equal(GIT_CONCURRENCY, 4);
    assert.equal(peak, 4);
    assert.ok(results.every((result) => result.ok));
});

test("a queued call that exhausts its timeout never spawns", async () => {
    const blockers = [];
    let calls = 0;
    const spawn = () => {
        calls += 1;
        const child = fakeChild(() => {});
        blockers.push(child);
        return child;
    };
    const running = Array.from(
        { length: GIT_CONCURRENCY },
        () => runGit(["status"], { spawn, timeoutMs: 1000 }),
    );
    const queued = await runGit(["status"], { spawn, timeoutMs: 20 });
    assert.equal(queued.reason, "timeout");
    assert.equal(calls, GIT_CONCURRENCY);

    for (const child of blockers) {
        child.exitCode = 0;
        child.emit("close", 0, null);
    }
    assert.ok((await Promise.all(running)).every((result) => result.ok));
});

test("a taskkill that exits unsuccessfully falls back to killing the child", { skip: process.platform !== "win32" }, async () => {
    const { killOwnedTree } = require("../vscode-extension/src/gitrun");
    let killed = 0;
    const child = { pid: 4242, exitCode: null, kill: () => { killed += 1; } };
    const killer = new EventEmitter();
    killOwnedTree(child, () => killer);
    killer.emit("exit", 128);
    assert.equal(killed, 1);
    killer.emit("exit", 0);
    assert.equal(killed, 1);
});

test("a timed-out child that ignores termination keeps its slot until it exits", async () => {
    const stubborn = [];
    const spawn = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.exitCode = null;
        child.kill = () => {};
        stubborn.push(child);
        return child;
    };
    const timedOut = await Promise.all(
        Array.from({ length: GIT_CONCURRENCY }, () => runGit(["status"], { timeoutMs: 20, spawn, killSpawn: () => {
            const killer = new EventEmitter();
            setImmediate(() => killer.emit("exit", 1));
            return killer;
        } })),
    );
    assert.ok(timedOut.every((result) => result.reason === "timeout"));
    const queued = runGit(["status"], { timeoutMs: 3000, spawn });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stubborn.length, GIT_CONCURRENCY, "no fifth child while four are still alive");
    stubborn[0].exitCode = 1;
    stubborn[0].emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stubborn.length, GIT_CONCURRENCY + 1);
    stubborn.at(-1).emit("close", 0, null);
    assert.equal((await queued).ok, true);
    for (const child of stubborn) child.emit("exit", 1, null);
});
