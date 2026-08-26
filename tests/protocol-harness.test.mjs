import assert from "node:assert/strict";
import test from "node:test";

import { createPortholeHarness } from "./support/porthole-harness.mjs";

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
