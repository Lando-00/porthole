// Walkthroughs, driven from the CLI.
//
// The model already explains code well in prose. What it cannot do in prose is
// put the explanation next to the code and let someone walk through it at their
// own pace. That is what this is for.
//
// A library, not a single tour: a change worth explaining rarely has one
// thread, and one fifty-step walk through a pull request is a list, not an
// explanation. Many tours can be loaded; one is being walked.
//
// The tool surface is split by the *shape of its parameters*, not by verb
// count. One tool with an `action` enum whose other parameters are conditional
// on it produces malformed calls; six near-identical tools waste context and
// make the model choose. Creating takes a deep nested array, listing takes
// almost nothing, and activate/close/delete/goto all take just an id - so
// three tools, and the last four verbs share one.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { callCompanion, explain } from "./companion.mjs";
import { ensureCompanion } from "./ensure.mjs";

const MAX_STEPS = 50;

/**
 * Resolves a step's file against the working directory.
 *
 * Done here as well as in the companion so a bad path is reported to the model
 * as part of the tool result, where it can fix it, rather than only appearing
 * in the editor.
 */
function resolveStep(step, root) {
    const file = String(step.file || "");
    if (!file) return null;
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    return existsSync(absolute) ? absolute : null;
}

// --- creating ---------------------------------------------------------------

export async function tour(args = {}, getSession = null) {
    const root = process.cwd();
    const incoming = Array.isArray(args.steps) ? args.steps : [];
    if (incoming.length === 0) return "porthole: a tour needs at least one step.";
    if (incoming.length > MAX_STEPS) {
        return (
            `porthole: a tour is limited to ${MAX_STEPS} steps. ` +
            "Split it into several tours - that is what the library is for."
        );
    }

    const steps = [];
    const unresolved = [];
    for (const [i, step] of incoming.entries()) {
        const file = resolveStep(step, root);
        if (!file) {
            unresolved.push(`step ${i + 1}: ${step.file || "(no file)"}`);
            continue;
        }
        steps.push({ ...step, file });
    }

    if (steps.length === 0) {
        return `porthole: none of those files exist - ${unresolved.join(", ")}`;
    }

    const { note: openNote } = await ensureCompanion(getSession, {
        openIfClosed: args.openIfClosed === true,
    });

    const result = await callCompanion(
        "tour",
        {
            tourId: args.tourId,
            title: args.title,
            steps,
            activate: args.activate !== false,
            replace: args.replace,
        },
        { contextPath: root },
    );

    if (!result.ok) return `porthole: ${explain(result)}${openNote}`;

    const skipped = [
        ...unresolved,
        ...(result.result?.skipped || []).map((s) => `step ${s.index + 1}: ${s.reason}`),
    ];

    const { tourId, replaced, active, library } = result.result || {};
    const count = result.result?.steps ?? steps.length;

    let message =
        `porthole: ${replaced ? "replaced" : "created"} a ${count}-step walkthrough` +
        (args.title ? ` - "${args.title}"` : "") +
        ` (id: ${tourId}).`;

    if (active) {
        message +=
            " It is now the active tour. The user can step through it with the Next/Prev " +
            "controls above the code, Alt+] and Alt+[, or the porthole sidebar.";
    } else {
        message +=
            " It is in the library but not active - its steps appear in the Problems panel, " +
            "and the user can start it from the porthole sidebar.";
    }

    if (library > 1) message += ` ${library} tours are now loaded.`;
    if (skipped.length) message += `\nSkipped: ${skipped.join("; ")}`;

    return message;
}

// --- listing ----------------------------------------------------------------

export async function tours(args = {}) {
    const result = await callCompanion(
        "tour-list",
        { includeSteps: args.includeSteps === true, repo: args.repo, limit: args.limit },
        { contextPath: process.cwd() },
    );
    if (!result.ok) return `porthole: ${explain(result)}`;

    const list = result.result?.tours || [];
    if (list.length === 0) {
        return "porthole: no tours are loaded and none are saved for this machine.";
    }

    const lines = [`porthole: ${list.length} tour(s).`];
    for (const t of list) {
        const bits = [`${t.steps} steps`];
        if (t.active) bits.push("ACTIVE");
        else if (t.loaded) bits.push("loaded");
        else bits.push("saved, not loaded");
        if (t.branch) bits.push(t.branch);

        const stale = describeStaleness(t.staleness);
        if (stale) bits.push(stale);

        lines.push(`  ${t.tourId} - "${t.title}" (${bits.join(", ")})`);

        for (const s of t.stepDetail || []) {
            lines.push(
                `      ${s.startLine}-${s.endLine} ${s.file} - ${s.stepTitle}` +
                    (s.status && s.status !== "resolved" ? ` [${s.status}]` : ""),
            );
        }
    }

    if (list.some((t) => t.staleness && (t.staleness.changed || t.staleness.missing))) {
        lines.push(
            "\nA tour with changed or missing steps was written against older code. " +
                "Say so before walking the user through it, and offer to rebuild it.",
        );
    }

    return lines.join("\n");
}

