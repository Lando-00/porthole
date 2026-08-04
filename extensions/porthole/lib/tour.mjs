// Walkthroughs, driven from the CLI.
//
// The model already explains code well in prose. What it cannot do in prose is
// put the explanation next to the code and let someone walk through it at their
// own pace. That is what this is for.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { callCompanion, explain } from "./companion.mjs";

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

export async function tour(args = {}) {
    const root = process.cwd();
    const incoming = Array.isArray(args.steps) ? args.steps : [];
    if (incoming.length === 0) return "porthole: a tour needs at least one step.";
    if (incoming.length > MAX_STEPS) {
        return `porthole: a tour is limited to ${MAX_STEPS} steps.`;
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

    const result = await callCompanion(
        "tour",
        { title: args.title, steps, start: args.start !== false },
        { contextPath: root },
    );

    if (!result.ok) return `porthole: ${explain(result)}`;

    const skipped = [
        ...unresolved,
        ...(result.result?.skipped || []).map((s) => `step ${s.index + 1}: ${s.reason}`),
    ];

    const count = result.result?.steps ?? steps.length;
    return (
        `porthole: started a ${count}-step walkthrough in VS Code` +
        (args.title ? ` - "${args.title}"` : "") +
        ". The user can step through it with the Next/Prev controls above the code, " +
        "Alt+] and Alt+[, or the porthole sidebar." +
        (skipped.length ? `\nSkipped: ${skipped.join("; ")}` : "")
    );
}

export async function exitTour() {
    const result = await callCompanion("tour-exit", null, { contextPath: process.cwd() });
    return result.ok ? "porthole: ended the walkthrough." : `porthole: ${explain(result)}`;
}

export function tools() {
    return [
        {
            name: "porthole_tour",
            description:
                "Walk the user through code as an ordered, narrated tour in their VS Code " +
                "window. Each step highlights a range and shows your narration in a CodeLens " +
                "directly above it, with Next/Prev controls, so they follow the path at their " +
                "own pace. Use this instead of a wall of prose whenever you are explaining how " +
                "something works across several places: a request's path through a system, why " +
                "a bug happens, what a refactor will touch, or how to find your way around an " +
                "unfamiliar module. Order the steps the way you would narrate them. Requires " +
                "the porthole companion VS Code extension.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description:
                            "What this walkthrough shows, e.g. 'how a request reaches the editor'.",
                    },
                    steps: {
                        type: "array",
                        description: "The steps, in the order the user should follow them.",
                        items: {
                            type: "object",
                            properties: {
                                file: {
                                    type: "string",
                                    description: "Absolute path, or relative to the working directory.",
                                },
                                startLine: {
                                    type: "integer",
                                    description: "First line of this step, 1-based.",
                                },
                                endLine: {
                                    type: "integer",
                                    description: "Last line; defaults to startLine.",
                                },
                                stepTitle: {
                                    type: "string",
                                    description:
                                        "A few words naming this step, shown in the CodeLens and the sidebar.",
                                },
                                narration: {
                                    type: "string",
                                    description:
                                        "What you want to say about this step. Shown on hover and in the lens.",
                                },
                                severity: {
                                    type: "string",
                                    enum: ["info", "warn", "error", "note"],
                                    description: "Styling only: info, warn, error or note.",
                                },
                            },
                            required: ["file", "startLine", "stepTitle"],
                        },
                    },
                },
                required: ["steps"],
            },
            handler: async (args) => tour(args),
        },
    ];
}
