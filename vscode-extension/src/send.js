// "Send to Copilot" - the editor half of the reverse channel.
//
// Everything else in porthole flows CLI -> editor. This is the only path back:
// select some code, optionally type a question, and it arrives in the live
// Copilot CLI session as a prompt.
//
// Per docs/PROTOCOL.md the message is written under the user-owned
// ~/.copilot directory rather than the temp directory. On Linux and macOS /tmp
// is shared between local users, and unlike a forged reveal request, a forged
// message here would inject a prompt into an agent that can run shell
// commands.
//
// Delivery is confirmed, not assumed. The CLI writes an ack, and until that
// ack arrives this reports "not confirmed" rather than "sent" - the same
// lesson as the fire-and-forget URI that made a broken /cops look successful
// for three releases.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vscode = require("vscode");

const { diag } = require("./log");

const MAX_SELECTION = 16 * 1024;
const MAX_MESSAGE = 32 * 1024;
const MAX_NOTE = 2000;
const ACK_TIMEOUT_MS = 8000;
const ACK_POLL_MS = 50;

function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), ".copilot");
}

function portholeHome() {
    return path.join(copilotHome(), "porthole");
}

function outboxDir(endpointId) {
    return path.join(portholeHome(), "outbox", safeId(endpointId));
}

function ackDir() {
    return path.join(portholeHome(), "outbox-ack");
}

/** Ids become filenames, so never let one escape its directory. */
function safeId(value) {
    return String(value).replace(/[^\w.-]/g, "_").slice(0, 128);
}

// --- endpoints --------------------------------------------------------------

/**
 * Live CLI sessions, newest first.
 *
 * Keyed on endpointId rather than session id: two CLI processes can share a
 * session id when a session is resumed, and they would otherwise race for the
 * same outbox.
 */
/**
 * Whether a process is still running.
 *
 * `process.kill(pid, 0)` throws ESRCH when the process is gone, but EPERM when
 * it exists and simply belongs to someone we cannot signal - which is the
 * ordinary case when one side runs elevated and the other does not. Treating
 * every throw as "dead" would delete a live session's presence file and make it
 * permanently unreachable.
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

function findEndpoints() {
    const dir = portholeHome();
    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }

    const found = [];
    for (const entry of entries) {
        if (!entry.startsWith("cli-") || !entry.endsWith(".json")) continue;
        const file = path.join(dir, entry);
        let info;
        try {
            info = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            continue;
        }
        if (!info.pid || !info.endpointId) continue;
        if (!isAlive(info.pid)) {
            fs.rmSync(file, { force: true }); // the session is gone
            // Its outbox is unreachable by any future process, because the
            // endpoint id was unique to it. Left alone it would keep the
            // user's selected source code in ~/.copilot forever.
            discard(path.join(dir, "outbox", entry.replace(/^cli-|\.json$/g, "")));
            continue;
        }
        found.push(info);
    }

    sweepAcks();
    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function discard(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // racing another window's prune is fine
    }
}

/**
 * Drops acks nobody is waiting for any more.
 *
 * Every sender gives up after a few seconds, so anything older than an hour is
 * litter by definition.
 */
function sweepAcks() {
    const dir = ackDir();
    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
        const file = path.join(dir, entry);
        try {
            if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        } catch {
            // already gone
        }
    }
}

/**
 * Which session to send to.
 *
 * One is unambiguous. Several means asking, because guessing wrong sends your
 * question to the wrong conversation.
 */
