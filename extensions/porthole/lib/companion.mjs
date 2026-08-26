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
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    watch,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir, uptime } from "node:os";
import { basename, join } from "node:path";

import { config, copilotHome } from "./config.mjs";
import { companionSupportsRoute } from "./capabilities.mjs";
import { connectedIdes, pathsRelated, resolveEditorExe, resolveEditorTarget, whichEditor } from "./editor.mjs";

const ROOT = join(tmpdir(), "porthole");
const REQ_DIR = join(ROOT, "req");
const ACK_DIR = join(ROOT, "ack");
// The ack poll starts tight and backs off. Almost every ack lands in the first
// few tens of milliseconds, so a small first interval is what actually decides
// how responsive a route feels; a fixed 10ms then spends the rest of a failing
// request doing a hundred pointless existsSync calls a second.
const POLL_MIN_MS = 2;
const POLL_MAX_MS = 50;
const POLL_GROWTH = 1.4;
const MAX_AGE_MS = 60 * 60 * 1000;
// Litter is bounded by MAX_AGE_MS, so sweeping on every single request buys
// nothing and costs a readdir plus a stat per leftover file each time.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A sleep that overruns its timer by more than this was the machine suspending
// or the wall clock moving, not the companion being slow.
const SUSPEND_THRESHOLD_MS = 5000;
const WINDOW_ID = /^[a-f0-9]{16}$/;
// Anything written before this machine last booted was written by a process
// that is definitively gone, whatever the pid says now.
const BOOT_SLACK_MS = 60 * 1000;

/**
 * When this machine booted, give or take.
 *
 * A pid probe alone cannot spot a presence file left by a hard power-off: after
 * a reboot the pid it names may have been handed to an unrelated process, and
 * an unelevated probe of one of those answers EPERM, which is deliberately read
 * as "alive". The stale record then never expires, and a window that reopens
 * the same Copilot session looks like a second live owner - so every route
 * refuses as ambiguous, permanently, with nothing to clear it.
 */
function bootedAt() {
    return Date.now() - uptime() * 1000;
}

function writtenBeforeBoot(info) {
    const written = Date.parse(info.updatedAt);
    if (!Number.isFinite(written)) return false; // no evidence; leave it alone
    return written < bootedAt() - BOOT_SLACK_MS;
}

const EXTENSION_ID = "lando-00.porthole-companion";

function inboxRoot() {
    return join(copilotHome(), "porthole", "inbox");
}

function ensureDirs() {
    mkdirSync(REQ_DIR, { recursive: true });
    mkdirSync(ACK_DIR, { recursive: true });
}

let lastSweptAt = 0;

/** Nothing here is read twice, so old files are just litter. */
function sweep({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastSweptAt < SWEEP_INTERVAL_MS) return;
    lastSweptAt = now;

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

        // Checked before the pid probe, because a recycled pid can make the
        // probe say "alive" about a process that died with the last boot.
        if (writtenBeforeBoot(info)) {
            rmSync(file, { force: true });
            if (WINDOW_ID.test(String(info.windowId || ""))) {
                rmSync(join(inboxRoot(), info.windowId), { recursive: true, force: true });
            }
            continue;
        }

        // ESRCH means the window is gone; EPERM means it exists but is not
        // ours to signal, which happens when one side runs elevated. Deleting
        // on EPERM would hide a perfectly healthy window.
        try {
            process.kill(info.pid, 0);
        } catch (err) {
            if (err.code !== "EPERM") {
                rmSync(file, { force: true }); // the window is gone
                if (WINDOW_ID.test(String(info.windowId || ""))) {
                    rmSync(join(inboxRoot(), info.windowId), { recursive: true, force: true });
                }
                continue;
            }
        }
        found.push({ ...info, file });
    }

    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function sessionIdFromPath(sessionPath) {
    return sessionPath ? basename(String(sessionPath).replace(/[\\/]+$/, "")) : null;
}

function sameSession(companion, { sessionId, sessionPath }) {
    if (sessionId && companion.sessionId === sessionId) return true;
    if (sessionPath && companion.sessionFolder && samePath(sessionPath, companion.sessionFolder)) {
        return true;
    }
    return Boolean(
        sessionPath &&
            (companion.workspaceFolders || []).some(
                (folder) => folder && samePath(sessionPath, String(folder)),
            ),
    );
}

