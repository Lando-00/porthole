import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { createPortholeHarness } from "./support/porthole-harness.mjs";

function waitUntil(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() >= deadline) return reject(new Error("timed out waiting for harness state"));
            setTimeout(tick, 10);
        };
        tick();
    });
}

test("a public CLI tool reaches only its session's addressed Porthole window", async () => {
    const harness = await createPortholeHarness();
    try {
        const repository = "C:\\repo";
        const sessionA = harness.addSession(
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            repository,
        );
        const sessionB = harness.addSession(
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            repository,
        );
        const windowA = harness.addWindow({
            windowId: "1111111111111111",
            session: sessionA,
            focused: true,
        });

        const windowB = harness.addWindow({
            windowId: "2222222222222222",
            session: sessionB,
            focused: false,
        });

        const { tools } = await import("../extensions/porthole/lib/opensession.mjs");
        const result = await harness.invokeTool(
            tools(() => sessionB),
            "porthole_focus_window",
            {},
        );

        assert.match(result, /requested attention from the exact VS Code window/);
        assert.deepEqual(windowA.requests, []);
        assert.equal(windowB.requests.length, 1);
        assert.equal(windowB.requests[0].route, "focus");
        assert.deepEqual(windowA.presentation.commands, []);
        assert.deepEqual(windowB.presentation.commands, [
            "workbench.action.focusActiveEditorGroup",
        ]);
        assert.match(windowB.presentation.information[0], /requested session window/);

    } finally {
        harness.dispose();
    }
});

test("an explicit foreign window id is refused before any delivery", async () => {
    const harness = await createPortholeHarness();
    try {
        const sessionA = harness.addSession(
            "27272727-2727-2727-2727-272727272727",
            "C:\\repo",
        );
        const sessionB = harness.addSession(
            "28282828-2828-2828-2828-282828282828",
            "C:\\repo",
        );
        const foreign = harness.addWindow({
            windowId: "1212121212121212",
            session: sessionA,
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion("focus", null, {
            windowId: foreign.windowId,
            sessionId: sessionB.id,
            sessionPath: sessionB.dir,
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "ownership-foreign");
        assert.equal(result.windowId, foreign.windowId);
        assert.deepEqual(foreign.startedRequests, []);
    } finally {
        harness.dispose();
    }
});

test("diagnostic ping may inspect an explicit unbound window without adopting it", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "29292929-2929-2929-2929-292929292929",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "1313131313131313",
            session: null,
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion("ping", null, {
            windowId: window.windowId,
            sessionId: session.id,
            sessionPath: session.dir,
            inspectUnbound: true,
        });

        assert.equal(result.ok, true);
        assert.equal(result.deliveryMode, "legacy-single-shot");
        assert.deepEqual(window.vscode.workspace.workspaceFolders, []);
        assert.equal(window.startedRequests.length, 1);
    } finally {
        harness.dispose();
    }
});

test("the presentation seam records and answers an addressed confirmation", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "cccccccc-cccc-cccc-cccc-cccccccccccc",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "3333333333333333",
            session,
            routes: (vscode) => ({
                "confirm-binding": async () => {
                    const answer = await vscode.window.showWarningMessage(
                        "Clear the binding for session cccccccc?",
                        { modal: true },
                        "Clear binding",
                    );
                    return { ok: true, confirmed: answer === "Clear binding" };
                },
            }),
        });
        window.presentation.answerWarning("Clear binding");

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await harness.invokeTool(
            [
                {
                    name: "binding_confirmation_probe",
                    handler: () =>
                        callCompanion("confirm-binding", {}, { sessionPath: session.dir }),
                },
            ],
            "binding_confirmation_probe",
        );

        assert.equal(result.confirmed, true);
        assert.deepEqual(window.presentation.warningPrompts, [
            {
                message: "Clear the binding for session cccccccc?",
                options: { modal: true },
                actions: ["Clear binding"],
            },
        ]);
    } finally {
        harness.dispose();
    }
});

