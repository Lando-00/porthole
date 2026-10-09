import { resolve } from "node:path";

import { callCompanion, explain } from "./companion.mjs";
import { companionOptions } from "./target.mjs";
import { withDeliveryNotes } from "./delivery-notes.mjs";

const MAX_WAIT_MS = 30 * 60 * 1000;

function normaliseChanges(changes, cwd) {
    if (!Array.isArray(changes)) return [];
    return changes.map((change) => {
        const file = String(change?.file || "").trim();
        return {
            file: file ? resolve(cwd, file) : null,
            content: typeof change?.content === "string" ? change.content : null,
        };
    });
}

export async function previewChanges(args, sessionSource) {
    const cwd = process.cwd();
    const changes = normaliseChanges(args?.changes, cwd);
    if (changes.length === 0) return "porthole: no proposed changes were supplied.";
    if (changes.some((change) => !change.file || change.content === null)) {
        return "porthole: every proposed change needs a file and its complete new content.";
    }

    const result = await callCompanion(
        "preview",
        { title: args?.title || "Proposed changes", changes },
        {
            ...companionOptions(cwd, sessionSource),
            timeoutMs: MAX_WAIT_MS,
        },
    );
    if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
    if (result.cancelled || result.applied === false) {
        return withDeliveryNotes(result, "porthole: the user cancelled the proposed changes; no project files were changed.");
    }
    return withDeliveryNotes(result,
        `porthole: applied ${result.files.length} reviewed file change` +
        `${result.files.length === 1 ? "" : "s"} from VS Code.\n` +
        result.files.map((file) => `  ${file}`).join("\n")
    );
}

export function tools(getSession) {
    return [
        {
            name: "porthole_preview_changes",
            description:
                "Preview proposed file changes as editable VS Code diffs before applying them. " +
                "Use this when the user explicitly asks to review or approve changes before " +
                "they are written, or when a risky/broad change deserves human inspection. " +
                "Provide each file's complete proposed new content. The tool opens the exact " +
                "window bound to this Copilot session, lets the user edit the PROPOSED side, " +
                "and writes only after they click Apply reviewed changes. It refuses if a " +
                "target changed or has unsaved edits while the preview was open.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "Short description of the proposed change set.",
                    },
                    changes: {
                        type: "array",
                        minItems: 1,
                        maxItems: 20,
                        items: {
                            type: "object",
                            properties: {
                                file: {
                                    type: "string",
                                    description: "Absolute path, or path relative to the CLI cwd.",
                                },
                                content: {
                                    type: "string",
                                    description: "Complete proposed contents of the file.",
                                },
                            },
                            required: ["file", "content"],
                        },
                    },
                },
                required: ["changes"],
            },
            handler: (args) => previewChanges(args, getSession),
        },
    ];
}
