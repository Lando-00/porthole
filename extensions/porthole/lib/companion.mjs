// Talking to the porthole companion VS Code extension.
//
// The CLI can only push a URI at the editor, which is fire-and-forget: spawning
// the launcher always "succeeds", so a window that never received the request
// looks exactly like one that acted on it. That is how a broken /cops could
// report success while opening nothing.
//
// So requests go out as a payload file plus a URI, and the companion writes a
// result file back:
//
//   write   <tmp>/porthole/req/<requestId>.json
//   fire    vscode-insiders://lando-00.porthole-companion/<route>?req=<requestId>
//   poll    <tmp>/porthole/ack/<requestId>.json
//
// No socket, no port, nothing listening in the background.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, copilotHome } from "./config.mjs";
import { pathsRelated, resolveEditorExe, resolveEditorTarget, whichEditor } from "./editor.mjs";

const ROOT = join(tmpdir(), "porthole");
const REQ_DIR = join(ROOT, "req");
const ACK_DIR = join(ROOT, "ack");
const POLL_INTERVAL_MS = 10;
const MAX_AGE_MS = 60 * 60 * 1000;

const EXTENSION_ID = "lando-00.porthole-companion";

function ensureDirs() {
    mkdirSync(REQ_DIR, { recursive: true });
    mkdirSync(ACK_DIR, { recursive: true });
}

/** Nothing here is read twice, so old files are just litter. */
function sweep() {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const dir of [REQ_DIR, ACK_DIR]) {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const file = join(dir, entry);
            try {
                if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
            } catch {
                // Racing another sweep is fine.
            }
        }
    }
}

/**
 * Live companion windows, newest heartbeat first.
 *
 * Each window writes ~/.copilot/porthole/companion-<pid>.json while it runs and
 * deletes it on shutdown; a crashed window leaves one behind, so the pid is
 * probed rather than trusted.
 */
export function findCompanions() {
    const dir = join(copilotHome(), "porthole");
    if (!existsSync(dir)) return [];

    const found = [];
    let entries = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.startsWith("companion-") || !entry.endsWith(".json")) continue;
        const file = join(dir, entry);
        let info;
        try {
            info = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            continue;
        }
        if (!info.pid) continue;
        try {
            process.kill(info.pid, 0);
        } catch {
            rmSync(file, { force: true }); // the window is gone
            continue;
        }
        found.push({ ...info, file });
    }

    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** The companion most likely to be showing `contextPath`, if any. */
export function findCompanion(contextPath) {
    const companions = findCompanions();
    if (companions.length === 0) return null;
    if (contextPath) {
        const match = companions.find((c) =>
            (c.workspaceFolders || []).some((wf) => wf && pathsRelated(contextPath, String(wf))),
        );
        if (match) return match;
    }
    return companions[0];
}

/**
 * Sends a request and waits for the companion's answer.
 *
 * Always resolves. `reason` says why it could not be done, so callers can fall
 * back to a plain `--goto` instead of claiming a success they cannot verify.
 */
export async function callCompanion(route, payload = null, options = {}) {
    const contextPath = options.contextPath || null;
    const timeoutMs = options.timeoutMs ?? config().companionTimeoutMs;

    const companion = findCompanion(contextPath);
    if (!companion) {
        // Without a heartbeat there is nothing listening, and firing the URI
        // anyway would just burn the whole timeout before saying so.
        return {
            ok: false,
            reason: "absent",
            error: "no VS Code window with the porthole companion is running",
        };
    }

    const exe = resolveCompanionExe(companion, contextPath);
    if (!exe) {
        return {
            ok: false,
            reason: "absent",
            error: "could not find the editor executable to deliver the request to",
        };
    }

    ensureDirs();
    sweep();

    const requestId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (payload !== null) {
        writeFileSync(join(REQ_DIR, `${requestId}.json`), JSON.stringify(payload), "utf8");
    }

    // The scheme has to match the build that will handle the URI, or it is
    // routed to a different editor - or nowhere at all.
    const scheme = companion.uriScheme || (/insiders/i.test(exe) ? "vscode-insiders" : "vscode");
    const uri = `${scheme}://${EXTENSION_ID}/${route}?req=${requestId}`;

    const spawnError = fire(exe, uri);
    if (spawnError) {
        return { ok: false, reason: "error", error: `could not reach the editor: ${spawnError}` };
    }

    const ack = await waitForAck(requestId, timeoutMs);
    if (!ack) {
        rmSync(join(REQ_DIR, `${requestId}.json`), { force: true });
        return {
            ok: false,
            reason: "timeout",
            error: `the companion did not answer within ${timeoutMs}ms`,
        };
    }

    return ack.ok ? ack : { ...ack, reason: ack.reason || "refused" };
}

/**
 * The executable that will deliver the URI.
 *
 * `--open-url` must go to the executable: the bin/*.cmd shim blocks without
 * ever delivering the URI. It must also be the same build the companion is
 * running in, or an Insiders URI is handed to Stable and quietly goes nowhere.
 */
function resolveCompanionExe(companion, contextPath) {
    const wantsInsiders = companion.uriScheme === "vscode-insiders";

    const target = resolveEditorTarget(contextPath);
    if (target) {
        const exe = resolveEditorExe(target.command);
        if (exe && /insiders/i.test(exe) === wantsInsiders) return exe;
    }

    // The chosen editor is the wrong build for this companion, so go looking
    // for the right one.
    const launcher = whichEditor(wantsInsiders ? "code-insiders" : "code");
    if (launcher) {
        const exe = resolveEditorExe(launcher);
        if (exe) return exe;
    }

    return target ? resolveEditorExe(target.command) : null;
}

function fire(exe, uri) {
    try {
        const child = spawn(exe, ["--open-url", "--", uri], {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            windowsHide: true,
        });
        child.on("error", () => {}); // reported through the ack timeout instead
        child.unref();
        return null;
    } catch (err) {
        return err.message;
    }
}

async function waitForAck(requestId, timeoutMs) {
    const file = join(ACK_DIR, `${requestId}.json`);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (existsSync(file)) {
            try {
                const parsed = JSON.parse(readFileSync(file, "utf8"));
                rmSync(file, { force: true });
                return parsed;
            } catch {
                // Half-written despite the atomic rename; try again next tick.
            }
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human-readable reason a companion call failed, for logging. */
export function explain(result) {
    if (result.ok) return "";
    if (result.reason === "absent") {
        return (
            "the porthole companion VS Code extension is not running. " +
            "Install it from vscode-extension/ (npm run install-local) and reload the window."
        );
    }
    if (result.reason === "timeout") {
        return `${result.error}. The window may be busy, or the companion needs a reload.`;
    }
    return result.error || "the companion refused the request";
}