test("an addressed route can persist and expose only its session's artifact", async () => {
    const harness = await createPortholeHarness();
    try {
        const sessionA = harness.addSession(
            "dddddddd-dddd-dddd-dddd-dddddddddddd",
            "C:\\repo",
        );
        const sessionB = harness.addSession(
            "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
            "C:\\repo",
        );
        harness.addWindow({
            windowId: "4444444444444444",
            session: sessionA,
        });

        harness.addWindow({
            windowId: "5555555555555555",
            session: sessionB,
            routes: {
                "save-artifact": (payload) => {
                    harness.writeSessionArtifact(
                        sessionB,
                        ["porthole", "tours", `${payload.tourId}.json`],
                        { owner: sessionB.id, title: payload.title },
                    );
                    return { ok: true, tourId: payload.tourId };
                },
            },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await harness.invokeTool(
            [
                {
                    name: "save_artifact_probe",
                    handler: () =>
                        callCompanion(
                            "save-artifact",
                            { tourId: "probe", title: "Probe Tour" },
                            { sessionPath: sessionB.dir },
                        ),
                },
            ],
            "save_artifact_probe",
        );

        assert.equal(result.tourId, "probe");
        assert.deepEqual(
            harness.readSessionArtifact(sessionB, ["porthole", "tours", "probe.json"]),
            { owner: sessionB.id, title: "Probe Tour" },
        );
        assert.equal(
            harness.readSessionArtifact(sessionA, ["porthole", "tours", "probe.json"]),
            null,
        );
    } finally {
        harness.dispose();
    }
});

test("a missing companion capability is refused before addressed delivery", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "6666666666666666",
            session,
            protocolLevel: 1,
            capabilities: ["route:ping"],
        });

        const { tools } = await import("../extensions/porthole/lib/opensession.mjs");
        const result = await harness.invokeTool(
            tools(() => session),
            "porthole_focus_window",
            {},
        );

        assert.match(result, /requires companion capability 'route:focus'/);
        assert.match(result, /update the porthole companion/i);
        assert.deepEqual(window.requests, []);
    } finally {
        harness.dispose();
    }
});

test("a modern route capability does not bypass the addressed-inbox requirement", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "fafafafa-fafa-fafa-fafa-fafafafafafa",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "6767676767676767",
            session,
            capabilities: ["route:ping"],
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion("ping", null, {
            sessionId: session.id,
            sessionPath: session.dir,
        });

        assert.equal(result.reason, "incompatible");
        assert.equal(result.missingCapability, "transport:addressed-inbox");
        assert.deepEqual(window.startedRequests, []);
    } finally {
        harness.dispose();
    }
});

test("oversized guarded requests are refused before publication", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "fbfbfbfb-fbfb-fbfb-fbfb-fbfbfbfbfbfb",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "6868686868686868",
            session,
            routes: { annotate: () => ({ ok: true }) },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { message: "x".repeat(6 * 1024 * 1024) },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 1000,
            },
        );

        assert.equal(result.ok, false);
        assert.equal(result.reason, "error");
        assert.match(result.error, /6 MiB transport limit/);
        assert.deepEqual(window.startedRequests, []);
    } finally {
        harness.dispose();
    }
});

test("companion presence publishes its protocol and named route capabilities", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "abababab-abab-abab-abab-abababababab",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "7777777777777777",
            session,
        });

        assert.equal(window.presence.protocolLevel, 1);
        assert.equal(
            window.presence.capabilities.includes("transport:addressed-inbox"),
            true,
        );
        assert.equal(
            window.presence.capabilities.includes(
                "transport:session-owned-operations-v1",
            ),
            true,
        );
        assert.equal(window.presence.capabilities.includes("route:focus"), true);
        assert.deepEqual(window.presence.requiredCliCapabilities, [
            "transport:addressed-inbox",
        ]);
    } finally {
        harness.dispose();
    }
});

test("a legacy companion receives only the guaranteed route baseline", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "acacacac-acac-acac-acac-acacacacacac",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "8888888888888888",
            session,
            protocolLevel: null,
            capabilities: null,
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const ping = await callCompanion("ping", null, { sessionPath: session.dir });

        const { tools } = await import("../extensions/porthole/lib/opensession.mjs");
        const focusResult = await harness.invokeTool(
            tools(() => session),
            "porthole_focus_window",
            {},
        );

        assert.equal(ping.ok, true);
        assert.equal(ping.deliveryMode, "legacy-single-shot");
        assert.match(focusResult, /predates capability negotiation/);
        assert.match(focusResult, /update the porthole companion/i);
        assert.deepEqual(window.requests.map((request) => request.route), ["ping"]);
    } finally {
        harness.dispose();
    }
});

