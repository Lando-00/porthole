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
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { config, copilotHome } from "./config.mjs";
import { connectedIdes, pathsRelated, resolveEditorExe, resolveEditorTarget, whichEditor } from "./editor.mjs";

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
        // ESRCH means the window is gone; EPERM means it exists but is not
        // ours to signal, which happens when one side runs elevated. Deleting
        // on EPERM would hide a perfectly healthy window.
        try {
            process.kill(info.pid, 0);
        } catch (err) {
            if (err.code !== "EPERM") {
                rmSync(file, { force: true }); // the window is gone
                continue;
            }
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
 * Why a window cannot be reached, or null when it can.
 *
 * The two halves only meet on a shared filesystem. A window running in WSL, a
 * container or over SSH looks perfectly healthy from both sides while writing
 * to a completely different disk, so every request would burn the full timeout
 * and then blame the window for being busy. Saying so up front is the whole
 * point of publishing these fields.
 */
function unreachable(companion) {
    if (companion.remoteName) {
        return (
            `the VS Code window is running in ${companion.remoteName}, so it cannot see this ` +
            "machine's files. Run the CLI inside the same environment."
        );
    }
    if (companion.tmpdir && !samePath(companion.tmpdir, tmpdir())) {
        return (
            `the VS Code window uses a different temp directory (${companion.tmpdir}), so it ` +
            "cannot see this session's requests."
        );
    }
    if (companion.copilotHome && !samePath(companion.copilotHome, copilotHome())) {
        return (
            `the VS Code window uses a different Copilot home (${companion.copilotHome}). ` +
            "Set COPILOT_HOME to the same value in both."
        );
    }
    return null;
}

function samePath(a, b) {
    return String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();
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

    // Checked before firing: an unreachable pairing would otherwise burn the
    // whole timeout and then report the wrong cause.
    const blocked = unreachable(companion);
    if (blocked) return { ok: false, reason: "refused", error: blocked };

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
        // The presence file said a window was there and no window answered, so
        // it was wrong. Forget it.
        //
        // A pid check cannot tell a live VS Code from whatever else inherited
        // that pid after a reboot - and a hard power-off leaves the file behind
        // to be inherited, because nothing gets to run on the way down. Without
        // this, that stale file misleads every command from then on: each one
        // burns the full timeout and then blames a window that is not there.
        //
        // Safe against a merely busy window, because the companion republishes
        // its presence every time it handles a request, and on window focus.
        forget(companion);
        return {
            ok: false,
            reason: "timeout",
            error: `the companion did not answer within ${timeoutMs}ms`,
        };
    }

    return ack.ok ? ack : { ...ack, reason: ack.reason || "refused" };
}

/**
 * Drops a presence file that has been proved wrong.
 *
 * Deliberately quiet: this is housekeeping on the way to reporting a failure
 * the caller already knows about.
 */
function forget(companion) {
    if (!companion?.pid) return;
    try {
        rmSync(join(copilotHome(), "porthole", `companion-${companion.pid}.json`), { force: true });
    } catch {
        // Not ours to delete, or already gone.
    }
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
    if (result.reason === "absent") return explainAbsent();
    if (result.reason === "timeout") {
        return (
            `${result.error}. Either the window is busy, or that record was left behind by a ` +
            "window that no longer exists - it has been dropped, so try again."
        );
    }
    return result.error || "the companion refused the request";
}

/**
 * Where VS Code keeps installed extensions.
 *
 * Both flavours, because someone may run the CLI against stable while Insiders
 * is what has the extension, or the reverse.
 */
function extensionDirs() {
    const home = homedir();
    return [join(home, ".vscode", "extensions"), join(home, ".vscode-insiders", "extensions")];
}

/**
 * Whether the companion is installed on disk, regardless of whether it is
 * currently running.
 *
 * A positive answer is trustworthy; a negative one is only probably right,
 * since `--extensions-dir` can move the folder. The messages below are worded
 * to match that asymmetry.
 */
export function isCompanionInstalled() {
    for (const dir of extensionDirs()) {
        let entries = [];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        if (entries.some((e) => e.toLowerCase().startsWith(`${EXTENSION_ID}-`))) return true;
    }
    return false;
}

/**
 * Why nothing answered.
 *
 * "No heartbeat" has three quite different causes and they need three different
 * answers. Telling someone to install an extension they already have - which is
 * what this used to do - sends them to check the one thing that is fine, and
 * the instruction it gave was the *developer* one (`npm run install-local`) at
 * that.
 */
function explainAbsent() {
    if (!isCompanionInstalled()) {
        return (
            "the porthole companion VS Code extension does not appear to be installed.\n" +
            "  Install it:  code --install-extension Lando-00.porthole-companion\n" +
            "  (or code-insiders), then open a new window."
        );
    }

    // Installed. So either VS Code is not open, or it is open and the extension
    // is not answering - which is nearly always a window that predates the
    // install, or a workspace the user has not trusted yet.
    const ides = connectedIdes();
    if (ides.length === 0) {
        return (
            "the porthole companion is installed, but no VS Code window is running it.\n" +
            "  Open VS Code - /cops will do it - and try again."
        );
    }

    const names = [...new Set(ides.map((i) => i.ideName).filter(Boolean))].join(", ");
    return (
        `the porthole companion is installed and ${names || "a window"} is open, but it is not answering.\n` +
        "  Extension versions are resolved when a window loads, so a window opened before\n" +
        "  the install is still running the old one - open a NEW window.\n" +
        "  If VS Code is asking whether you trust this workspace, it disables every\n" +
        "  extension until you say yes."
    );
}
