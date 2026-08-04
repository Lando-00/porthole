// porthole configuration.
//
// One file, ~/.copilot/porthole.json, all keys optional:
//
//   {
//     "editor": "insiders",        // insiders | stable | cursor | windsurf | auto | <abs path>
//     "preferConnectedIde": true,  // drive the window you are already in
//     "workspaceDir": null,        // where generated .code-workspace files go
//     "companionTimeoutMs": 2000,  // how long to wait for a companion ack
//     "goto": { "symbolFallback": true }
//   }
//
// The point is the `editor` key: preferring Insiders over stable is a personal
// choice and should not require an environment variable.
//
// A broken config must never throw. These functions run inside every command
// handler, and an exception here would take the whole session's commands with
// it, for the sake of a typo in a settings file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
    editor: "auto",
    preferConnectedIde: true,
    workspaceDir: null,
    companionTimeoutMs: 2000,
    // How a selection sent from VS Code is delivered. "enqueue" waits for the
    // current turn to finish; "immediate" steers mid-turn.
    sendMode: "enqueue",
    goto: { symbolFallback: true },
};

export function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && existsSync(configured)) return configured;
    return join(homedir(), ".copilot");
}

export function configPath() {
    return join(copilotHome(), "porthole.json");
}

let cached = null;

/**
 * Loads and validates the config.
 *
 * Returns the merged values plus whatever went wrong, so `/porthole` can show
 * the problem instead of silently using defaults.
 */
export function loadConfig({ reload = false } = {}) {
    if (cached && !reload) return cached;

    const path = configPath();
    const result = {
        path,
        exists: existsSync(path),
        errors: [],
        warnings: [],
        values: { ...DEFAULTS, goto: { ...DEFAULTS.goto } },
    };

    if (result.exists) {
        let raw;
        try {
            raw = readFileSync(path, "utf8");
        } catch (err) {
            result.errors.push(`could not read ${path}: ${err.message}`);
            cached = result;
            return result;
        }

        let parsed;
        try {
            parsed = JSON.parse(stripBom(raw));
        } catch (err) {
            result.errors.push(`${path} is not valid JSON: ${err.message}`);
            cached = result;
            return result;
        }

        merge(result, parsed);
    }

    cached = result;
    return result;
}

function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function merge(result, parsed) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        result.errors.push("the config must be a JSON object");
        return;
    }

    const values = result.values;

    if ("editor" in parsed) {
        if (typeof parsed.editor === "string" && parsed.editor.trim()) {
            values.editor = parsed.editor.trim();
        } else {
            result.warnings.push("'editor' must be a string; using auto");
        }
    }

    if ("preferConnectedIde" in parsed) {
        if (typeof parsed.preferConnectedIde === "boolean") {
            values.preferConnectedIde = parsed.preferConnectedIde;
        } else {
            result.warnings.push("'preferConnectedIde' must be true or false; using true");
        }
    }

    if ("workspaceDir" in parsed) {
        if (parsed.workspaceDir === null || typeof parsed.workspaceDir === "string") {
            values.workspaceDir = parsed.workspaceDir || null;
        } else {
            result.warnings.push("'workspaceDir' must be a string or null; using the temp folder");
        }
    }

    if ("companionTimeoutMs" in parsed) {
        const n = Number(parsed.companionTimeoutMs);
        if (Number.isFinite(n) && n >= 0) {
            values.companionTimeoutMs = Math.min(n, 30000);
        } else {
            result.warnings.push("'companionTimeoutMs' must be a non-negative number; using 2000");
        }
    }

    if ("goto" in parsed && parsed.goto && typeof parsed.goto === "object") {
        if (typeof parsed.goto.symbolFallback === "boolean") {
            values.goto.symbolFallback = parsed.goto.symbolFallback;
        }
    }

    for (const key of Object.keys(parsed)) {
        // "//" keys are the conventional way to comment JSON, and the shipped
        // example uses them.
        if (key.startsWith("//")) continue;
        if (!(key in DEFAULTS)) result.warnings.push(`unknown key '${key}'`);
    }
}

/**
 * Reports config problems once per session.
 *
 * Ephemeral, because a non-ephemeral log is written into the session's event
 * history and replayed on every resume - which is how the "porthole ready"
 * banner ended up multiplying.
 */
let reported = false;

export async function reportConfigProblems(session) {
    if (reported) return;
    reported = true;

    const config = loadConfig();
    const problems = [...config.errors, ...config.warnings];
    if (problems.length === 0) return;

    await session.log(`porthole: ${config.path}\n  ${problems.join("\n  ")}`, {
        ephemeral: true,
        level: config.errors.length ? "warning" : "info",
    });
}

export function config() {
    return loadConfig().values;
}