test("the window list reports all canonical connection health states", async () => {
    const harness = await createPortholeHarness();
    try {
        const connected = harness.addSession(
            "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc",
            "C:\\repo",
        );
        const disconnected = harness.addSession(
            "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd",
            "C:\\repo",
        );
        const incompatible = harness.addSession(
            "dededede-dede-dede-dede-dededededede",
            "C:\\repo",
        );
        harness.addWindow({
            windowId: "9090909090909090",
            session: null,
            connectionHealth: "unbound",
        });
        harness.addWindow({
            windowId: "9191919191919191",
            session: connected,
            connectionHealth: "connected",
        });
        harness.addWindow({
            windowId: "9292929292929292",
            session: disconnected,
            connectionHealth: "disconnected",
        });
        harness.addWindow({
            windowId: "9393939393939393",
            session: incompatible,
            connectionHealth: "incompatible",
            compatibility: {
                updateTarget: "companion",
                missingCapabilities: ["route:preview"],
            },
        });

        const { windows } = await import("../extensions/porthole/lib/opensession.mjs");
        const result = windows();

        assert.match(result, /9090909090909090.*unbound/);
        assert.match(result, /9191919191919191.*connected/);
        assert.match(result, /9292929292929292.*disconnected/);
        assert.match(result, /9393939393939393.*incompatible/);
        assert.match(result, /update companion.*route:preview/);
    } finally {
        harness.dispose();
    }
});

test("matching capabilities cannot cross a different Local Environment", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "efefefef-efef-efef-efef-efefefefefef",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "9494949494949494",
            session,
            presenceOverrides: {
                copilotHome: "C:\\other-user\\.copilot",
            },
        });

        const { tools } = await import("../extensions/porthole/lib/opensession.mjs");
        const result = await harness.invokeTool(
            tools(() => session),
            "porthole_focus_window",
            {},
        );

        assert.match(result, /uses a different Copilot home/);
        assert.deepEqual(window.requests, []);
    } finally {
        harness.dispose();
    }
});

test("a window in WSL that shares this filesystem is reachable", async () => {
    // The CLI running inside the same WSL distribution, container or Codespace
    // as the editor is a supported layout: every path matches and the transport
    // works. Refusing it on remoteName alone told the user to do the thing they
    // were already doing, and the genuinely split case never reaches here - a
    // companion on the other side of the boundary publishes its heartbeat into
    // that side's ~/.copilot, so it is already absent.
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "abababab-abab-abab-abab-abababababab",
            "/home/me/repo",
        );
        const window = harness.addWindow({
            windowId: "5151515151515151",
            session,
            presenceOverrides: { remoteName: "wsl" },
        });

        const { tools } = await import("../extensions/porthole/lib/opensession.mjs");
        const result = await harness.invokeTool(
            tools(() => session),
            "porthole_focus_window",
            {},
        );

        assert.doesNotMatch(result, /running in wsl/i);
        assert.equal(window.requests.length, 1, "the request must actually be delivered");
        assert.equal(window.requests[0].route, "focus");
    } finally {
        harness.dispose();
    }
});

test("a remote window on a different filesystem is still refused, and says where it is", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "6262626262626262",
            session,
            presenceOverrides: {
                remoteName: "wsl",
                copilotHome: "/home/me/.copilot",
            },
        });

        const { tools } = await import("../extensions/porthole/lib/opensession.mjs");
        const result = await harness.invokeTool(
            tools(() => session),
            "porthole_focus_window",
            {},
        );

        assert.match(result, /different Copilot home/);
        assert.match(result, /running in wsl/, "the remote name explains the mismatch");
        assert.deepEqual(window.requests, [], "nothing may be delivered across the boundary");
    } finally {
        harness.dispose();
    }
});

test("a visual route reaches every window the session owns", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "12121212-1212-1212-1212-121212121212",
            "C:\\repo",
        );
        const primary = harness.addWindow({
            windowId: "7171717171717171",
            session,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const secondary = harness.addWindow({
            windowId: "8282828282828282",
            session,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            { sessionId: session.id, sessionPath: session.dir, timeoutMs: 4000 },
        );

        assert.equal(result.ok, true);
        assert.equal(result.windowId, "7171717171717171", "the primary answers");
        assert.equal(primary.requests.length, 1, "the primary sees it");
        assert.equal(secondary.requests.length, 1, "and so does the secondary");
        assert.deepEqual(
            (result.alsoShownIn || []).map((w) => w.windowId),
            ["8282828282828282"],
        );
    } finally {
        harness.dispose();
    }
});

