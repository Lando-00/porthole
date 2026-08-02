// Annotations and symbol lookup, for the agent and for the user.
//
// The agent-facing half is the point of this feature: an explanation in the
// terminal and the code in the editor stop being two separate things. The agent
// calls porthole_annotate while it writes, and the lines it is describing carry
// its reasoning in the gutter.
//
// The same operations are exposed as slash commands for when you want them
// yourself.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { callCompanion, explain } from "./companion.mjs";
import { config } from "./config.mjs";
import { projectRoot } from "./git.mjs";
import { launchEditor, resolveEditorTarget } from "./editor.mjs";

const SEVERITIES = ["info", "warn", "error", "note"];

/**
 * Resolves a path the way a person would mean it: as typed, relative to the
 * repository root, or relative to the working directory.
 */
export function resolveFile(file, cwd = process.cwd()) {
    if (!file) return null;
    if (isAbsolute(file) && existsSync(file)) return file;
    for (const base of [projectRoot(cwd), cwd]) {
        const candidate = join(base, file);
        if (existsSync(candidate)) return resolve(candidate);
    }
    return null;
}

function normaliseSeverity(value) {
    const severity = String(value || "info").toLowerCase();
    return SEVERITIES.includes(severity) ? severity : "info";
}

/**
 * Sends an annotation set to the companion.
 *
 * Returns a human-readable string either way: a tool that fails silently is
 * worse than one that says it cannot reach the editor.
 */
export async function annotate({ title, clearExisting, annotations, focus }, cwd = process.cwd()) {
    const entries = [];
    const missing = [];

    for (const raw of annotations || []) {
        const file = resolveFile(raw.file, cwd);
        if (!file) {
            missing.push(raw.file);
            continue;
        }
        entries.push({
            file,
            startLine: Number(raw.startLine) || 1,
            endLine: Number(raw.endLine) || Number(raw.startLine) || 1,
            severity: normaliseSeverity(raw.severity),
            message: raw.message ? String(raw.message) : "",
        });
    }

    if (entries.length === 0) {
        return missing.length
            ? `porthole: none of those files exist - ${missing.join(", ")}`
            : "porthole: no annotations were given.";
    }

    const result = await callCompanion(
        "annotate",
        {
            title: title || undefined,
            clearExisting: clearExisting !== false,
            focus: Number.isInteger(focus) ? focus : 0,
            annotations: entries,
        },
        { contextPath: dirname(entries[0].file) },
    );

    if (!result.ok) return `porthole: could not annotate - ${explain(result)}`;

    const where = entries
        .map((e) => `${short(e.file, cwd)}:${e.startLine}${e.endLine !== e.startLine ? `-${e.endLine}` : ""}`)
        .join(", ");

    return (
        `porthole: annotated ${result.applied} range(s) in VS Code (${where}).` +
        (missing.length ? ` Skipped missing file(s): ${missing.join(", ")}.` : "")
    );
}

export async function clearAnnotations() {
    const result = await callCompanion("annotate-clear");
    return result.ok
        ? "porthole: cleared all annotations."
        : `porthole: could not clear annotations - ${explain(result)}`;
}

/** Parses "file:10-20", "file:10:3", "file:10" or a bare symbol name. */
export function parseTarget(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;

    const range = /^(?<f>.+?):(?<s>\d+)-(?<e>\d+)$/.exec(value);
    if (range) {
        return {
            kind: "range",
            file: range.groups.f,
            startLine: Number(range.groups.s),
            endLine: Number(range.groups.e),
        };
    }

    const point = /^(?<f>.+?):(?<l>\d+)(?::(?<c>\d+))?$/.exec(value);
    if (point) {
        return {
            kind: "point",
            file: point.groups.f,
            startLine: Number(point.groups.l),
            column: point.groups.c ? Number(point.groups.c) : null,
        };
    }

    // A path that exists is a file; anything else is a name to look up.
    return existsSync(value) || resolveFile(value)
        ? { kind: "file", file: value }
        : { kind: "symbol", query: value };
}

/**
 * Opens a target and optionally annotates it.
 *
 * Symbols are resolved by the editor, which is the only thing that knows where
 * one begins and ends; a definition scan in the companion covers the case where
 * the language server has not warmed up.
 */
export async function goto(session, raw, message, cwd = process.cwd()) {
    const target = parseTarget(raw);
    if (!target) {
        return "porthole: usage - /goto <file>[:line[:col]], <file>:<start>-<end>, or a symbol name";
    }

    if (target.kind === "symbol") return gotoSymbol(session, target.query, message, cwd);

    const file = resolveFile(target.file, cwd);
    if (!file) return `porthole: file not found - ${target.file}`;

    if (target.kind === "range") {
        if (message) {
            return annotate(
                {
                    title: `porthole: ${short(file, cwd)}`,
                    annotations: [
                        {
                            file,
                            startLine: target.startLine,
                            endLine: target.endLine,
                            message,
                        },
                    ],
                },
                cwd,
            );
        }

        const result = await callCompanion(
            "reveal",
            { file, start: target.startLine, end: target.endLine },
            { contextPath: dirname(file) },
        );
        if (result.ok) {
            return `porthole: highlighted ${short(file, cwd)} lines ${result.startLine}-${result.endLine}.`;
        }

        openAtLine(session, file, target.startLine, cwd);
        return (
            `porthole: opened ${short(file, cwd)} at line ${target.startLine}, without the range selection.\n` +
            `  ${explain(result)}`
        );
    }

    const position =
        target.kind === "point"
            ? `:${target.startLine}${target.column ? `:${target.column}` : ""}`
            : "";
    openAtLine(session, file, target.kind === "point" ? target.startLine : null, cwd, position);
    return `porthole: opened ${short(file, cwd)}${position}.`;
}