async function pickEndpoint() {
    const endpoints = findEndpoints();
    if (endpoints.length === 0) return null;
    if (endpoints.length === 1) return endpoints[0];

    const here = (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath?.toLowerCase();
    const items = endpoints.map((e) => ({
        label: `$(comment-discussion) ${e.sessionName || path.basename(e.cwd || "session")}`,
        description: e.cwd === undefined ? "" : e.cwd,
        detail:
            here && String(e.projectRoot || e.cwd || "").toLowerCase() === here
                ? "this project"
                : undefined,
        endpoint: e,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: "porthole: send to which Copilot session?",
        placeHolder: "More than one CLI session is running",
    });
    return picked ? picked.endpoint : undefined; // undefined = cancelled
}

// --- composing --------------------------------------------------------------

/** Diagnostics that overlap the selected lines - usually why you are asking. */
function diagnosticsFor(document, range) {
    const out = [];
    for (const d of vscode.languages.getDiagnostics(document.uri)) {
        if (d.source === "porthole") continue;
        if (d.range.end.line < range.start.line || d.range.start.line > range.end.line) continue;
        out.push({
            severity: ["error", "warning", "info", "hint"][d.severity] || "info",
            line: d.range.start.line + 1,
            message: String(d.message || "").slice(0, 500),
            source: d.source || undefined,
        });
        if (out.length >= 20) break;
    }
    return out;
}

function truncate(text, max) {
    if (text.length <= max) return { text, truncated: false };
    return { text: `${text.slice(0, max)}\n... [truncated by porthole]`, truncated: true };
}

// --- sending ----------------------------------------------------------------

async function sendToCopilot() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("porthole: open a file first.");
        return;
    }

    const endpoint = await pickEndpoint();
    if (endpoint === undefined && findEndpoints().length > 1) return; // cancelled
    if (!endpoint) {
        vscode.window.showWarningMessage(
            "porthole: no Copilot CLI session is running with the porthole plugin loaded.",
        );
        return;
    }

    const document = editor.document;
    // An empty selection means the whole line, which is what people expect when
    // they just put the cursor somewhere and ask about it.
    const range = editor.selection.isEmpty
        ? document.lineAt(editor.selection.active.line).range
        : editor.selection;

    const note = await vscode.window.showInputBox({
        title: "porthole: send to Copilot",
        prompt: "What do you want to ask about this code? (optional)",
        placeHolder: "e.g. why does this branch never fire?",
    });
    if (note === undefined) return; // cancelled

    const selection = truncate(document.getText(range), MAX_SELECTION);

    const message = {
        messageId: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        endpointId: endpoint.endpointId,
        sentAt: new Date().toISOString(),
        source: "vscode",
        kind: "selection",
        note: String(note || "").slice(0, MAX_NOTE),
        file: document.uri.fsPath,
        language: document.languageId,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        selection: selection.text,
        truncated: selection.truncated,
        diagnostics: diagnosticsFor(document, range),
    };

    const encoded = JSON.stringify(message);
    if (encoded.length > MAX_MESSAGE) {
        vscode.window.showWarningMessage("porthole: that selection is too large to send.");
        return;
    }

    const written = write(message, encoded);
    if (!written.ok) {
        vscode.window.showErrorMessage(`porthole: ${written.error}`);
        return;
    }

    await reportDelivery(message, endpoint);
}

function write(message, encoded) {
    const dir = outboxDir(message.endpointId);
    try {
        // Owner-only: this directory is what stops another local user injecting
        // a prompt into the session.
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(ackDir(), { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${message.messageId}.json`);
        // Write then rename, so the CLI never claims a half-written message.
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, encoded, "utf8");
        fs.renameSync(tmp, file);
        diag(`send queued ${message.messageId} -> ${message.endpointId}`);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `could not queue the message: ${err.message}` };
    }
}

/**
 * Waits for the CLI's ack, with progress, and never claims more than it knows.
 */
async function reportDelivery(message, endpoint) {
    const who = endpoint.sessionName || path.basename(endpoint.cwd || "the CLI session");

    const ack = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `porthole: sending to ${who}...` },
        () => waitForAck(message.messageId),
    );

    if (!ack) {
        vscode.window.showWarningMessage(
            `porthole: ${who} did not confirm the message. It may not have arrived - ` +
                "check whether the session is still running.",
        );
        return;
    }

    if (ack.status === "accepted") {
        vscode.window.showInformationMessage(`porthole: sent to ${who}.`);
        return;
    }

    const reasons = {
        "rate-limited": "too many messages just now - try again in a moment",
        expired: "the message sat unread for too long and was discarded",
        rejected: ack.error || "the session refused the message",
        unconfirmed: "the session may or may not have received it",
    };
    vscode.window.showWarningMessage(
        `porthole: not delivered - ${reasons[ack.status] || ack.error || ack.status}.`,
    );
}

async function waitForAck(messageId) {
    const file = path.join(ackDir(), `${safeId(messageId)}.json`);
    const deadline = Date.now() + ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            fs.rmSync(file, { force: true });
            return parsed;
        } catch {
            // not there yet, or half-written
        }
        await new Promise((resolve) => setTimeout(resolve, ACK_POLL_MS));
    }
    return null;
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.sendToCopilot", sendToCopilot),
    );
}

module.exports = { activate, findEndpoints, sendToCopilot };
