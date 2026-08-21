import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import inbox from "../../vscode-extension/src/inbox.js";
import focus from "../../vscode-extension/src/focus.js";
import transport from "../../vscode-extension/src/transport.js";
import workspace from "../../vscode-extension/src/workspace.js";
import dispatcher from "../../vscode-extension/src/dispatcher.js";
import companionCapabilities from "../../vscode-extension/src/capabilities.js";

const SESSION_ID = /^[a-f0-9-]{36}$/;
const WINDOW_ID = /^[a-f0-9]{16}$/;

function inside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function artifactPath(session, segments) {
    if (!session || !Array.isArray(segments) || segments.length === 0) {
        throw new TypeError("a session and artifact path are required");
    }
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new TypeError("artifact path contains an invalid segment");
    }
    const file = join(session.dir, ...segments);
    if (!inside(session.dir, file)) throw new Error("artifact path escaped the Copilot session");
    return file;
}

function presentationHost({ focused }) {
    const warningAnswers = [];
    const presentation = {
        commands: [],
        information: [],
        warnings: [],
        warningPrompts: [],
        answerWarning(action) {
            warningAnswers.push(action);
        },
    };
    const folders = [];
    const vscode = {
        Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
        commands: {
            async executeCommand(command) {
                presentation.commands.push(command);
            },
        },
        window: {
            state: { focused },
            activeTextEditor: null,
            showInformationMessage(message) {
                presentation.information.push(message);
                return undefined;
            },
            showWarningMessage(message, options, ...actions) {
                presentation.warningPrompts.push({ message, options, actions });
                return warningAnswers.shift();
            },
        },
        workspace: {
            workspaceFolders: folders,
            updateWorkspaceFolders(start, remove, ...added) {
                folders.splice(start, remove, ...added);
                this.workspaceFolders = folders;
                return true;
            },
        },
    };
    return { vscode, presentation, folders };
}

export async function createPortholeHarness() {
    const home = mkdtempSync(join(tmpdir(), "porthole-protocol-harness-"));
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;

    const sessions = new Map();
    const windows = new Map();
    const subscriptions = [];

    function addSession(id, repository) {
        if (!SESSION_ID.test(String(id))) throw new TypeError("invalid Copilot session id");
        if (sessions.has(id)) throw new Error(`Copilot session '${id}' already exists`);

        const dir = join(home, "session-state", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "events.jsonl"), "", "utf8");
        writeFileSync(
            join(dir, "workspace.yaml"),
            `id: ${id}\ncwd: ${repository}\ngit_root: ${repository}\n`,
            "utf8",
        );
        const session = { id, dir, workspacePath: dir, repository };
        sessions.set(id, session);
        return session;
    }

    function addWindow({
        windowId,
        session = null,
        focused = false,
        routes = {},
        protocolLevel = companionCapabilities.PROTOCOL_LEVEL,
        capabilities = undefined,
        connectionHealth = session ? "connected" : "unbound",
        compatibility = null,
        presenceOverrides = {},
    }) {
        if (!WINDOW_ID.test(String(windowId))) throw new TypeError("invalid Porthole window id");
        if (windows.has(windowId)) throw new Error(`Porthole window '${windowId}' already exists`);

        const host = presentationHost({ focused });
        for (const folder of [session?.repository, session?.dir].filter(Boolean)) {
            host.folders.push({ uri: host.vscode.Uri.file(folder) });
        }

        const requests = [];
        const extraRoutes = typeof routes === "function" ? routes(host.vscode) : routes;
        const handlers = {
            focus: () => focus.focus(host.vscode),
            "workspace-add": (payload) => workspace.add(host.vscode, payload),
            ping: () => ({ ok: true, windowId }),
            ...extraRoutes,
        };
        const advertisedCapabilities =
            capabilities === undefined
                ? [
                      "transport:addressed-inbox",
                      ...Object.keys(handlers).map(companionCapabilities.routeCapability),
                  ]
                : capabilities;
        const executeRequest = dispatcher.createDispatcher({
            knownRoutes: new Set(Object.keys(handlers)),
            optionalPayloadRoutes: new Set(["focus", "ping"]),
            dispatch: async (route, payload) => handlers[route](payload),
            writeAck: transport.writeAck,
            warn: (message) => host.presentation.warnings.push(message),
            onHandled: (result, metadata) => {
                requests.push({ ...metadata, result });
            },
        });
        const subscription = inbox.start(windowId, (request) =>
            executeRequest(request.route, request.payload, request.requestId, "inbox"),
        );
        subscriptions.push(subscription);

        const presenceDir = join(home, "porthole");
        mkdirSync(presenceDir, { recursive: true });
        const presence = {
            windowId,
            pid: process.pid,
            version: "test",
            protocolLevel,
            capabilities: advertisedCapabilities,
            requiredCliCapabilities: [],
            connectionHealth,
            compatibility,
            uriScheme: "vscode-insiders",
            appName: "Visual Studio Code - Insiders",
            appHost: "desktop",
            remoteName: null,
            tmpdir: tmpdir(),
            copilotHome: home,
            sessionId: session?.id || null,
            sessionFolder: session?.dir || null,
            workspaceFolders: host.folders.map((folder) => folder.uri.fsPath),
            updatedAt: new Date().toISOString(),
            ...presenceOverrides,
        };
        writeFileSync(
            join(presenceDir, `companion-harness-${windowId}.json`),
            JSON.stringify(presence),
            "utf8",
        );

        const window = {
            windowId,
            session,
            presence,
            requests,
            presentation: host.presentation,
            vscode: host.vscode,
        };
        windows.set(windowId, window);
        return window;
    }

    async function invokeTool(definitions, name, args = {}) {
        const tool = definitions.find((definition) => definition.name === name);
        if (!tool) throw new Error(`tool '${name}' is not registered`);
        return tool.handler(args);
    }

    function writeSessionArtifact(session, segments, value) {
        const file = artifactPath(session, segments);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
        return file;
    }

    function readSessionArtifact(session, segments) {
        try {
            return JSON.parse(readFileSync(artifactPath(session, segments), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    function dispose() {
        for (const subscription of subscriptions.splice(0)) subscription.dispose();
        rmSync(home, { recursive: true, force: true });
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
    }

    return {
        home,
        sessions,
        windows,
        addSession,
        addWindow,
        invokeTool,
        writeSessionArtifact,
        readSessionArtifact,
        dispose,
    };
}
