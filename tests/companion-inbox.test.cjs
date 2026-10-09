const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-inbox-test-"));
process.env.COPILOT_HOME = home;

const inbox = require("../vscode-extension/src/inbox");
const transport = require("../vscode-extension/src/transport");
const workspace = require("../vscode-extension/src/workspace");

function waitFor(file, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (fs.existsSync(file)) return resolve();
            if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
            setTimeout(tick, 10);
        };
        tick();
    });
}

function waitForMissing(file, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (!fs.existsSync(file)) return resolve();
            if (Date.now() >= deadline) return reject(new Error(`timed out waiting to claim ${file}`));
            setTimeout(tick, 10);
        };
        tick();
    });
}

test.after(() => {
    inbox.stop();
    fs.rmSync(home, { recursive: true, force: true });
});

test("an addressed request is consumed only by its window inbox", async () => {
    const windowId = "1234567890abcdef";
    const requestId = `${Date.now()}-inbox-test`;
    const seen = [];
    const subscription = inbox.start(windowId, async (request) => {
        seen.push(request);
        return {
            ok: true,
            result: { windowId },
        };
    });

    const dir = inbox.inboxDir(windowId);
    const file = path.join(dir, `${requestId}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
        tmp,
        JSON.stringify({ requestId, route: "ping", payload: null }),
        "utf8",
    );
    fs.renameSync(tmp, file);

    const ackFile = path.join(os.tmpdir(), "porthole", "ack", `${requestId}.json`);
    await waitFor(ackFile);
    const ack = JSON.parse(fs.readFileSync(ackFile, "utf8"));
    fs.rmSync(ackFile, { force: true });

    assert.equal(ack.ok, true);
    assert.equal(ack.result.windowId, windowId);
    assert.equal(ack.deliveryMode, "legacy-single-shot");
    assert.equal(ack.disposition, "executed");
    assert.deepEqual(seen, [{ requestId, route: "ping", payload: null }]);
    assert.equal(fs.existsSync(file), false);

    subscription.dispose();
});

test("workspace-add changes only the addressed mock window", () => {
    const folders = [{ uri: { fsPath: "C:\\repo" } }];
    const vscode = {
        Uri: { file: (fsPath) => ({ fsPath }) },
        workspace: {
            workspaceFolders: folders,
            updateWorkspaceFolders(start, remove, ...added) {
                assert.equal(start, 1);
                assert.equal(remove, 0);
                folders.push(...added);
                this.workspaceFolders = folders;
                return true;
            },
        },
    };

    const result = workspace.add(vscode, {
        folders: ["C:\\repo", "C:\\Users\\me\\.copilot\\session-state\\abc"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.folders, ["C:\\Users\\me\\.copilot\\session-state\\abc"]);
    assert.equal(folders.length, 2);
});

test("a slow route does not hold up the requests behind it", async () => {
    // `preview` parks on an Apply/Cancel notification until the user answers.
    // While the inbox dispatched serially, that single unanswered toast left
    // every later request unclaimed and unacked, so the CLI timed out on all of
    // them and reported a perfectly healthy window as dead - `ping` included.
    const windowId = "fedcba0987654321";
    const slowId = `${Date.now()}-slow`;
    const quickId = `${Date.now()}-quick`;

    let releaseSlow;
    const slowStarted = new Promise((resolve) => {
        releaseSlow = resolve;
    });
    let unblock;
    const held = new Promise((resolve) => {
        unblock = resolve;
    });

    const subscription = inbox.start(windowId, async (request) => {
        if (request.requestId === slowId) {
            releaseSlow();
            await held; // still "showing the notification"
        }
        return { ok: true, result: { id: request.requestId } };
    });

    const dir = inbox.inboxDir(windowId);
    const put = (requestId, route) => {
        const file = path.join(dir, `${requestId}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ requestId, route, payload: null }), "utf8");
        fs.renameSync(`${file}.tmp`, file);
    };

    put(slowId, "preview");
    await slowStarted; // the slow route is now parked mid-flight

    put(quickId, "ping");
    const quickAck = path.join(os.tmpdir(), "porthole", "ack", `${quickId}.json`);
    await waitFor(quickAck, 3000); // must not wait on the slow one

    assert.equal(JSON.parse(fs.readFileSync(quickAck, "utf8")).ok, true);
    fs.rmSync(quickAck, { force: true });

    // The slow request still completes normally once the user answers.
    unblock();
    const slowAck = path.join(os.tmpdir(), "porthole", "ack", `${slowId}.json`);
    await waitFor(slowAck, 3000);
    assert.equal(JSON.parse(fs.readFileSync(slowAck, "utf8")).ok, true);
    fs.rmSync(slowAck, { force: true });

    subscription.dispose();
});

