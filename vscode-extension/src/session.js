// Finding the Copilot session this window belongs to, and reading its state.
//
// The session folder is the one piece of shared ground between the CLI and the
// editor: it holds plan.md, the checkpoints, and session.db with the todo list.
// Surfacing it here is what lets you watch the agent's task list without
// leaving the editor.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const vscode = require("vscode");

const { diag } = require("./log");

function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), ".copilot");
}

function sessionRoot() {
    return path.join(copilotHome(), "session-state");
}

function isSessionDir(dir) {
    return fs.existsSync(path.join(dir, "events.jsonl")) || fs.existsSync(path.join(dir, "session.db"));
}

/**
 * Which session this window is looking at.
 *
 * A workspace folder inside session-state wins, because that is exactly what
 * /cops produces and it is unambiguous. Otherwise fall back to a session that
 * is currently in use: the CLI drops an inuse.<pid>.lock while it is running.
 */
function findSession() {
    const root = sessionRoot();

    for (const folder of vscode.workspace.workspaceFolders || []) {
        const fsPath = folder.uri.fsPath;
        if (!fsPath.toLowerCase().startsWith(root.toLowerCase())) continue;
        const relative = path.relative(root, fsPath).split(path.sep)[0];
        if (!relative) continue;
        const dir = path.join(root, relative);
        if (isSessionDir(dir)) return { id: relative, dir, source: "workspace" };
    }

    let best = null;
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const live = liveLock(dir);
        if (!live) continue;
        const stamp = mtime(path.join(dir, "events.jsonl")) || live;
        if (!best || stamp > best.stamp) best = { id: entry.name, dir, stamp, source: "inuse-lock" };
    }

    return best ? { id: best.id, dir: best.dir, source: best.source } : null;
}

/**
 * Whether a process is still there.
 *
 * `EPERM` means it exists and belongs to someone else - routine when the CLI
 * runs elevated and the editor does not, or the reverse. Reading every throw as
 * death made a live session's lock look stale, and the window then failed to
 * find the session it was opened alongside.
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

/** Returns the newest live inuse lock time, ignoring locks of dead processes. */
function liveLock(dir) {
    let newest = 0;
    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return 0;
    }
    for (const name of entries) {
        const match = /^inuse\.(\d+)\.lock$/.exec(name);
        if (!match) continue;
        if (!isAlive(Number(match[1]))) continue; // stale lock from a finished CLI
        newest = Math.max(newest, mtime(path.join(dir, name)));
    }
    return newest;
}

function mtime(file) {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

/** Descriptive facts about a session, all cheap file-system reads. */
function describeSession(session) {
    const checkpointsDir = path.join(session.dir, "checkpoints");
    let checkpoints = [];
    try {
        checkpoints = fs
            .readdirSync(checkpointsDir)
            .filter((f) => f.endsWith(".md") && f !== "index.md")
            .sort();
    } catch {
        checkpoints = [];
    }

    const project = (vscode.workspace.workspaceFolders || [])
        .map((f) => f.uri.fsPath)
        .find((p) => !p.toLowerCase().startsWith(sessionRoot().toLowerCase()));

    return {
        ...session,
        project: project || null,
        branch: project ? gitBranch(project) : null,
        checkpoints,
        latestCheckpoint: checkpoints.length
            ? path.join(checkpointsDir, checkpoints[checkpoints.length - 1])
            : null,
        planPath: fs.existsSync(path.join(session.dir, "plan.md"))
            ? path.join(session.dir, "plan.md")
            : null,
        dbPath: fs.existsSync(path.join(session.dir, "session.db"))
            ? path.join(session.dir, "session.db")
            : null,
    };
}

/** Reads .git/HEAD directly - cheaper and more predictable than shelling out. */
function gitBranch(projectDir) {
    try {
        let gitPath = path.join(projectDir, ".git");
        const stat = fs.statSync(gitPath);
        if (stat.isFile()) {
            // A linked worktree: .git is a file pointing at the real git dir.
            const pointer = fs.readFileSync(gitPath, "utf8").trim();
            const match = /^gitdir:\s*(.+)$/.exec(pointer);
            if (!match) return null;
            gitPath = path.resolve(projectDir, match[1]);
        }
        const head = fs.readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 8);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// session.db
// ---------------------------------------------------------------------------

let sqliteModule = null;
let sqliteChecked = false;

/**
 * node:sqlite is experimental, and Electron does not necessarily expose it, so
 * this is a capability check rather than an assumption.
 */
function hostSqlite() {
    if (sqliteChecked) return sqliteModule;
    sqliteChecked = true;
    try {
        // eslint-disable-next-line global-require
        sqliteModule = require("node:sqlite");
        diag("session.db: using the host's node:sqlite");
    } catch (err) {
        sqliteModule = null;
        diag(`session.db: host has no node:sqlite (${err.message})`);
    }
    return sqliteModule;
}

function readViaHost(dbPath) {
    const sqlite = hostSqlite();
    if (!sqlite) return null;
    let db;
    try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        const tables = new Set(
            db
                .prepare("select name from sqlite_master where type = 'table'")
                .all()
                .map((r) => r.name),
        );
        return {
            todos: tables.has("todos")
                ? db
                      .prepare(
                          "select id, title, description, status, created_at, updated_at from todos",
                      )
                      .all()
                : [],
            deps: tables.has("todo_deps")
                ? db.prepare("select todo_id, depends_on from todo_deps").all()
                : [],
        };
    } catch (err) {
        diag(`session.db: host read failed (${err.message})`);
        return null;
    } finally {
        try {
            if (db) db.close();
        } catch {
            // ignore
        }
    }
}

/** Falls back to whatever `node` is on PATH, which is a real Node with sqlite. */
function readViaNode(dbPath, extensionUri) {
    const script = vscode.Uri.joinPath(extensionUri, "media", "read-session-db.js").fsPath;
    return new Promise((resolve) => {
        execFile(
            "node",
            [script, dbPath],
            { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => {
                if (err) {
                    diag(`session.db: node fallback failed (${err.message})`);
                    resolve(null);
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    resolve(parsed.error ? null : parsed);
                } catch (parseErr) {
                    diag(`session.db: node fallback returned junk (${parseErr.message})`);
                    resolve(null);
                }
            },
        );
    });
}

/**
 * Reads the todo list, host SQLite first and a spawned node second.
 * Returns null when neither route works, so the view can say why.
 */
async function readTodos(dbPath, extensionUri) {
    if (!dbPath) return null;
    return readViaHost(dbPath) || (await readViaNode(dbPath, extensionUri));
}

module.exports = { findSession, describeSession, readTodos, sessionRoot };
