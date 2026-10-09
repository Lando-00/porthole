const assert = require("node:assert/strict");
const test = require("node:test");

const {
    COMPLETED_GRACE_MS,
    MAX_OPERATION_LIFETIME_MS,
    createOperationHost,
} = require("../vscode-extension/src/operations");

const WINDOW_ID = "1234567890abcdef";
const STARTED_AT = "2026-09-12T08:00:00.000Z";
const SESSION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_FOLDER =
    "C:\\Users\\test\\.copilot\\session-state\\aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function operation(now, overrides = {}) {
    return {
        version: 1,
        id: `operation-${now}`,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
        sessionId: SESSION_ID,
        sessionFolder: SESSION_FOLDER,
        targetWindowId: WINDOW_ID,
        targetStartedAt: STARTED_AT,
        admission: "owned",
        ...overrides,
    };
}

function request(requestId, logicalOperation, payload = { value: 1 }) {
    return {
        requestId,
        operation: logicalOperation,
        route: "annotate",
        payload,
    };
}

test("non-string wire identifiers are rejected without executing or throwing", async () => {
    const now = Date.parse("2026-09-12T08:05:00.000Z");
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => assert.fail("invalid identity was executed"),
    });
    const invalid = [
        request(123, operation(now)),
        request("attempt-id", operation(now, { id: 123 })),
        request("attempt-session", operation(now, { sessionId: 123, sessionFolder: "C:\\sessions\\123" })),
        request("attempt-window", operation(now, { targetWindowId: 1234567890123456 })),
    ];
    for (const value of invalid) {
        const result = await host.submit(value);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-operation");
    }
    assert.equal(host.stats().records, 0);
});

test("special JSON property names remain part of operation identity", async () => {
    const now = Date.parse("2026-09-12T08:05:00.000Z");
    let executed = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => ({ ok: true, value: ++executed }),
    });
    const logical = operation(now);
    const first = await host.submit(request("first", logical, JSON.parse('{"__proto__":{"value":1}}')));
    const second = await host.submit(request("second", logical, JSON.parse('{"__proto__":{"value":2}}')));
    assert.equal(first.ok, true);
    assert.equal(second.reason, "operation-conflict");
    assert.equal(executed, 1);
});

test("a reply consumer cannot mutate the retained replay result", async () => {
    const now = Date.parse("2026-09-12T08:05:00.000Z");
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => ({ ok: true, result: { value: 1 } }),
    });
    const logical = operation(now);
    const first = await host.submit(request("first", logical));
    first.result.value = 99;
    const replay = await host.submit(request("second", logical));
    assert.equal(replay.result.value, 1);
});

test("running duplicates join and completed duplicates replay one execution", async () => {
    let now = Date.parse("2026-09-12T08:05:00.000Z");
    let executions = 0;
    let release;
    let started;
    const began = new Promise((resolve) => {
        started = resolve;
    });
    const held = new Promise((resolve) => {
        release = resolve;
    });
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            started();
            await held;
            return { ok: true, applied: 1 };
        },
    });
    const logical = operation(now);

    const first = host.submit(request("attempt-one", logical));
    await began;
    const second = host.submit(request("attempt-two", logical));
    release();

    const [executed, joined] = await Promise.all([first, second]);
    const replayed = await host.submit(request("attempt-three", logical));
    const excess = await host.submit(request("attempt-four", logical));

    assert.equal(executions, 1);
    assert.equal(executed.disposition, "executed");
    assert.equal(joined.disposition, "joined");
    assert.equal(replayed.disposition, "replayed");
    assert.equal(excess.reason, "too-many-attempts");
    assert.equal(excess.mayHaveExecuted, true);
});

test("an operation id cannot change payload, owner, target data, or expiry", async () => {
    const now = Date.parse("2026-09-12T08:10:00.000Z");
    let executions = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            return { ok: true };
        },
    });
    const logical = operation(now);
    await host.submit(request("attempt-base", logical));

    for (const [requestId, changedOperation, payload] of [
        ["attempt-payload", logical, { value: 2 }],
        [
            "attempt-owner",
            {
                ...logical,
                sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                sessionFolder:
                    "C:\\Users\\test\\.copilot\\session-state\\bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            },
            { value: 1 },
        ],
        [
            "attempt-start",
            { ...logical, targetStartedAt: "2026-09-12T08:00:01.000Z" },
            { value: 1 },
        ],
        [
            "attempt-expiry",
            { ...logical, expiresAt: new Date(now + 9000).toISOString() },
            { value: 1 },
        ],
    ]) {
        const result = await host.submit(request(requestId, changedOperation, payload));
        assert.equal(result.ok, false);
        assert.equal(result.reason, "operation-conflict");
    }
    assert.equal(executions, 1);
});

test("invalid future timestamps and excessive lifetimes reserve no cache capacity", async () => {
    const now = Date.parse("2026-09-12T08:15:00.000Z");
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => ({ ok: true }),
    });

    const future = await host.submit(
        request(
            "attempt-future",
            operation(now, {
                id: "future-operation",
                createdAt: new Date(now + 6000).toISOString(),
                expiresAt: new Date(now + 7000).toISOString(),
            }),
        ),
    );
    const excessive = await host.submit(
        request(
            "attempt-long",
            operation(now, {
                id: "long-operation",
                expiresAt: new Date(now + MAX_OPERATION_LIFETIME_MS + 1).toISOString(),
            }),
        ),
    );

    assert.equal(future.reason, "invalid-operation");
    assert.equal(excessive.reason, "invalid-operation");
    assert.equal(host.stats().records, 0);
    assert.equal(host.stats().activeExecutions, 0);
});

