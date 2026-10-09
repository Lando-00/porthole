// The wait for a companion's reply.
//
// These pin the timing behaviour of callCompanion's ack loop, which is watched
// and polled rather than spun on a fixed interval. The rule being protected is
// that an acknowledgment sitting on disk is evidence the companion did the
// work, so it is always reported - reporting a timeout for an operation that
// visibly completed would be a lie, and the honest answer is the whole reason
// the ack protocol exists.

import assert from "node:assert/strict";
import test from "node:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    watch,
    writeFileSync,
} from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";

const WINDOW_ID = "abcdef0123456789";
const SESSION_ID = "wait-test-session";

let home;
let inboxDir;
let ackDir;
let callCompanion;

test.before(async () => {
    home = mkdtempSync(join(tmpdir(), "porthole-wait-"));
    process.env.COPILOT_HOME = home;

    inboxDir = join(home, "porthole", "inbox", WINDOW_ID);
    ackDir = join(tmpdir(), "porthole", "ack");
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(ackDir, { recursive: true });

    writeFileSync(
        join(home, "porthole", `companion-${process.pid}.json`),
        JSON.stringify({
            pid: process.pid, // a live pid: this process
            windowId: WINDOW_ID,
            appName: "Visual Studio Code",
            uriScheme: "vscode",
            sessionId: SESSION_ID,
            sessionFolder: join(home, "session-state", SESSION_ID),
            workspaceFolders: [],
            version: "1.0.0",
            protocol: 1,
            capabilities: ["transport:addressed-inbox", "route:reveal"],
            tmpdir: tmpdir(),
            copilotHome: home,
            updatedAt: new Date().toISOString(),
        }),
        "utf8",
    );

    ({ callCompanion } = await import("../extensions/porthole/lib/companion.mjs"));
});

test.after(() => {
    rmSync(home, { recursive: true, force: true });
});

/** Answers whatever turns up in the inbox, optionally stalling afterwards. */
function respondOnce({ stallMs = 0 } = {}) {
    let stopped = false;

    const answer = () => {
        if (stopped) return;
        for (const entry of readdirSync(inboxDir)) {
            if (!entry.endsWith(".json")) continue;
            const requestId = entry.slice(0, -".json".length);
            try {
                rmSync(join(inboxDir, entry), { force: true });
            } catch {
                continue;
            }
            const file = join(ackDir, `${requestId}.json`);
            writeFileSync(`${file}.tmp`, JSON.stringify({ ok: true, applied: 1 }), "utf8");
            renameSync(`${file}.tmp`, file);

            if (stallMs > 0) {
                // Deliberately synchronous: this freezes the waiter's own event
                // loop, which is the only way an ack can land and then be looked
                // at from beyond its deadline.
                const until = Date.now() + stallMs;
                while (Date.now() < until) {
                    /* block */
                }
            }
            return;
        }
    };

    // Called straight from the watcher rather than through a timer, so that
    // closing the watcher cannot leave a queued callback behind to answer the
    // *next* test's request.
    const watcher = watch(inboxDir, { persistent: false }, answer);
    const sweep = setInterval(answer, 5);
    return () => {
        stopped = true;
        watcher.close();
        clearInterval(sweep);
    };
}

const options = { sessionId: SESSION_ID };

test("a reply is delivered through the addressed inbox", async () => {
    const stop = respondOnce();
    try {
        const result = await callCompanion("reveal", { file: "x" }, { ...options, timeoutMs: 4000 });
        assert.equal(result.ok, true);
        assert.equal(result.applied, 1);
        assert.equal(result.deliveryMode, "legacy-single-shot");
    } finally {
        stop();
    }
});

test("an ack already on disk is reported, not called a timeout", async () => {
    // The companion answers, then jams the event loop well past the deadline.
    // The old fixed-interval loop re-tested the clock before looking at the
    // directory, so it reported a timeout for work that had demonstrably been
    // done - and left the ack behind to prove it.
    const stop = respondOnce({ stallMs: 400 });
    try {
        const result = await callCompanion("reveal", { file: "x" }, { ...options, timeoutMs: 120 });
        assert.equal(result.ok, true, "an acknowledged request must never be reported as a timeout");
    } finally {
        stop();
    }
});

test("silence is reported as unconfirmed within its budget", async () => {
    const started = Date.now();
    const result = await callCompanion("reveal", { file: "x" }, { ...options, timeoutMs: 300 });
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfirmed");
    assert.equal(result.mayHaveExecuted, true);
    assert.ok(elapsed >= 300, `waited ${elapsed}ms, which is less than the 300ms budget`);
    assert.ok(elapsed < 3000, `waited ${elapsed}ms, far beyond the 300ms budget`);

    // The unanswered request must not be left addressed to the window.
    assert.deepEqual(
        readdirSync(inboxDir).filter((f) => f.endsWith(".json")),
        [],
        "a timed-out request should be withdrawn from the inbox",
    );
});

test("a zero timeout still checks once and does not hang", async () => {
    const started = Date.now();
    const result = await callCompanion("reveal", { file: "x" }, { ...options, timeoutMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfirmed");
    assert.ok(Date.now() - started < 2000, "a zero timeout must return promptly");
});

test("a presence file written before this boot is not trusted", async () => {
    // A hard power-off leaves the heartbeat behind. After a reboot its pid may
    // belong to an unrelated process, and probing one we do not own answers
    // EPERM - which is deliberately read as "alive". The stale record then
    // never expired, so reopening the same session produced two apparent owners
    // and every route refused as ambiguous, permanently.
    const home = mkdtempSync(join(tmpdir(), "porthole-boot-"));
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    mkdirSync(join(home, "porthole"), { recursive: true });

    const stale = join(home, "porthole", "companion-4242.json");
    const bootedAt = Date.now() - uptime() * 1000;
    writeFileSync(
        stale,
        JSON.stringify({
            pid: process.pid, // a pid that is definitely alive right now
            windowId: "00000000deadbeef",
            appName: "Code",
            sessionId: "old-session",
            workspaceFolders: [],
            // ...but the record predates this boot, so it cannot be ours.
            updatedAt: new Date(bootedAt - 60 * 60 * 1000).toISOString(),
        }),
        "utf8",
    );

    const { findCompanions } = await import(
        `../extensions/porthole/lib/companion.mjs?boot=${Math.random()}`
    );
    const found = findCompanions();

    assert.equal(found.length, 0, "a pre-boot heartbeat must not count as a live window");
    assert.equal(existsSync(stale), false, "and it must be pruned, not left to mislead forever");

    if (previous === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
});
