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
        transport.writeAck(request.requestId, {
            ok: true,
            result: { windowId },
        });
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
        transport.writeAck(request.requestId, { ok: true, result: { id: request.requestId } });
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
        transport.writeAck(request.requestId, { ok: true });
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
        transport.writeAck(request.requestId, { ok: true });
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
        transport.writeAck(request.requestId, { ok: true });
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