test("a request the CLI gave up on is never dispatched", async () => {
    // The CLI removes the pending file on timeout, but the claim is a rename -
    // so once the companion has claimed it, the file being removed is no longer
    // the file the companion holds, and the route ran anyway. The model, told
    // the window never answered, then retried: two previews, two workspace
    // edits, two of whatever the route does.
    const windowId = "abcdefabcdef0000";
    const requestId = `${Date.now()}-abandoned`;
    const dispatched = [];

    const subscription = inbox.start(windowId, async (request) => {
        dispatched.push(request.requestId);
        return { ok: true };
    });

    const dir = inbox.inboxDir(windowId);

    // The CLI's timeout path: marker first, then remove the request.
    const marker = path.join(dir, `${requestId}.abandoned`);
    fs.writeFileSync(`${marker}.tmp`, JSON.stringify({ requestId }), "utf8");
    fs.renameSync(`${marker}.tmp`, marker);

    // The request lands (or was already there) after the CLI stopped listening.
    const file = path.join(dir, `${requestId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ requestId, route: "reveal", payload: {} }), "utf8");
    fs.renameSync(`${file}.tmp`, file);

    // Give the watcher and the fallback poll a fair chance to act on it.
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.deepEqual(dispatched, [], "an abandoned request must run no route at all");
    assert.equal(fs.existsSync(file), false, "the request is cleaned up");
    assert.equal(fs.existsSync(marker), false, "and so is its marker");

    subscription.dispose();
});

test("an ordinary request is unaffected by the abandonment check", async () => {
    const windowId = "abcdefabcdef1111";
    const requestId = `${Date.now()}-normal`;
    const dispatched = [];

    const subscription = inbox.start(windowId, async (request) => {
        dispatched.push(request.requestId);
        return { ok: true };
    });

    const dir = inbox.inboxDir(windowId);
    const file = path.join(dir, `${requestId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ requestId, route: "ping", payload: null }), "utf8");
    fs.renameSync(`${file}.tmp`, file);

    const ackFile = path.join(os.tmpdir(), "porthole", "ack", `${requestId}.json`);
    await waitFor(ackFile, 3000);
    fs.rmSync(ackFile, { force: true });

    assert.deepEqual(dispatched, [requestId]);
    subscription.dispose();
});

