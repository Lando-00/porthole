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