function describeStaleness(s) {
    if (!s) return "";
    const parts = [];
    if (s.shifted) parts.push(`${s.shifted} moved`);
    if (s.changed) parts.push(`${s.changed} changed`);
    if (s.missing) parts.push(`${s.missing} gone`);
    return parts.length ? `stale: ${parts.join(", ")}` : "still current";
}

// --- activate / close / delete / goto ---------------------------------------

export async function manage(args = {}) {
    const action = String(args.action || "activate");
    const tourId = String(args.tourId || "").trim();

    if (action !== "close" && !tourId) {
        return "porthole: which tour? Call porthole_tours to see the ids.";
    }

    if (action === "activate" || action === "goto") {
        const result = await callCompanion(
            "tour-activate",
            { tourId, step: Number.isInteger(args.step) ? args.step : undefined },
            { contextPath: process.cwd() },
        );
        if (!result.ok) return `porthole: ${explain(result)}`;

        const { title, steps, current, staleness } = result.result || {};
        let message = `porthole: now walking "${title}" (${steps} steps), at step ${(current ?? 0) + 1}.`;
        const stale = describeStaleness(staleness);
        if (staleness && stale !== "still current") {
            message +=
                `\nThis tour came off disk and ${stale}. Tell the user before walking them ` +
                "through it - the narration was written about code that has since moved on.";
        }
        return message;
    }

    if (action === "close") {
        const result = await callCompanion("tour-exit", tourId ? { tourId } : {}, {
            contextPath: process.cwd(),
        });
        if (!result.ok) return `porthole: ${explain(result)}`;
        return (
            `porthole: stopped walking ${tourId ? `'${tourId}'` : "the active tour"}. ` +
            "It is still in the library and still saved - use delete to remove it."
        );
    }

    if (action === "delete") {
        const result = await callCompanion("tour-delete", { tourId }, { contextPath: process.cwd() });
        if (!result.ok) return `porthole: ${explain(result)}`;
        return `porthole: deleted '${tourId}' from the library and from disk.`;
    }

    return `porthole: '${action}' is not one of activate, goto, close, delete.`;
}

/** The pre-library name, kept so /tour-exit keeps working. */
export async function exitTour() {
    const result = await callCompanion("tour-exit", {}, { contextPath: process.cwd() });
    return result.ok
        ? "porthole: stopped walking the active tour. It stays in the library."
        : `porthole: ${explain(result)}`;
}

// --- the model-facing surface ------------------------------------------------

const STEP_SCHEMA = {
    type: "object",
    properties: {
        file: {
            type: "string",
            description: "Absolute path, or relative to the working directory.",
        },
        startLine: { type: "integer", description: "First line of this step, 1-based." },
        endLine: { type: "integer", description: "Last line; defaults to startLine." },
        stepTitle: {
            type: "string",
            description: "A few words naming this step, shown in the CodeLens and the sidebar.",
        },
        narration: {
            type: "string",
            description: "What you want to say about this step. Shown on hover and in the lens.",
        },
        severity: {
            type: "string",
            enum: ["info", "warn", "error", "note"],
            description: "Styling only: info, warn, error or note.",
        },
    },
    required: ["file", "startLine", "stepTitle"],
};

