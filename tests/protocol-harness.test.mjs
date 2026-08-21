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
