const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const IDENTITY = path.join(ROOT, "vscode-extension", "src", "identity.js");
const SESSION = path.join(ROOT, "vscode-extension", "src", "session.js");

function disposable() {
    return { dispose() {} };
}

function loadStatusScenario({ bound, endpoint }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-identity-test-"));
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;

    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sessionDir = path.join(home, "session-state", sessionId);
    if (bound) {
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "", "utf8");
        fs.writeFileSync(
            path.join(sessionDir, "workspace.yaml"),
            `id: ${sessionId}\nname: Identity Test\n`,
            "utf8",
        );
    }
    if (endpoint) {
        const portholeDir = path.join(home, "porthole");
        fs.mkdirSync(portholeDir, { recursive: true });
        fs.writeFileSync(
            path.join(portholeDir, "cli-identity-test.json"),
            JSON.stringify({
                endpointId: "1111111111111111",
                sessionId,
                sessionName: "Identity Test",
                pid: process.pid,
                ...endpoint,
            }),
            "utf8",
        );
    }

    const status = {
        text: "",
        tooltip: "",
        color: null,
        visible: false,
        show() {
            this.visible = true;
        },
        hide() {
            this.visible = false;
        },
        dispose() {},
    };
    const vscode = {
        StatusBarAlignment: { Left: 1 },
        ThemeColor: class ThemeColor {
            constructor(id) {
                this.id = id;
            }
        },
        window: {
            createStatusBarItem: () => status,
            onDidChangeWindowState: () => disposable(),
        },
        workspace: {
            workspaceFolders: bound ? [{ uri: { fsPath: sessionDir } }] : [],
            onDidChangeWorkspaceFolders: () => disposable(),
        },
        commands: { executeCommand: async () => undefined },
    };

    const originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
        if (request === "vscode") return vscode;
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[IDENTITY];
    delete require.cache[SESSION];

    const subscriptions = [];
    try {
        const identity = require(IDENTITY);
        identity.activate({ subscriptions: { push: (...items) => subscriptions.push(...items) } });
    } finally {
        Module._load = originalLoad;
    }

    return {
        status,
        dispose() {
            for (const subscription of subscriptions) subscription.dispose();
            fs.rmSync(home, { recursive: true, force: true });
            if (previousHome === undefined) delete process.env.COPILOT_HOME;
            else process.env.COPILOT_HOME = previousHome;
        },
    };
}

test("the companion status item renders every canonical window health state", () => {
    const scenarios = [
        {
            input: { bound: false, endpoint: null },
            icon: "$(debug-disconnect)",
            health: "Health: unbound",
        },
        {
            input: { bound: true, endpoint: null },
            icon: "$(debug-disconnect)",
            health: "Health: disconnected",
        },
        {
            input: {
                bound: true,
                endpoint: { capabilities: ["transport:addressed-inbox"] },
            },
            icon: "$(radio-tower)",
            health: "Health: connected",
        },
        {
            input: {
                bound: true,
                endpoint: {
                    capabilities: ["transport:addressed-inbox"],
                    requiredCompanionCapabilities: ["route:not-supported"],
                },
            },
            icon: "$(error)",
            health: "Health: incompatible — update the companion",
            missing: "Missing: route:not-supported",
        },
    ];

    for (const scenario of scenarios) {
        const loaded = loadStatusScenario(scenario.input);
        try {
            assert.equal(loaded.status.visible, true);
            assert.equal(loaded.status.text.startsWith(scenario.icon), true);
            assert.match(String(loaded.status.tooltip), new RegExp(scenario.health));
            if (scenario.missing) {
                assert.match(String(loaded.status.tooltip), new RegExp(scenario.missing));
            }
        } finally {
            loaded.dispose();
        }
    }
});
