// Reading the editor's Problems panel from the CLI.
//
// The agent otherwise has to infer compile and lint errors from the source,
// which means guessing at exactly the thing the language server already knows.
// This asks it.

import { callCompanion, explain } from "./companion.mjs";

const SEVERITIES = ["error", "warning", "info", "hint"];

function shorten(file, root) {
    if (!root) return file;
    const lower = String(file).toLowerCase();
    return lower.startsWith(root.toLowerCase()) ? file.slice(root.length).replace(/^[\\/]/, "") : file;
}

/**
 * Formats the diagnostics for the model.
 *
 * Grouped by file with a leading summary, because the counts alone often
 * answer the question ("is it clean yet?") without reading any of the detail.
 */
function format(result, root) {
    const { files, counts, truncated, annotations, scanned } = result;

    const total = SEVERITIES.reduce((sum, s) => sum + (counts[s] || 0), 0);
    if (total === 0) {
        const note = annotations
            ? ` (${annotations} porthole annotation(s) are on screen but are not problems)`
            : "";
        return `No problems reported in ${scanned} file(s)${note}.`;
    }

    const summary = SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ");
    const lines = [`${summary} across ${files.length} file(s):`, ""];

    for (const entry of files) {
        lines.push(shorten(entry.file, root));
        for (const d of entry.diagnostics) {
            const where = d.startLine === d.endLine ? `${d.startLine}` : `${d.startLine}-${d.endLine}`;
            const tag = d.source ? ` [${d.source}${d.code ? ` ${d.code}` : ""}]` : "";
            lines.push(`  ${d.severity.padEnd(7)} line ${where}${tag}  ${d.message}`);
        }
        lines.push("");
    }

    if (truncated) lines.push("(truncated - raise `limit` to see more)");
    return lines.join("\n").trim();
}

export async function problems(args = {}) {
    const root = process.cwd();
    const result = await callCompanion(
        "diagnostics",
        {
            scope: args.scope || "open",
            file: args.file,
            severities: Array.isArray(args.severities) ? args.severities : undefined,
            limit: args.limit,
        },
        { contextPath: root },
    );

    if (!result.ok) return `porthole: ${explain(result)}`;
    return format(result.result, root);
}

export function tools() {
    return [
        {
            name: "porthole_problems",
            description:
                "Read the errors and warnings the user's VS Code is currently reporting - the " +
                "real output of their language servers, linters and type checker. Call this " +
                "before guessing at compile or lint errors, after making an edit to check " +
                "whether it built cleanly, and when the user says something is broken without " +
                "quoting the error. It sees what their editor sees, which may include problems " +
                "no command-line build would surface. Requires the porthole companion VS Code " +
                "extension.",
            parameters: {
                type: "object",
                properties: {
                    scope: {
                        type: "string",
                        enum: ["open", "workspace", "file"],
                        description:
                            "'open' (default) covers the files on screen and is the most reliable, " +
                            "because the language server has definitely analysed those. " +
                            "'workspace' covers everything analysed so far, which in a cold " +
                            "window may be very little. 'file' needs `file`.",
                    },
                    file: {
                        type: "string",
                        description: "Absolute path, required when scope is 'file'.",
                    },
                    severities: {
                        type: "array",
                        items: { type: "string", enum: SEVERITIES },
                        description: "Defaults to errors and warnings only.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum entries to return (default 100, max 500).",
                    },
                },
            },
            handler: async (args) => problems(args),
        },
    ];
}