test("a route with side effects goes only to the primary", async () => {
    // Broadcasting workspace-add would edit two workspaces, and broadcasting a
    // preview would put an Apply prompt in front of the user twice.
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "13131313-1313-1313-1313-131313131313",
            "C:\\repo",
        );
        const primary = harness.addWindow({
            windowId: "9191919191919191",
            session,
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const secondary = harness.addWindow({
            windowId: "a2a2a2a2a2a2a2a2",
            session,
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "workspace-add",
            { folders: ["C:\\repo"] },
            { sessionId: session.id, sessionPath: session.dir, timeoutMs: 4000 },
        );

        assert.equal(result.ok, true);
        assert.equal(primary.requests.length, 1);
        assert.deepEqual(secondary.requests, [], "the secondary must be left alone");
        assert.equal(result.alsoShownIn, undefined);
    } finally {
        harness.dispose();
    }
});

test("an explicit windowId overrides the primary and never broadcasts", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "14141414-1414-1414-1414-141414141414",
            "C:\\repo",
        );
        const primary = harness.addWindow({
            windowId: "b3b3b3b3b3b3b3b3",
            session,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const secondary = harness.addWindow({
            windowId: "c4c4c4c4c4c4c4c4",
            session,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                windowId: "c4c4c4c4c4c4c4c4",
                timeoutMs: 4000,
            },
        );

        assert.equal(result.ok, true);
        assert.equal(result.windowId, "c4c4c4c4c4c4c4c4");
        assert.equal(secondary.requests.length, 1);
        assert.deepEqual(primary.requests, [], "naming a window means that window only");
    } finally {
        harness.dispose();
    }
});

test("a lost first guarded acknowledgement replays one retained execution", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "15151515-1515-1515-1515-151515151515",
            "C:\\repo",
        );
        let effects = 0;
        let dropped = false;
        const window = harness.addWindow({
            windowId: "d5d5d5d5d5d5d5d5",
            session,
            routes: {
                annotate: () => {
                    effects += 1;
                    return { ok: true, applied: 1 };
                },
            },
            ackWriter: ({ requestId, body, write }) => {
                if (!dropped && body.deliveryMode === "guarded") {
                    dropped = true;
                    return true;
                }
                return write(requestId, body);
            },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 1200,
            },
        );

        assert.equal(result.ok, true);
        assert.equal(result.deliveryMode, "guarded");
        assert.equal(result.disposition, "replayed");
        assert.equal(effects, 1);
        assert.equal(window.acknowledgements.length, 2);
        assert.equal(
            new Set(window.acknowledgements.map((entry) => entry.body.operationId)).size,
            1,
        );
        assert.equal(
            new Set(window.acknowledgements.map((entry) => entry.requestId)).size,
            2,
        );
    } finally {
        harness.dispose();
    }
});

test("a guarded acknowledgement with the wrong operation tuple is never accepted", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "26262626-2626-2626-2626-262626262626",
            "C:\\repo",
        );
        let effects = 0;
        const window = harness.addWindow({
            windowId: "a1a1a1a1a1a1a1a1",
            session,
            routes: {
                annotate: () => {
                    effects += 1;
                    return { ok: true, applied: 1 };
                },
            },
            ackWriter: ({ requestId, body, write }) =>
                write(requestId, { ...body, operationId: "wrong-operation" }),
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 900,
            },
        );

        assert.equal(result.reason, "unconfirmed");
        assert.match(result.error, /operationId did not match/);
        assert.equal(result.attempts, 3);
        assert.equal(effects, 1);
        assert.equal(window.acknowledgements.length, 3);
    } finally {
        harness.dispose();
    }
});

test("receiver admission refuses a window rebound after stale presence selection", async () => {
    const harness = await createPortholeHarness();
    try {
        const sessionA = harness.addSession(
            "16161616-1616-1616-1616-161616161616",
            "C:\\repo",
        );
        const sessionB = harness.addSession(
            "17171717-1717-1717-1717-171717171717",
            "C:\\repo",
        );
        const window = harness.addWindow({
            windowId: "e6e6e6e6e6e6e6e6",
            session: sessionA,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
        });

        window.vscode.workspace.workspaceFolders.splice(
            0,
            window.vscode.workspace.workspaceFolders.length,
            { uri: window.vscode.Uri.file("C:\\repo") },
            { uri: window.vscode.Uri.file(sessionB.dir) },
        );

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: sessionA.id,
                sessionPath: sessionA.dir,
                timeoutMs: 1000,
            },
        );

        assert.equal(result.ok, false);
        assert.equal(result.reason, "ownership-refused");
        assert.match(result.error, /different Copilot session/);
        assert.deepEqual(window.startedRequests, []);
    } finally {
        harness.dispose();
    }
});

