// The reverse channel's delivery worker.
//
// Only one delivery pass runs at a time, so the thing worth protecting is that
// a single message can never take the worker down with it. A send that hangs
// must be given up on and acked, not left holding the pass open while every
// later selection the user sends goes unclaimed and unanswered.

import assert from "node:assert/strict";
import test from "node:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let outbox;
let outDir;
let ackDir;

test.before(async () => {
    home = mkdtempSync(join(tmpdir(), "porthole-outbox-"));
    process.env.COPILOT_HOME = home;
    mkdirSync(join(home, "porthole"), { recursive: true });

    outbox = await import("../extensions/porthole/lib/outbox.mjs");
    const { endpointId } = await import("../extensions/porthole/lib/endpoint.mjs");

    outDir = join(home, "porthole", "outbox", endpointId());
    ackDir = join(home, "porthole", "outbox-ack");
    mkdirSync(outDir, { recursive: true });
});

test.after(() => {
    outbox.stop();
    rmSync(home, { recursive: true, force: true });
});

function put(messageId, endpointId) {
    const file = join(outDir, `${messageId}.json`);
    writeFileSync(
        `${file}.tmp`,
        JSON.stringify({
            messageId,
            endpointId,
            file: "a.js",
            startLine: 1,
            endLine: 1,
            selection: "const x = 1;",
            sentAt: new Date().toISOString(),
        }),
        "utf8",
    );
    renameSync(`${file}.tmp`, file);
}

async function ackFor(messageId, timeoutMs = 4000) {
    const file = join(ackDir, `${messageId}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(file)) {
            try {
                return JSON.parse(readFileSync(file, "utf8"));
            } catch {
                // half-written
            }
        }
        await new Promise((r) => setTimeout(r, 10));
    }
    return null;
}

test("a send that never settles is given up on, and does not wedge the worker", async () => {
    const { endpointId } = await import("../extensions/porthole/lib/endpoint.mjs");
    const seen = [];

    outbox.start(null, {
        // The first message hangs forever; later ones resolve normally.
        send: (payload) => {
            seen.push(payload.prompt);
            return seen.length === 1 ? new Promise(() => {}) : Promise.resolve(true);
        },
        log: async () => {},
        sendTimeoutMs: 150,
        intervalMs: 50,
    });

    put("hangs", endpointId());
    const first = await ackFor("hangs");
    assert.ok(first, "the hung message must still be acknowledged");
    assert.equal(
        first.status,
        "unconfirmed",
        "a send that never settled is 'may or may not have arrived', not a success",
    );

    // The worker must still be alive for everything that comes after it.
    put("after", endpointId());
    const second = await ackFor("after");
    assert.ok(second, "a later message must still be delivered after a hung send");
    assert.equal(second.status, "accepted");

    // At-most-once: the hung message was handed to send exactly once.
    assert.equal(
        seen.filter((p) => p.includes("const x = 1;")).length,
        2,
        "each message is sent once - two messages, two sends, no retry of the hung one",
    );

    outbox.stop();
});

test("stop() releases the worker even while a send is still hanging", async () => {
    const { endpointId } = await import("../extensions/porthole/lib/endpoint.mjs");

    outbox.start(null, {
        send: () => new Promise(() => {}),
        log: async () => {},
        sendTimeoutMs: 5000, // long enough that only stop() can free the pass
        intervalMs: 50,
    });
    put("stuck", endpointId());
    await new Promise((r) => setTimeout(r, 200));
    outbox.stop();

    // A fresh start must get a working worker rather than inherit the stuck one.
    outbox.start(null, {
        send: async () => true,
        log: async () => {},
        sendTimeoutMs: 1000,
        intervalMs: 50,
    });
    put("fresh", endpointId());
    const ack = await ackFor("fresh");
    assert.ok(ack, "a restarted outbox must deliver again");
    assert.equal(ack.status, "accepted");

    outbox.stop();
});