function describeCandidate(companion) {
    return {
        windowId: companion.windowId || null,
        pid: companion.pid,
        appName: companion.appName,
        sessionId: companion.sessionId || null,
        sessionFolder: companion.sessionFolder || null,
        workspaceFolders: companion.workspaceFolders || [],
    };
}

/**
 * Selects one exact companion, or reports why choosing would be unsafe.
 *
 * Session identity beats repository identity. Two sessions can work in the
 * same repository, so a project-path match is only usable when it is unique.
 */
export function chooseCompanion(companions, options = {}) {
    if (companions.length === 0) return { companion: null, reason: "absent", candidates: [] };

    if (options.windowId) {
        const match = companions.find((c) => c.windowId === options.windowId);
        return match
            ? { companion: match, reason: null, candidates: [] }
            : {
                  companion: null,
                  reason: "unknown-window",
                  candidates: companions.map(describeCandidate),
              };
    }

    const sessionId = options.sessionId || sessionIdFromPath(options.sessionPath);
    const sessionMatches = companions.filter((c) =>
        sameSession(c, { sessionId, sessionPath: options.sessionPath }),
    );
    if (sessionMatches.length === 1) {
        return { companion: sessionMatches[0], reason: null, candidates: [] };
    }
    if (sessionMatches.length > 1) {
        return {
            companion: null,
            reason: "ambiguous",
            candidates: sessionMatches.map(describeCandidate),
        };
    }

    if (sessionId || options.sessionPath) {
        // A modern companion that names another session is not a project-path
        // fallback. That is the exact cross-session misroute this selector
        // exists to prevent. A sole legacy companion may still be used while
        // the separately-published VSIX catches up.
        const legacy = companions.filter((c) => !c.windowId && !c.sessionId);
        if (companions.length === 1 && legacy.length === 1) {
            return { companion: legacy[0], reason: null, candidates: [] };
        }
        return {
            companion: null,
            reason: "session-missing",
            candidates: companions.map(describeCandidate),
        };
    }

    if (options.contextPath) {
        const matches = companions.filter((c) =>
            (c.workspaceFolders || []).some(
                (wf) => wf && pathsRelated(options.contextPath, String(wf)),
            ),
        );
        if (matches.length === 1) return { companion: matches[0], reason: null, candidates: [] };
        if (matches.length > 1) {
            return {
                companion: null,
                reason: "ambiguous",
                candidates: matches.map(describeCandidate),
            };
        }
    }

    if (companions.length === 1) {
        return { companion: companions[0], reason: null, candidates: [] };
    }
    return {
        companion: null,
        reason: "ambiguous",
        candidates: companions.map(describeCandidate),
    };
}

export function selectCompanion(options = {}) {
    return chooseCompanion(findCompanions(), options);
}