test("deliberate unbound adoption can replay after the workspace becomes owned", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "18181818-1818-1818-1818-181818181818",
            "C:\\repo",
        );
        let dropped = false;
        const window = harness.addWindow({
            windowId: "f7f7f7f7f7f7f7f7",
            session: null,
            ackWriter: ({ requestId, body, write }) => {
                if (!dropped && body.deliveryMode === "guarded") {
                    dropped = true;
                    return true;
                }
                return write(requestId, body);
            },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "workspace-add",
            { folders: [session.repository, session.dir] },
            {
                windowId: window.windowId,
                sessionId: session.id,
                sessionPath: session.dir,
                adoptUnbound: true,
                timeoutMs: 1200,
            },
        );

        assert.equal(result.ok, true);
        assert.equal(result.disposition, "replayed");
        assert.equal(
            window.startedRequests.filter((request) => request.route === "workspace-add").length,
            1,
        );
        assert.equal(
            window.vscode.workspace.workspaceFolders.some(
                (folder) => folder.uri.fsPath === session.dir,
            ),
            true,
        );
    } finally {
        harness.dispose();
    }
});

test("guarded retries use at most three attempts under one deadline", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "19191919-1919-1919-1919-191919191919",
            "C:\\repo",
        );
        const never = new Promise(() => {});
        const window = harness.addWindow({
            windowId: "a8a8a8a8a8a8a8a8",
            session,
            routes: { annotate: () => never },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 900,
            },
        );

        assert.equal(result.reason, "unconfirmed");
        assert.equal(result.mayHaveExecuted, true);
        assert.equal(result.attempts, 3);
        assert.equal(window.operationHost.stats().operations[0].attempts, 3);
        assert.equal(window.startedRequests.length, 1);
    } finally {
        harness.dispose();
    }
});

test("interactive guarded work completes after caller abandonment without a duplicate prompt", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "24242424-2424-2424-2424-242424242424",
            "C:\\repo",
        );
        let executions = 0;
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const window = harness.addWindow({
            windowId: "dededededededede",
            session,
            routes: {
                preview: async () => {
                    executions += 1;
                    await held;
                    return { ok: true, applied: true };
                },
            },
            ackWriter: () => true,
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "preview",
            { title: "Held approval", changes: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 350,
            },
        );
        assert.equal(result.reason, "unconfirmed");
        assert.equal(executions, 1);

        release();
        await waitUntil(
            () =>
                window.operationHost.stats().activeExecutions === 0 &&
                window.acknowledgements.length === 2,
        );
        assert.equal(executions, 1);
        assert.equal(
            window.acknowledgements.length,
            2,
            "both admitted attempts receive the one completed outcome",
        );
    } finally {
        harness.dispose();
    }
});

test("silent broadcast secondaries share one deadline and receive initial work concurrently", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "20202020-2020-2020-2020-202020202020",
            "C:\\repo",
        );
        const primary = harness.addWindow({
            windowId: "b9b9b9b9b9b9b9b9",
            session,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const never = new Promise(() => {});
        const secondaryA = harness.addWindow({
            windowId: "cacacacacacacaca",
            session,
            routes: { annotate: () => never },
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });
        const secondaryB = harness.addWindow({
            windowId: "dbdbdbdbdbdbdbdb",
            session,
            routes: { annotate: () => never },
            presenceOverrides: { startedAt: "2026-01-01T10:10:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const startedAt = Date.now();
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 350,
            },
        );
        const elapsed = Date.now() - startedAt;

        assert.equal(result.ok, true, "the primary outcome remains authoritative");
        assert.equal(primary.startedRequests.length, 1);
        assert.equal(secondaryA.startedRequests.length, 1);
        assert.equal(secondaryB.startedRequests.length, 1);
        assert.ok(
            Math.abs(
                secondaryA.startedRequests[0].at -
                    secondaryB.startedRequests[0].at,
            ) < 100,
            "secondary initial deliveries should start together",
        );
        assert.equal(result.alsoShownIn.length, 2);
        assert.equal(
            result.alsoShownIn.every((entry) => entry.reason === "unconfirmed"),
            true,
        );
        assert.ok(elapsed >= 300, `returned before the shared wait completed (${elapsed}ms)`);
        assert.ok(elapsed < 650, `secondary waits multiplied the budget (${elapsed}ms)`);
    } finally {
        harness.dispose();
    }
});

