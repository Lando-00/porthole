// Runs read-only Git commands without letting one request monopolize the companion.

const { spawn: spawnProcess } = require("node:child_process");

const GIT_CONCURRENCY = 4;
const STDERR_LIMIT = 16 * 1024;
// A child that ignores termination keeps its slot this long at most, so one
// unkillable process cannot wedge every later git call.
const SLOT_RELEASE_CEILING_MS = 10_000;
const queue = [];
let active = 0;

function failure(reason, error, stdout = [], stderr = [], code) {
    return {
        ok: false,
        reason,
        ...(code === undefined ? {} : { code }),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stdoutBuffer: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error,
    };
}

function killOwnedTree(child, spawn = spawnProcess) {
    if (!child || child.exitCode !== null) return;
    const fallback = () => {
        try {
            child.kill("SIGKILL");
        } catch {
            // Already gone.
        }
    };
    if (process.platform === "win32" && child.pid) {
        let killer;
        try {
            killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                shell: false,
                windowsHide: true,
                stdio: "ignore",
            });
        } catch {
            fallback();
            return;
        }
        killer.on("error", fallback);
        killer.on("exit", (code) => {
            if (code !== 0) fallback();
        });
        killer.unref?.();
        return;
    }
    fallback();
}

function execute(args, options, timeoutMs) {
    const spawn = options.spawn || spawnProcess;
    const maxStdoutBytes = Number.isFinite(options.maxStdoutBytes)
        ? Math.max(0, Math.floor(options.maxStdoutBytes))
        : 4 * 1024 * 1024;
    let markExited;
    const exited = new Promise((resolve) => {
        markExited = resolve;
    });

    const result = new Promise((resolve) => {
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let child;
        let resultReason = null;
        let resultError = null;
        let settled = false;
        let timer;
        let killTimer;

        const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            const stdoutBuffer = Buffer.concat(stdout);
            const stderrText = Buffer.concat(stderr).toString("utf8");
            if (resultReason) {
                resolve({
                    ok: false,
                    reason: resultReason,
                    ...(code === undefined || code === null ? {} : { code }),
                    stdout: stdoutBuffer.toString("utf8"),
                    stdoutBuffer,
                    stderr: stderrText,
                    error: resultError,
                });
                return;
            }
            if (code === 0) {
                resolve({
                    ok: true,
                    code: 0,
                    stdout: stdoutBuffer.toString("utf8"),
                    stdoutBuffer,
                    stderr: stderrText,
                });
                return;
            }
            resolve({
                ok: false,
                reason: "command-failed",
                ...(code === undefined || code === null ? {} : { code }),
                stdout: stdoutBuffer.toString("utf8"),
                stdoutBuffer,
                stderr: stderrText,
                error: `git exited with ${code ?? signal ?? "no result"}`,
            });
        };

        const stop = (reason, error) => {
            if (settled || resultReason) return;
            resultReason = reason;
            resultError = error;
            killOwnedTree(child, options.killSpawn);
            killTimer = setTimeout(() => {
                child?.stdin?.destroy();
                child?.stdout?.destroy();
                child?.stderr?.destroy();
                finish(null, "terminated");
            }, 200);
        };

        try {
            child = spawn("git", [
                "--no-pager",
                "-c",
                "core.quotePath=false",
                ...args,
            ], {
                cwd: options.cwd,
                shell: false,
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    GIT_OPTIONAL_LOCKS: "0",
                    GIT_TERMINAL_PROMPT: "0",
                    GIT_PAGER: "cat",
                },
            });
        } catch (error) {
            markExited();
            resolve(failure("spawn", error.message));
            return;
        }

        child.on("exit", () => markExited());
        child.on("error", (error) => {
            markExited();
            if (settled) return;
            resultReason = "spawn";
            resultError = `${error.code || "spawn"}: ${error.message}`;
            finish(undefined, undefined);
        });
        child.stdout.on("data", (chunk) => {
            if (settled || resultReason) return;
            const bytes = Buffer.from(chunk);
            const remaining = Math.max(0, maxStdoutBytes - stdoutBytes);
            if (remaining > 0) stdout.push(bytes.subarray(0, remaining));
            stdoutBytes += bytes.length;
            if (stdoutBytes > maxStdoutBytes) {
                stop("output-limit", `git stdout exceeded ${maxStdoutBytes} bytes`);
            }
        });
        child.stderr.on("data", (chunk) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            const remaining = Math.max(0, STDERR_LIMIT - stderrBytes);
            if (remaining > 0) stderr.push(bytes.subarray(0, remaining));
            stderrBytes += bytes.length;
        });
        child.on("close", (code, signal) => {
            markExited();
            finish(code, signal);
        });
        child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE") stop("command-failed", error.message);
        });

        timer = setTimeout(
            () => stop("timeout", `git exceeded its ${Math.floor(timeoutMs)}ms budget`),
            Math.max(1, Math.floor(timeoutMs)),
        );
        if (options.stdin === undefined) {
            child.stdin.end();
        } else {
            child.stdin.end(options.stdin);
        }
    });
    return { result, exited };
}

function pump() {
    while (active < GIT_CONCURRENCY && queue.length > 0) {
        const request = queue.shift();
        if (request.settled) continue;
        clearTimeout(request.queueTimer);
        const remaining = request.deadline - Date.now();
        if (remaining <= 0) {
            request.settled = true;
            request.resolve(failure("timeout", "git timed out while waiting to start"));
            continue;
        }
        active += 1;
        const run = execute(request.args, request.options, remaining);
        run.result.then((result) => {
            request.settled = true;
            request.resolve(result);
        });
        // The slot is released when the process has exited, not when the
        // caller has its answer: a timed-out child may still be running.
        let ceiling;
        const released = new Promise((resolve) => {
            ceiling = setTimeout(resolve, SLOT_RELEASE_CEILING_MS);
            ceiling.unref?.();
        });
        Promise.race([run.exited, released]).then(() => {
            clearTimeout(ceiling);
            active -= 1;
            pump();
        });
    }
}

function runGit(args, options = {}) {
    const timeoutMs = options.timeoutMs === undefined ? 5000 : Math.floor(options.timeoutMs);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        return Promise.resolve(failure("spawn", "git arguments must be strings"));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.resolve(failure("timeout", "git command budget exhausted"));
    }

    return new Promise((resolve) => {
        const request = {
            args,
            options,
            resolve,
            deadline: Date.now() + timeoutMs,
            settled: false,
            queueTimer: null,
        };
        request.queueTimer = setTimeout(() => {
            if (request.settled) return;
            const index = queue.indexOf(request);
            if (index >= 0) queue.splice(index, 1);
            request.settled = true;
            resolve(failure("timeout", "git timed out while waiting to start"));
        }, timeoutMs);
        queue.push(request);
        pump();
    });
}

function resetLimiterForTests() {
    for (const request of queue.splice(0)) {
        clearTimeout(request.queueTimer);
        if (!request.settled) {
            request.settled = true;
            request.resolve(failure("timeout", "git limiter reset"));
        }
    }
    active = 0;
}

module.exports = {
    runGit,
    GIT_CONCURRENCY,
    killOwnedTree,
    resetLimiterForTests,
};