/** The one safe companion for this target, if any. */
export function findCompanion(contextPath, options = {}) {
    return selectCompanion({ ...options, contextPath }).companion;
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

    const selected = selectCompanion({
        contextPath,
        sessionPath: options.sessionPath,
        sessionId: options.sessionId,
        windowId: options.windowId,
    });
    const companion = selected.companion;
    if (!companion) {
        if (
            selected.reason === "ambiguous" ||
            selected.reason === "unknown-window" ||
            selected.reason === "session-missing"
        ) {
            return {
                ok: false,
                reason:
                    selected.reason === "session-missing" ? "absent" : selected.reason,
                error:
                    selected.reason === "unknown-window"
                        ? `the requested VS Code window '${options.windowId}' is no longer available`
                        : selected.reason === "session-missing"
                          ? "no VS Code window is bound to this Copilot session"
                        : "more than one VS Code window could handle this request",
                candidates: selected.candidates,
            };
        }
        // Without a heartbeat there is nothing listening, and firing the URI
        // anyway would just burn the whole timeout before saying so.
        return {
            ok: false,
            reason: "absent",
            error: "no VS Code window with the porthole companion is running",
        };
    }

    // Checked before firing: an unreachable pairing would otherwise burn the
    // whole timeout and then report the wrong cause.
    const blocked = unreachable(companion);
    if (blocked) return { ok: false, reason: "refused", error: blocked };

    const capability = companionSupportsRoute(companion, route);
    if (!capability.ok) {
        return {
            ok: false,
            reason: "incompatible",
            error: capability.error,
            missingCapability: capability.required,
            companionVersion: companion.version || null,
        };
    }

    ensureDirs();
    sweep();

    const requestId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    let spawnError = null;
    let inboxFile = null;
    if (WINDOW_ID.test(String(companion.windowId || ""))) {
        const written = writeInbox(companion.windowId, {
            requestId,
            route,
            payload,
        });
        spawnError = written.error;
        inboxFile = written.file;
    } else {
        const exe = resolveCompanionExe(companion, contextPath);
        if (!exe) {
            return {
                ok: false,
                reason: "absent",
                error: "could not find the editor executable to deliver the request to",
            };
        }
        if (payload !== null) {
            writeFileSync(join(REQ_DIR, `${requestId}.json`), JSON.stringify(payload), "utf8");
        }
        // Old companions have no addressed inbox. The selector permits this
        // fallback only when that old window is unambiguous.
        const scheme = companion.uriScheme || (/insiders/i.test(exe) ? "vscode-insiders" : "vscode");
        const uri = `${scheme}://${EXTENSION_ID}/${route}?req=${requestId}`;
        spawnError = fire(exe, uri);
    }
    if (spawnError) {
        return { ok: false, reason: "error", error: `could not reach the editor: ${spawnError}` };
    }

    const ack = await waitForAck(requestId, timeoutMs);
    if (!ack) {
        rmSync(join(REQ_DIR, `${requestId}.json`), { force: true });
        if (inboxFile) rmSync(inboxFile, { force: true });
        return {
            ok: false,
            reason: "timeout",
            error: `the companion did not answer within ${timeoutMs}ms`,
        };
    }

    return ack.ok ? ack : { ...ack, reason: ack.reason || "refused" };
}

function writeInbox(windowId, request) {
    try {
        const dir = join(inboxRoot(), windowId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, `${request.requestId}.json`);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, file);
        return { error: null, file };
    } catch (err) {
        return { error: err.message, file: null };
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

/**
 * Waits for the companion's reply.
 *
 * Watched *and* polled. The watcher is what makes a reply feel immediate:
 * polling alone cannot beat the host timer granularity, which on Windows
 * rounds any sleep up to roughly 15ms and so put a floor under every route.
 * The poll stays because fs.watch is not reliable everywhere - network and
 * virtualised filesystems drop events - and a missed event must degrade to a
 * slower answer, never a lost one.
 */
async function waitForAck(requestId, timeoutMs) {
    const name = `${requestId}.json`;
    const file = join(ACK_DIR, name);
    let deadline = Date.now() + timeoutMs;

    let wake = null;
    let watcher = null;
    try {
        watcher = watch(ACK_DIR, { persistent: false }, (_event, changed) => {
            // Some platforms report no filename; waking for those is cheap.
            if (!changed || String(changed).startsWith(requestId)) wake?.();
        });
        if (typeof watcher.on === "function") watcher.on("error", () => {});
    } catch {
        watcher = null; // polling alone still answers, just less promptly
    }

    try {
        let interval = POLL_MIN_MS;
        for (;;) {
            // Checked before the first sleep, which closes the race where the
            // reply lands between firing the request and watching for it.
            if (existsSync(file)) {
                try {
                    const parsed = JSON.parse(readFileSync(file, "utf8"));
                    rmSync(file, { force: true });
                    return parsed;
                } catch {
                    // Half-written despite the atomic rename; the rest of it is
                    // milliseconds away, so do not back off for it.
                    interval = POLL_MIN_MS;
                }
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;

            const nap = Math.min(interval, remaining);
            const before = Date.now();
            await napUntilWoken(nap, (resume) => {
                wake = resume;
            });
            wake = null;

            // Time the machine spent suspended is not time the companion had to
            // answer in. A preview waits half an hour for a human to click
            // Apply; closing the lid in the middle used to burn that whole
            // budget at once, so the CLI reported a timeout while the editor was
            // still showing the diff - and then Apply wrote files that the model
            // had already been told were never applied.
            const slept = Date.now() - before;
            if (slept > nap + SUSPEND_THRESHOLD_MS) deadline += slept - nap;

            interval = Math.min(interval * POLL_GROWTH, POLL_MAX_MS);
        }
    } finally {
        wake = null;
        try {
            if (watcher) watcher.close();
        } catch {
            // Already closed.
        }
    }
}

/** Sleeps for `ms`, or until `register`'s callback is invoked, whichever is first. */
function napUntilWoken(ms, register) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        register(finish);
    });
}

