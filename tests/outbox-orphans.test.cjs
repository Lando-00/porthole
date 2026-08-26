// Abandoned outboxes.
//
// An outbox can hold a selection of the user's source code. It is only ever
// readable by the one CLI process whose endpoint id names it, so once that
// process is gone the directory is dead weight in the user's home directory -
// and the pruning that removes it keys off a presence file that a clean exit
// deletes on its way out.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SRC = path.join(path.resolve(__dirname, ".."), "vscode-extension", "src");
const SEND = path.join(SRC, "send.js");

function loadSend() {
    const mocks = new Map([
        ["vscode", {
            commands: { registerCommand: () => ({ dispose() {} }) },
            window: {
                showInformationMessage() {},
                showWarningMessage() {},
                showQuickPick: async () => undefined,
                showInputBox: async () => undefined,
                get activeTextEditor() {
                    return undefined;
                },
            },
            workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
        }],
        [path.join(SRC, "log.js"), { diag() {} }],
    ]);
    const originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
        if (mocks.has(request)) return mocks.get(request);
        let resolved;
        try {
            resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
            resolved = null;
        }
        if (resolved && mocks.has(resolved)) return mocks.get(resolved);
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[SEND];
    try {
        return require(SEND);
    } finally {
        Module._load = originalLoad;
    }
}

function ageDirectory(dir, ms) {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(dir, when, when);
}

test("an outbox whose session exited cleanly is not left in the home directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-orphan-"));
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    try {
        const portholeDir = path.join(home, "porthole");
        fs.mkdirSync(portholeDir, { recursive: true });

        // A session that exited cleanly: its presence file is gone, but the
        // outbox - holding the user's selected code - is still here.
        const orphan = path.join(portholeDir, "outbox", "deadbeefdeadbeef");
        fs.mkdirSync(orphan, { recursive: true });
        fs.writeFileSync(path.join(orphan, "m1.json"), JSON.stringify({
            messageId: "m1",
            selection: "const secret = 1;",
        }), "utf8");
        ageDirectory(orphan, 10 * 60 * 1000);

        // A live session, which must be left completely alone.
        const liveId = "0123456789abcdef";
        const liveOutbox = path.join(portholeDir, "outbox", liveId);
        fs.mkdirSync(liveOutbox, { recursive: true });
        ageDirectory(liveOutbox, 10 * 60 * 1000);
        fs.writeFileSync(
            path.join(portholeDir, `cli-${liveId}.json`),
            JSON.stringify({ pid: process.pid, endpointId: liveId, updatedAt: new Date().toISOString() }),
            "utf8",
        );

        const send = loadSend();
        const endpoints = send.findEndpoints();

        assert.equal(fs.existsSync(orphan), false, "the abandoned outbox must be removed");
        assert.equal(fs.existsSync(liveOutbox), true, "a live session's outbox must be untouched");
        assert.deepEqual(endpoints.map((e) => e.endpointId), [liveId]);
    } finally {
        if (previous === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previous;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("a freshly created outbox is never mistaken for an abandoned one", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-orphan-new-"));
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    try {
        const portholeDir = path.join(home, "porthole");
        fs.mkdirSync(portholeDir, { recursive: true });

        // A session that has just created its outbox and has not finished
        // publishing presence yet.
        const starting = path.join(portholeDir, "outbox", "aaaabbbbccccdddd");
        fs.mkdirSync(starting, { recursive: true });

        const send = loadSend();
        send.findEndpoints();

        assert.equal(fs.existsSync(starting), true, "a new outbox is inside the grace period");
    } finally {
        if (previous === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previous;
        fs.rmSync(home, { recursive: true, force: true });
    }
});
