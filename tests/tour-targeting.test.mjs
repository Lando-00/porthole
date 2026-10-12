import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { tools as tourTools } from "../extensions/porthole/lib/tour.mjs";
import { createPortholeHarness } from "./support/porthole-harness.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);

function tourRoutes() {
    return {
        tour: (payload) => ({
            ok: true,
            result: {
                tourId: payload.tourId || "tour",
                steps: payload.steps.length,
                active: false,
                library: 1,
            },
        }),
        "tour-list": () => ({ ok: true, result: { tours: [], activeTourId: null } }),
        "tour-activate": (payload) => ({
            ok: true,
            result: {
                tourId: payload.tourId,
                title: "Targeted Tour",
                steps: 1,
                current: payload.step || 0,
                revisionState: "same-revision",
            },
        }),
        "tour-exit": () => ({ ok: true, result: { library: 1 } }),
        "tour-delete": () => ({ ok: true }),
        "tour-archive": () => ({ ok: true }),
    };
}

test("CLI Tour presentation targets one named owned window and reports the actual target", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "44444444-4444-4444-4444-444444444444",
            process.cwd(),
        );
        const primary = harness.addWindow({
            windowId: "1111111111111111",
            session,
            routes: tourRoutes(),
            presenceOverrides: { startedAt: "2026-01-01T10:00:00.000Z" },
        });
        const secondary = harness.addWindow({
            windowId: "2222222222222222",
            session,
            routes: tourRoutes(),
            presenceOverrides: { startedAt: "2026-01-01T10:05:00.000Z" },
        });
        const definitions = tourTools(() => session);

        const created = await harness.invokeTool(definitions, "porthole_tour", {
            tourId: "targeted",
            title: "Targeted",
            activate: false,
            windowId: secondary.windowId,
            steps: [{
                file: THIS_FILE,
                startLine: 1,
                stepTitle: "Target",
                narration: "Only the selected window receives this.",
            }],
        });
        assert.match(created, new RegExp(`Target window: ${secondary.windowId}`));
        assert.equal(primary.startedRequests.length, 0);
        assert.equal(secondary.startedRequests.length, 1);
        assert.equal(secondary.startedRequests[0].route, "tour");
        assert.equal(
            secondary.startedRequests[0].payload.sourceRepo,
            process.cwd(),
        );

        const listed = await harness.invokeTool(definitions, "porthole_tours", {
            windowId: secondary.windowId,
        });
        assert.match(listed, /Tour Library is empty/);
        assert.match(listed, new RegExp(`Target window: ${secondary.windowId}`));

        for (const action of ["activate", "goto", "close"]) {
            const managed = await harness.invokeTool(definitions, "porthole_tour_manage", {
                action,
                tourId: "targeted",
                step: action === "goto" ? 0 : undefined,
                windowId: secondary.windowId,
            });
            assert.match(managed, new RegExp(`Target window: ${secondary.windowId}`));
        }

        const beforeDestructive = secondary.startedRequests.length;
        for (const action of ["archive", "unarchive", "delete"]) {
            const refused = await harness.invokeTool(definitions, "porthole_tour_manage", {
                action,
                tourId: "targeted",
                windowId: secondary.windowId,
            });
            assert.match(refused, /windowId is only valid for activate, goto, close, or diff/);
        }
        assert.equal(secondary.startedRequests.length, beforeDestructive);
    } finally {
        harness.dispose();
    }
});

test("an unavailable explicit Tour target does not fall back or auto-open another window", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "55555555-5555-5555-5555-555555555555",
            process.cwd(),
        );
        const primary = harness.addWindow({
            windowId: "3333333333333333",
            session,
            routes: tourRoutes(),
        });
        const definitions = tourTools(() => session);

        const result = await harness.invokeTool(definitions, "porthole_tour", {
            tourId: "missing-target",
            openIfClosed: true,
            windowId: "ffffffffffffffff",
            steps: [{
                file: THIS_FILE,
                startLine: 1,
                stepTitle: "Missing target",
                narration: "This must not reach the primary.",
            }],
        });

        assert.match(result, /requested VS Code window .* is no longer available/i);
        assert.deepEqual(primary.startedRequests, []);
    } finally {
        harness.dispose();
    }
});

test("CLI Tour formatting retains legacy single-shot delivery notes", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "66666666-6666-6666-6666-666666666666",
            process.cwd(),
        );
        harness.addWindow({
            windowId: "4444444444444444",
            session,
            capabilities: ["transport:addressed-inbox", "route:tour-list"],
            routes: {
                "tour-list": () => ({
                    ok: true,
                    result: { tours: [], activeTourId: null },
                }),
            },
        });
        const result = await harness.invokeTool(
            tourTools(() => session),
            "porthole_tours",
            {},
        );

        assert.match(result, /Legacy single-shot delivery/);
        assert.match(result, /Target window: 4444444444444444/);
    } finally {
        harness.dispose();
    }
});

test("CLI Tour formatting distinguishes durable publication from failed display", async () => {
    const harness = await createPortholeHarness();
    try {
        const session = harness.addSession(
            "77777777-7777-7777-7777-777777777777",
            process.cwd(),
        );
        harness.addWindow({
            windowId: "5555555555555555",
            session,
            routes: {
                tour: () => ({
                    ok: false,
                    reason: "requires-save",
                    error: "save the target file before showing this Tour step",
                    result: {
                        tourId: "dirty-tour",
                        saved: true,
                        displayed: false,
                    },
                }),
            },
        });

        const result = await harness.invokeTool(
            tourTools(() => session),
            "porthole_tour",
            {
                tourId: "dirty-tour",
                steps: [{
                    file: THIS_FILE,
                    startLine: 1,
                    stepTitle: "Dirty target",
                    narration: "The publication succeeds before display is attempted.",
                }],
            },
        );

        assert.match(result, /saved 'dirty-tour' in the Tour Library, but did not display it/);
        assert.match(result, /save the target file/);
        assert.match(result, /Target window: 5555555555555555/);
    } finally {
        harness.dispose();
    }
});