/** Human-readable reason a companion call failed, for logging. */
export function explain(result) {
    if (result.ok) return "";
    if (result.reason === "ambiguous") {
        return (
            `${result.error}. Call porthole_windows and ask the user which window they mean; ` +
            "do not guess."
        );
    }
    if (result.reason === "unknown-window") return result.error;
    if (result.reason === "absent") {
        if (/bound to this Copilot session/i.test(result.error || "")) {
            return `${result.error}. Run /cops or ask to open this session in a new window.`;
        }
        return explainAbsent();
    }
    if (result.reason === "timeout") {
        // Deliberately does not delete the presence file it fired at. Deleting
        // it looked like tidy self-healing and was a trap: the request path
        // returns early when there is no presence file, so a window that
        // answered one poll interval late would never be sent another request,
        // and could never republish. A live window, unreachable forever.
        //
        // Nothing needs deleting anyway. Firing at a stale record launches the
        // editor, which then publishes a fresh record of its own with a newer
        // timestamp - and readers prefer the newest. The stale one is outranked
        // rather than obeyed, and goes when its pid does.
        return (
            `${result.error}. Either the window is busy, or that record is left over from ` +
            "a window that no longer exists - in which case the editor is starting now. Try again."
        );
    }
    return result.error || "the companion refused the request";
}

/**
 * Where editors keep installed extensions.
 *
 * All the flavours this plugin can drive, not just VS Code - editor.mjs
 * launches Cursor and Windsurf too, and telling one of their users to run
 * `code --install-extension` sends them to install into a different editor,
 * which changes nothing.
 */
function extensionDirs() {
    const home = homedir();
    const dirs = [
        join(home, ".vscode", "extensions"),
        join(home, ".vscode-insiders", "extensions"),
        join(home, ".cursor", "extensions"),
        join(home, ".windsurf", "extensions"),
    ];
    if (process.env.VSCODE_EXTENSIONS) dirs.unshift(process.env.VSCODE_EXTENSIONS);
    return dirs;
}

/**
 * Whether the companion is installed on disk, regardless of whether it is
 * currently running.
 *
 * A positive answer is trustworthy; a negative one is only probably right,
 * since `--extensions-dir` and portable installs put it somewhere this cannot
 * see. The message below is hedged to match.
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
 * "No presence file" has three quite different causes and they need three
 * different answers. Telling someone to install an extension they already have
 * - which is what this used to do - sends them to check the one thing that is
 * fine, and the instruction it gave was the *developer* one at that.
 */
function explainAbsent() {
    if (!isCompanionInstalled()) {
        return (
            "could not find the porthole companion extension in the usual place.\n" +
            "  If it is not installed:  code --install-extension Lando-00.porthole-companion\n" +
            "  (or code-insiders / cursor / windsurf), then open a new window."
        );
    }

    // Installed. So either no window is running it, or one is and it is not
    // answering - nearly always a window that predates the install, or a
    // workspace the user has not trusted yet.
    //
    // `connectedIdes()` answers a near-but-not-identical question: which
    // editors are attached to Copilot CLI, not which are running the companion.
    // Worded as the hint it is, rather than as a claim about VS Code.
    const ides = connectedIdes();
    if (ides.length === 0) {
        return (
            "the porthole companion is installed, but no window is reporting in.\n" +
            "  If your editor is not open, /cops will open it.\n" +
            "  If it is open, it was probably started before the extension was installed -\n" +
            "  extension versions are resolved when a window loads, so open a NEW window."
        );
    }

    const names = [...new Set(ides.map((i) => i.ideName).filter(Boolean))].join(", ");
    return (
        `the porthole companion is installed and Copilot is connected to ${names || "an editor"}, ` +
        "but the companion is not answering.\n" +
        "  Extension versions are resolved when a window loads, so a window opened before\n" +
        "  the install is still running the old one - open a NEW window.\n" +
        "  If your editor is asking whether you trust this workspace, it disables every\n" +
        "  extension until you say yes."
    );
}