test("a malformed marker is discarded and blocks nothing", async () => {
    const windowId = "abcdefabcdef2222";
    const requestId = `${Date.now()}-clean`;
    const dispatched = [];

    const subscription = inbox.start(windowId, async (request) => {
        dispatched.push(request.requestId);
        return { ok: true };
    });

    const dir = inbox.inboxDir(windowId);
    const junk = path.join(dir, "not a valid id!.abandoned");
    fs.writeFileSync(junk, "{}", "utf8");

    const file = path.join(dir, `${requestId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ requestId, route: "ping", payload: null }), "utf8");
    fs.renameSync(`${file}.tmp`, file);

    const ackFile = path.join(os.tmpdir(), "porthole", "ack", `${requestId}.json`);
    await waitFor(ackFile, 3000);
    fs.rmSync(ackFile, { force: true });

    assert.deepEqual(dispatched, [requestId], "junk must not stop real requests");
    assert.equal(fs.existsSync(junk), false, "and must be discarded");

    subscription.dispose();
});

function guardedOperation({
    id,
    windowId,
    startedAt,
    sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionFolder = path.join(home, "session-state", sessionId),
    createdAt = Date.now(),
    expiresAt = createdAt + 5000,
} = {}) {
    return {
        version: 1,
        id,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        sessionId,
        sessionFolder,
        targetWindowId: windowId,
        targetStartedAt: startedAt,
        admission: "owned",
    };
}

function putRequest(windowId, request) {
    const dir = inbox.inboxDir(windowId);
    const file = path.join(dir, `${request.requestId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(request), "utf8");
    fs.renameSync(`${file}.tmp`, file);
}

test("guarded duplicates join one execution and receive separate acknowledgements", async () => {
    const windowId = "abcdefabcdef3333";
    const startedAt = new Date().toISOString();
    const operation = guardedOperation({
        id: `${Date.now()}-logical`,
        windowId,
        startedAt,
    });
    let executions = 0;
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    let started;
    const began = new Promise((resolve) => {
        started = resolve;
    });
    const subscription = inbox.start(
        windowId,
        async () => {
            executions += 1;
            started();
            await held;
            return { ok: true, applied: 1 };
        },
        {
            startedAt,
            inspectOwnership: () => ({ state: "owned" }),
        },
    );

    const firstId = `${Date.now()}-guarded-a`;
    const secondId = `${Date.now()}-guarded-b`;
    putRequest(windowId, {
        requestId: firstId,
        operation,
        route: "annotate",
        payload: { value: 1 },
    });
    await began;
    putRequest(windowId, {
        requestId: secondId,
        operation,
        route: "annotate",
        payload: { value: 1 },
    });
    await waitForMissing(path.join(inbox.inboxDir(windowId), `${secondId}.json`));
    release();

    const firstAck = path.join(os.tmpdir(), "porthole", "ack", `${firstId}.json`);
    const secondAck = path.join(os.tmpdir(), "porthole", "ack", `${secondId}.json`);
    await Promise.all([waitFor(firstAck), waitFor(secondAck)]);
    const first = JSON.parse(fs.readFileSync(firstAck, "utf8"));
    const second = JSON.parse(fs.readFileSync(secondAck, "utf8"));
    fs.rmSync(firstAck, { force: true });
    fs.rmSync(secondAck, { force: true });

    assert.equal(executions, 1);
    assert.equal(first.operationId, operation.id);
    assert.equal(second.operationId, operation.id);
    assert.deepEqual(
        new Set([first.disposition, second.disposition]),
        new Set(["executed", "joined"]),
    );
    subscription.dispose();
});

test("a malformed new operation envelope is rejected instead of downgraded", async () => {
    const windowId = "abcdefabcdef4444";
    const startedAt = new Date().toISOString();
    const requestId = `${Date.now()}-malformed-operation`;
    let executions = 0;
    const subscription = inbox.start(
        windowId,
        async () => {
            executions += 1;
            return { ok: true };
        },
        {
            startedAt,
            inspectOwnership: () => ({ state: "owned" }),
        },
    );

    putRequest(windowId, {
        requestId,
        operation: { version: 1 },
        route: "ping",
        payload: null,
    });
    const ackFile = path.join(os.tmpdir(), "porthole", "ack", `${requestId}.json`);
    await waitFor(ackFile);
    const ack = JSON.parse(fs.readFileSync(ackFile, "utf8"));
    fs.rmSync(ackFile, { force: true });

    assert.equal(ack.ok, false);
    assert.equal(ack.reason, "invalid-operation");
    assert.equal(ack.deliveryMode, "guarded");
    assert.equal(ack.disposition, "rejected");
    assert.equal(executions, 0);
    subscription.dispose();
});

test("oversized acknowledgements become bounded explicit terminal outcomes", () => {
    const requestId = `${Date.now()}-oversized-ack`;
    transport.writeAck(requestId, {
        ok: true,
        value: "x".repeat(transport.MAX_ACK_BYTES),
        requestId,
        operationId: "bounded-operation",
        windowId: "abcdefabcdef5555",
        targetStartedAt: "2026-09-12T08:00:00.000Z",
        deliveryMode: "guarded",
        disposition: "executed",
    });

    const ackFile = path.join(os.tmpdir(), "porthole", "ack", `${requestId}.json`);
    const ack = JSON.parse(fs.readFileSync(ackFile, "utf8"));
    fs.rmSync(ackFile, { force: true });

    assert.equal(ack.ok, false);
    assert.equal(ack.reason, "result-limit");
    assert.equal(ack.mayHaveExecuted, true);
    assert.equal(ack.operationId, "bounded-operation");
    assert.ok(
        Buffer.byteLength(JSON.stringify(ack), "utf8") < transport.MAX_ACK_BYTES,
    );
});

test("legacy and guarded deliveries share the same eight executing-operation slots", { timeout: 3000 }, async () => {
    const windowId = "abcdefabcdef7777";
    const startedAt = new Date().toISOString();
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sessionFolder = path.join(home, "session-state", sessionId);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let eightStarted;
    const began = new Promise((resolve) => { eightStarted = resolve; });
    let busyAck;
    const busy = new Promise((resolve) => { busyAck = resolve; });
    let legacyDone;
    const legacyFinished = new Promise((resolve) => { legacyDone = resolve; });
    let executing = 0;
    let maximum = 0;
    let started = 0;
    let legacyStarted = false;
    const subscription = inbox.start(windowId, async (request) => {
        executing += 1;
        maximum = Math.max(maximum, executing);
        started += 1;
        if (started === 8) eightStarted();
        if (!request.operation) legacyStarted = true;
        await held;
        executing -= 1;
        return { ok: true };
    }, {
        startedAt,
        inspectOwnership: () => ({ state: "owned" }),
        writeAck: (id, ack) => {
            if (id === "z-overflow") busyAck(ack);
            if (id === "a-legacy-overflow") legacyDone(ack);
        },
    });
    const dir = inbox.inboxDir(windowId);
    const envelope = (id) => ({
        requestId: id,
        route: "annotate",
        payload: null,
        operation: {
            version: 1,
            id,
            createdAt: startedAt,
            expiresAt: new Date(Date.parse(startedAt) + 10_000).toISOString(),
            sessionId,
            sessionFolder,
            targetWindowId: windowId,
            targetStartedAt: startedAt,
            admission: "owned",
        },
    });
    const keepAlive = setInterval(() => {}, 100);
    try {
        for (let i = 0; i < 8; i += 1) {
            const id = `initial-${i}`;
            fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(envelope(id)));
        }
        await began;
        fs.writeFileSync(path.join(dir, "a-legacy-overflow.json"), JSON.stringify({
            requestId: "a-legacy-overflow", route: "annotate", payload: null,
        }));
        fs.writeFileSync(path.join(dir, "z-overflow.json"), JSON.stringify(envelope("z-overflow")));
        assert.equal((await busy).reason, "busy");
        assert.equal(legacyStarted, false);
        assert.equal(maximum, 8);
        release();
        assert.equal((await legacyFinished).ok, true);
        assert.equal(maximum, 8);
    } finally {
        clearInterval(keepAlive);
        release();
        subscription.dispose();
    }
});