export function tools(getSession = null) {
    return [
        {
            name: "porthole_tour",
            description:
                "Walk the user through code as an ordered, narrated tour in their VS Code " +
                "window. Each step highlights a range and shows your narration in a CodeLens " +
                "directly above it, with Next/Prev controls, so they follow the path at their " +
                "own pace. Use this when explaining how something works across several places: " +
                "a request's path through a system, why a bug happens, what a refactor will " +
                "touch, or how to find your way around an unfamiliar module.\n\n" +
                "Many tours can be loaded at once, and one is active. For a pull request or " +
                "any change with several independent threads, create ONE TOUR PER THREAD - the " +
                "auth path, the error handling, the migration - rather than one long tour. " +
                "Call porthole_tours first so you extend the library instead of duplicating it.\n\n" +
                "A step is a place worth stopping, not every mention of the subject. Order the " +
                "steps the way you would narrate them aloud. Keep each narration short - it is " +
                "read in a two-line lens, so say what is needed to understand this step and " +
                "stop. Requires the porthole companion VS Code extension.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description:
                            "What this walkthrough shows, e.g. 'how a request reaches the editor'. " +
                            "Used as the tour's name everywhere the user sees it.",
                    },
                    tourId: {
                        type: "string",
                        description:
                            "A short slug identifying this tour, e.g. 'auth-path'. Derived from " +
                            "the title when omitted. Reuse an id to replace that tour.",
                    },
                    steps: {
                        type: "array",
                        description: "The steps, in the order the user should follow them.",
                        items: STEP_SCHEMA,
                    },
                    activate: {
                        type: "boolean",
                        description:
                            "Start walking it immediately. Default true. Pass false when adding " +
                            "several tours at once, so you do not drag the user between files - " +
                            "then activate the one you want to talk about first.",
                    },
                    replace: {
                        type: "boolean",
                        description:
                            "Allow overwriting a tour that already has this id. Default true. " +
                            "Pass false to be told about a clash instead.",
                    },
                    openIfClosed: {
                        type: "boolean",
                        description:
                            "Open an editor window if none is running. Default false. Only set " +
                            "this when the user has explicitly asked to be walked through " +
                            "something, e.g. the /walkthrough command - it takes over their " +
                            "screen, so never set it on a tour you decided to build yourself.",
                    },
                },
                required: ["steps"],
            },
            handler: async (args) => tour(args, getSession),
        },

        {
            name: "porthole_tours",
            description:
                "List the walkthroughs available in the user's VS Code window: which are " +
                "loaded, which one they are walking, and which are saved from earlier sessions " +
                "but not yet loaded.\n\n" +
                "Call this before creating a tour, so you add to the library instead of " +
                "duplicating it, and whenever the user refers to a walkthrough you did not " +
                "create in this conversation.\n\n" +
                "It also reports how many steps have gone stale - moved, changed, or pointing " +
                "at a file that no longer exists - so you can tell whether a tour still " +
                "describes the current code before pointing the user at it. A tour with " +
                "changed steps was written against older code and its narration may now be " +
                "wrong; say so rather than walking them through it.",
            parameters: {
                type: "object",
                properties: {
                    includeSteps: {
                        type: "boolean",
                        description:
                            "Include each tour's steps and where they now point. Verbose; use " +
                            "when you need to reason about a specific tour's contents.",
                    },
                    repo: {
                        type: "string",
                        description: "Only tours saved against this repository path.",
                    },
                    limit: { type: "integer", description: "Maximum tours to return. Default 50." },
                },
            },
            handler: async (args) => tours(args),
        },

        {
            name: "porthole_tour_manage",
            description:
                "Switch, close or delete a walkthrough in the user's VS Code window, by id.\n\n" +
                "  activate - make this the tour the user is walking, loading it from disk if " +
                "needed. This is how you pick up a review saved by an earlier session.\n" +
                "  goto     - activate it and jump straight to a particular step.\n" +
                "  close    - stop walking it. It stays in the library, in the Problems panel " +
                "and on disk.\n" +
                "  delete   - remove it from the library and from disk. Destructive; only when " +
                "the user asks.\n\n" +
                "Use porthole_tours first to find the id. Closing is not deleting - prefer " +
                "close unless the user actually wants the walkthrough gone.",
            parameters: {
                type: "object",
                properties: {
                    tourId: {
                        type: "string",
                        description: "The tour's id, as reported by porthole_tours.",
                    },
                    action: {
                        type: "string",
                        enum: ["activate", "goto", "close", "delete"],
                        description: "What to do with it. Defaults to activate.",
                    },
                    step: {
                        type: "integer",
                        description: "For 'goto': the step to jump to, 0-based.",
                    },
                },
                required: ["tourId"],
            },
            handler: async (args) => manage(args),
        },
    ];
}