test("a known adoption operation replays after the window becomes owned", async () => {
    const now = Date.parse("2026-09-12T08:20:00.000Z");
    let ownership = "unbound";
    let executions = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: ownership }),
        execute: async () => {
            executions += 1;
            ownership = "owned";
            return { ok: true, added: true };
        },
    });
    const logical = operation(now, {
        id: "adoption-operation",
        admission: "adopt-unbound",
    });
    const payload = { folders: ["C:\\repo", SESSION_FOLDER] };

    const first = await host.submit({
        ...request("adopt-attempt-one", logical, payload),
        route: "workspace-add",
    });
    const replay = await host.submit({
        ...request("adopt-attempt-two", logical, payload),
        route: "workspace-add",
    });

    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.disposition, "replayed");
    assert.equal(executions, 1);
});

test("expired identities never execute again after cleanup or wall-clock rollback", async () => {
    let now = Date.parse("2026-09-12T08:25:00.000Z");
    let executions = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            return { ok: true };
        },
    });
    const logical = operation(now, {
        id: "expiring-operation",
        expiresAt: new Date(now + 100).toISOString(),
    });

    await host.submit(request("expiry-attempt-one", logical));
    now += 101;
    const retained = await host.submit(request("expiry-attempt-retained", logical));
    assert.equal(retained.disposition, "replayed");

    now += COMPLETED_GRACE_MS + 1;
    host.maintain();
    assert.equal(host.stats().records, 0);

    now -= COMPLETED_GRACE_MS;
    const result = await host.submit(request("expiry-attempt-two", logical));
    assert.equal(result.reason, "expired");
    assert.equal(executions, 1);
});

test("duplicates do not consume the eight unique execution slots", async () => {
    const now = Date.parse("2026-09-12T08:30:00.000Z");
    let executions = 0;
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            await held;
            return { ok: true };
        },
    });

    const running = [];
    for (let index = 0; index < 8; index += 1) {
        running.push(
            host.submit(
                request(
                    `capacity-attempt-${index}`,
                    operation(now, { id: `capacity-operation-${index}` }),
                ),
            ),
        );
    }
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = host.submit(
        request(
            "capacity-duplicate",
            operation(now, { id: "capacity-operation-0" }),
        ),
    );
    const ninth = await host.submit(
        request(
            "capacity-attempt-nine",
            operation(now, { id: "capacity-operation-nine" }),
        ),
    );

    assert.equal(host.stats().activeExecutions, 8);
    assert.equal(ninth.reason, "busy");
    release();
    const results = await Promise.all([...running, duplicate]);
    assert.equal(results.at(-1).disposition, "joined");
    assert.equal(executions, 8);
});

test("oversized results retain a terminal marker instead of permitting re-execution", async () => {
    const now = Date.parse("2026-09-12T08:35:00.000Z");
    let executions = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        maxResultBytes: 128,
        resultBudgetBytes: 1024,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            return { ok: true, value: "x".repeat(1024) };
        },
    });
    const logical = operation(now, { id: "oversized-result" });

    const first = await host.submit(request("oversized-attempt-one", logical));
    const replay = await host.submit(request("oversized-attempt-two", logical));

    assert.equal(first.reason, "result-limit");
    assert.equal(first.mayHaveExecuted, true);
    assert.equal(replay.reason, "result-limit");
    assert.equal(replay.disposition, "replayed");
    assert.equal(executions, 1);
});

test("cache pressure refuses new work without evicting unexpired evidence", async () => {
    const now = Date.parse("2026-09-12T08:40:00.000Z");
    let executions = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        maxRecords: 1,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            return { ok: true };
        },
    });
    const retained = operation(now, { id: "retained-operation" });
    await host.submit(request("retained-attempt-one", retained));

    const busy = await host.submit(
        request(
            "new-attempt",
            operation(now, { id: "new-operation" }),
        ),
    );
    const replay = await host.submit(request("retained-attempt-two", retained));

    assert.equal(busy.reason, "busy");
    assert.equal(replay.disposition, "replayed");
    assert.equal(executions, 1);
});

test("retained-result memory pressure refuses new work and preserves replay evidence", async () => {
    const now = Date.parse("2026-09-12T08:45:00.000Z");
    let executions = 0;
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        maxResultBytes: 256,
        resultBudgetBytes: 350,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            executions += 1;
            return { ok: true, value: "x".repeat(100) };
        },
    });
    const retained = operation(now, { id: "retained-result-operation" });
    await host.submit(request("retained-result-attempt-one", retained));

    const busy = await host.submit(
        request(
            "result-budget-attempt",
            operation(now, { id: "result-budget-operation" }),
        ),
    );
    const replay = await host.submit(
        request("retained-result-attempt-two", retained),
    );

    assert.equal(busy.reason, "busy");
    assert.match(busy.error, /result cache is full/);
    assert.equal(replay.disposition, "replayed");
    assert.equal(executions, 1);
});

test("simultaneous completions replace reservations rather than counting both", async () => {
    const now = Date.parse("2026-09-12T09:00:00.000Z");
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const host = createOperationHost({
        windowId: WINDOW_ID,
        startedAt: STARTED_AT,
        now: () => now,
        inspectOwnership: () => ({ state: "owned" }),
        execute: async () => {
            await held;
            return { ok: true, data: "x".repeat(300 * 1024) };
        },
    });
    const pending = Array.from({ length: 8 }, (_, index) =>
        host.submit(request(`completion-${index}`, operation(now, { id: `completing-${index}` }))),
    );
    assert.equal(host.stats().activeExecutions, 8);
    release();
    const results = await Promise.all(pending);
    assert.equal(results.filter((result) => result.ok).length, 8);
    assert.equal(host.stats().reservedResultBytes, 0);
    assert.equal(host.stats().activeExecutions, 0);
    assert.ok(host.stats().retainedResultBytes < 3 * 1024 * 1024);
});
