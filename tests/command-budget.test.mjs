import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../extensions/porthole/lib/command.mjs";

test("command arguments remain literal data without a shell", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "a & b; $HOME"]);
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "a & b; $HOME");
});

test("a missing binary is explicit rather than empty success", async () => {
    const result = await runCommand("porthole-no-such-command-573498", []);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "spawn-failed");
});

test("stdout and stderr are bounded independently", async () => {
    for (const stream of ["stdout", "stderr"]) {
        const result = await runCommand(process.execPath, ["-e", `process.${stream}.write("x".repeat(100000))`], {
            maxStdoutBytes: 1024,
            maxStderrBytes: 1024,
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "output-limit");
        assert.ok(Buffer.byteLength(result[stream]) <= 1024);
    }
});

test("a hanging child is terminated within its scheduled budget and grace", async () => {
    const start = performance.now();
    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.ok(performance.now() - start < 2500);
});

test("an exhausted budget starts no command", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exit(1)"], { timeoutMs: 0 });
    assert.equal(result.reason, "timeout");
    assert.equal(result.stdout, "");
});