test("a successful broadcast secondary never masks an unconfirmed primary", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "25252525-2525-2525-2525-252525252525",
            "C:\\repo",
        );
        const never = new Promise(() => {});
        harness.addWindow({
            windowId: "efefefefefefefef",
            session,
            routes: { annotate: () => never },
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        harness.addWindow({
            windowId: "f0f0f0f0f0f0f0f0",
            session,
            routes: { annotate: () => ({ ok: true, applied: 1 }) },
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 350,
            },
        );

        assert.equal(result.ok, false);
        assert.equal(result.reason, "unconfirmed");
        assert.equal(result.alsoShownIn.length, 1);
        assert.equal(result.alsoShownIn[0].ok, true);
    } finally {
        harness.dispose();
    }
});

test("an older addressed companion receives one explicit legacy attempt", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "21212121-2121-2121-2121-212121212121",
            "C:\\repo",
        );
        const never = new Promise(() => {});
        const window = harness.addWindow({
            windowId: "ecececececececec",
            session,
            capabilities: ["transport:addressed-inbox", "route:annotate"],
            routes: { annotate: () => never },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const result = await callCompanion(
            "annotate",
            { annotations: [] },
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 900,
            },
        );

        assert.equal(result.reason, "unconfirmed");
        assert.equal(result.deliveryMode, "legacy-single-shot");
        assert.equal(result.attempts, 1);
        assert.equal(window.startedRequests.length, 1);
        assert.equal(window.operationHost.stats().records, 0);
    } finally {
        harness.dispose();
    }
});

test("a vanished primary is not replaced or replayed to a same-session secondary", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "23232323-2323-2323-2323-232323232323",
            "C:\\repo",
        );
        const never = new Promise(() => {});
        const primary = harness.addWindow({
            windowId: "bcbcbcbcbcbcbcbc",
            session,
            routes: { "single-effect": () => never },
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const secondary = harness.addWindow({
            windowId: "cdcdcdcdcdcdcdcd",
            session,
            routes: { "single-effect": () => ({ ok: true }) },
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        const pending = callCompanion(
            "single-effect",
            {},
            {
                sessionId: session.id,
                sessionPath: session.dir,
                timeoutMs: 900,
            },
        );
        await waitUntil(() => primary.startedRequests.length === 1);
        rmSync(primary.presenceFile, { force: true });

        const result = await pending;
        assert.equal(result.reason, "unconfirmed");
        assert.equal(result.attempts, 1);
        assert.equal(primary.startedRequests.length, 1);
        assert.deepEqual(
            secondary.startedRequests,
            [],
            "the secondary must not be promoted inside an in-flight operation",
        );
    } finally {
        harness.dispose();
    }
});

test("Tour presentation routes are primary-only", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "22222222-2222-2222-2222-222222222222",
            "C:\\repo",
        );
        const primary = harness.addWindow({
            windowId: "fdfdfdfdfdfdfdfd",
            session,
            routes: {
                tour: () => ({ ok: true }),
                "tour-activate": () => ({ ok: true }),
                "tour-exit": () => ({ ok: true }),
            },
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const secondary = harness.addWindow({
            windowId: "abababababababab",
            session,
            routes: {
                tour: () => ({ ok: true }),
                "tour-activate": () => ({ ok: true }),
                "tour-exit": () => ({ ok: true }),
            },
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });

        const { callCompanion } = await import("../extensions/porthole/lib/companion.mjs");
        for (const route of ["tour", "tour-activate", "tour-exit"]) {
            const result = await callCompanion(
                route,
                {},
                {
                    sessionId: session.id,
                    sessionPath: session.dir,
                    timeoutMs: 1000,
                },
            );
            assert.equal(result.ok, true);
        }

        assert.deepEqual(
            primary.startedRequests.map((request) => request.route),
            ["tour", "tour-activate", "tour-exit"],
        );
        assert.deepEqual(secondary.startedRequests, []);
    } finally {
        harness.dispose();
    }
});
