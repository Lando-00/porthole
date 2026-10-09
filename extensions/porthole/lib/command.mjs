import { spawn } from "node:child_process";

/** A bounded, non-interactive child process. Failure never looks like empty output. */
export function runCommand(command, args, {
    cwd,
    timeoutMs = 3000,
    maxStdoutBytes = 4 * 1024 * 1024,
    maxStderrBytes = 16 * 1024,
    input = "",
    env = {},
} = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.resolve({ ok: false, reason: "timeout", stdout: "", stderr: "", error: "command budget exhausted" });
    }
    if (typeof command !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        return Promise.resolve({ ok: false, reason: "invalid-command", stdout: "", stderr: "", error: "command arguments must be strings" });
    }

    return new Promise((resolve) => {
        let child;
        let ended = false;
        let failure = null;
        let timer = null;
        let killTimer = null;
        const stdout = [];
        const stderr = [];
        let outBytes = 0;
        let errBytes = 0;

        const finish = (code, signal) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            resolve({
                ok: !failure && code === 0,
                reason: failure?.reason || (code === 0 ? null : "command-failed"),
                error: failure?.error || (code === 0 ? undefined : `${command} exited with ${code ?? signal ?? "no result"}`),
                code,
                signal,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
            });
        };

        const stop = (reason, error) => {
            if (ended || failure) return;
            failure = { reason, error };
            if (child?.pid && child.exitCode === null) {
                if (process.platform === "win32") {
                    // Kill only this owned process tree, never an executable name.
                    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                        windowsHide: true,
                        stdio: "ignore",
                    });
                    killer.on("error", () => child.kill());
                    killer.unref();
                } else {
                    child.kill("SIGTERM");
                }
            }
            killTimer = setTimeout(() => {
                if (child?.exitCode === null) child.kill("SIGKILL");
                child?.stdin?.destroy();
                child?.stdout?.destroy();
                child?.stderr?.destroy();
                finish(null, "terminated");
            }, 200);
        };

        try {
            child = spawn(command, args, {
                cwd,
                shell: false,
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    GIT_OPTIONAL_LOCKS: "0",
                    GIT_TERMINAL_PROMPT: "0",
                    GH_PROMPT_DISABLED: "1",
                    ...env,
                },
            });
        } catch (error) {
            failure = { reason: "spawn-failed", error: error.message };
            finish(null, null);
            return;
        }

        child.on("error", (error) => {
            failure ||= { reason: "spawn-failed", error: `${error.code || "spawn"}: ${error.message}` };
            finish(null, null);
        });
        child.stdout.on("data", (chunk) => {
            if (ended || failure) return;
            const bytes = Buffer.from(chunk);
            const remaining = Math.max(0, maxStdoutBytes - outBytes);
            stdout.push(bytes.subarray(0, remaining));
            outBytes += bytes.length;
            if (outBytes > maxStdoutBytes) stop("output-limit", `${command} stdout exceeded ${maxStdoutBytes} bytes`);
        });
        child.stderr.on("data", (chunk) => {
            if (ended || failure) return;
            const bytes = Buffer.from(chunk);
            const remaining = Math.max(0, maxStderrBytes - errBytes);
            stderr.push(bytes.subarray(0, remaining));
            errBytes += bytes.length;
            if (errBytes > maxStderrBytes) stop("output-limit", `${command} stderr exceeded ${maxStderrBytes} bytes`);
        });
        child.on("close", finish);
        child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE") stop("input-failed", error.message);
        });
        timer = setTimeout(() => stop("timeout", `${command} exceeded its ${timeoutMs}ms budget`), timeoutMs);
        child.stdin.end(input);
    });
}