async function gotoSymbol(session, query, message, cwd) {
    const result = await callCompanion(
        "symbol",
        { query, message: message || undefined, severity: "info" },
        { contextPath: cwd, timeoutMs: Math.max(config().companionTimeoutMs, 6000) },
    );

    if (result.ok) {
        const where = `${short(result.file, cwd)}:${result.startLine}-${result.endLine}`;
        return (
            `porthole: ${message ? "annotated" : "selected"} ${result.kind} '${result.name}' at ${where}.` +
            (result.source === "text-scan" ? " (found by definition scan)" : "")
        );
    }

    if (Array.isArray(result.candidates) && result.candidates.length > 0) {
        const list = result.candidates
            .map((c) => `  ${short(c.file, cwd)}:${c.startLine}  ${c.kind} ${c.name}`)
            .join("\n");
        return `porthole: '${query}' is ambiguous. Pick one:\n${list}`;
    }

    if (result.reason === "absent" && config().goto.symbolFallback) {
        return `porthole: could not look up '${query}' - ${explain(result)}`;
    }

    return `porthole: could not resolve '${query}' - ${result.error || explain(result)}`;
}

function openAtLine(session, file, line, cwd, position) {
    const target = resolveEditorTarget(dirname(file));
    if (!target) return;
    const arg = position !== undefined ? `${file}${position}` : line ? `${file}:${line}` : file;
    launchEditor(session, target.command, ["--reuse-window", "--goto", arg]);
}

function short(file, cwd) {
    const root = projectRoot(cwd);
    const value = String(file);
    return value.toLowerCase().startsWith(root.toLowerCase())
        ? value.slice(root.length + 1)
        : value;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * The descriptions are the whole interface for the model, so they say when to
 * use each tool rather than only what it does.
 *
 * `getSession` is a getter because the session object only exists once
 * joinSession has returned, and these definitions are its argument.
 */
export function tools(getSession) {
    return [
        {
            name: "porthole_annotate",
            description:
                "Mark specific lines of code in the user's VS Code window with a short explanation. " +
                "Use this whenever you are explaining, reviewing or diagnosing code the user can " +
                "open: annotate the exact lines you are describing so they can see what you mean " +
                "while they read your answer. Each annotation shows a coloured gutter icon and " +
                "your message on hover. Annotations replace the previous set by default, so send " +
                "one call per explanation with all of its ranges. Requires the porthole companion " +
                "VS Code extension.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "A short label for this set, e.g. 'why the launch fails'.",
                    },
                    clearExisting: {
                        type: "boolean",
                        description:
                            "Replace the current annotations (default true). Pass false to add to them.",
                    },
                    focus: {
                        type: "integer",
                        description: "Index of the annotation to scroll to. Defaults to the first.",
                    },
                    annotations: {
                        type: "array",
                        description: "The ranges to mark.",
                        items: {
                            type: "object",
                            properties: {
                                file: {
                                    type: "string",
                                    description:
                                        "Path to the file, absolute or relative to the repository root.",
                                },
                                startLine: { type: "integer", description: "1-based first line." },
                                endLine: {
                                    type: "integer",
                                    description: "1-based last line. Defaults to startLine.",
                                },
                                severity: {
                                    type: "string",
                                    enum: SEVERITIES,
                                    description:
                                        "info for explanation, warn for a risk, error for a bug, note for an aside.",
                                },
                                message: {
                                    type: "string",
                                    description:
                                        "What you want to say about these lines. Markdown is supported.",
                                },
                            },
                            required: ["file", "startLine"],
                        },
                    },
                },
                required: ["annotations"],
            },
            handler: async (args) => annotate(args),
        },
        {
            name: "porthole_goto",
            description:
                "Open something in the user's VS Code window: a file, a line, a line range, or a " +
                "symbol by name (a function, class or constant - porthole selects its whole body). " +
                "Use this when you want the user looking at a specific piece of code while you " +
                "talk about it. Pass a message to leave an annotation on it at the same time. " +
                "Requires the porthole companion VS Code extension for range selection and symbol " +
                "lookup.",
            parameters: {
                type: "object",
                properties: {
                    target: {
                        type: "string",
                        description:
                            "'src/app.ts', 'src/app.ts:42', 'src/app.ts:42:8', 'src/app.ts:42-90', or a symbol name such as 'handleGoto'.",
                    },
                    message: {
                        type: "string",
                        description:
                            "Optional note to attach to the resolved range, shown on hover in the editor.",
                    },
                },
                required: ["target"],
            },
            handler: async (args) => goto(getSession(), args.target, args.message),
        },
    ];
}
