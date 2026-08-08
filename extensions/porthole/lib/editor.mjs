// Choosing and driving an editor.
//
// Two things matter here. First, commands should land in the window the user is
// already looking at rather than opening another one - the CLI writes a lock
// file for each connected IDE, which is how that window is found. Second,
// launching on Windows is full of traps, so it happens in exactly one place.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { config, copilotHome } from "./config.mjs";

export const isWindows = process.platform === "win32";

const IDE_LAUNCHERS = {
    "vscode-insiders": "code-insiders",
    vscode: "code",
    cursor: "cursor",
    windsurf: "windsurf",
};

/**
 * Maps the CLI's `ideName` to a launcher.
 *
 * The lock file reports a display name - "Visual Studio Code - Insiders" - not
 * the slug the exact-match table assumed, so reuse silently never triggered and
 * every command opened a new window. Matching on substrings fixes that and
 * survives the next rename.
 */
function launcherFor(ideName) {
    const name = String(ideName || "").toLowerCase();
    if (!name) return null;
    if (IDE_LAUNCHERS[name]) return IDE_LAUNCHERS[name];
    if (name.includes("insiders")) return "code-insiders";
    if (name.includes("cursor")) return "cursor";
    if (name.includes("windsurf")) return "windsurf";
    if (name.includes("visual studio code") || name.includes("vscode")) return "code";
    return null;
}

/** Config aliases for the `editor` key, in the order they are preferred. */
const EDITOR_ALIASES = {
    insiders: ["code-insiders"],
    stable: ["code"],
    code: ["code"],
    cursor: ["cursor"],
    windsurf: ["windsurf"],
};

/**
 * Finds a launcher on PATH.
 *
 * On Windows `where code-insiders` lists the extensionless shell script first,
 * which cmd.exe cannot run - it is there for Git Bash. Anything with a PATHEXT
 * extension is preferred, or the launch fails with "not recognized as an
 * internal or external command".
 */
export function whichEditor(name) {
    const probe = isWindows ? "where" : "which";
    try {
        const out = execFileSync(probe, [name], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (candidates.length === 0) return null;
        if (!isWindows) return candidates[0];
        return candidates.find((c) => /\.(cmd|bat|exe|com)$/i.test(c)) || candidates[0];
    } catch {
        return null;
    }
}

/**
 * Whether a process is still there.
 *
 * `EPERM` means it exists and belongs to someone else - routine when one side
 * is elevated and the other is not, which is exactly the case on a machine
 * where VS Code runs as administrator. Treating any throw as death made every
 * connected window in that setup invisible.
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

/**
 * Reads the IDE lock files the CLI writes for each connected editor window.
 * Only locks whose process is still alive count, matching the host's own rule.
 */
export function connectedIdes() {
    const ideDir = join(copilotHome(), "ide");
    if (!existsSync(ideDir)) return [];

    const found = [];
    for (const entry of readdirSync(ideDir)) {
        if (!entry.endsWith(".lock")) continue;
        try {
            const info = JSON.parse(readFileSync(join(ideDir, entry), "utf8"));
            if (!info.pid) continue;
            if (!isAlive(info.pid)) continue;
            found.push({
                lock: entry,
                ideName: String(info.ideName || ""),
                pid: info.pid,
                workspaceFolders: Array.isArray(info.workspaceFolders) ? info.workspaceFolders : [],
            });
        } catch {
            // Unreadable or malformed lock: skip it.
        }
    }
    return found;
}

export function pathsRelated(a, b) {
    const x = String(a).replace(/[\\/]+$/, "").toLowerCase();
    const y = String(b).replace(/[\\/]+$/, "").toLowerCase();
    return x === y || x.startsWith(y + sep.toLowerCase()) || y.startsWith(x + sep.toLowerCase());
}

/** Resolves a config `editor` value to a launcher path, or null. */
function fromPreference(preference) {
    if (!preference || preference === "auto") return null;

    const aliases = EDITOR_ALIASES[preference.toLowerCase()];
    if (aliases) {
        for (const name of aliases) {
            const cmd = whichEditor(name);
            if (cmd) return cmd;
        }
        return null;
    }

    // Anything else is taken as an explicit path.
    return existsSync(preference) ? preference : null;
}

/**
 * Picks the editor to drive.
 *
 * Precedence, highest first:
 *   1. PORTHOLE_EDITOR      - a deliberate one-off override
 *   2. `editor` in the config - the user's standing preference
 *   3. a connected IDE window - land where they are already looking
 *   4. Insiders, then stable
 *
 * The preference beats the connected window on purpose: someone who has written
 * down "always stable" means it.
 */
export function resolveEditorTarget(contextPath) {
    const cfg = config();

    const override = fromPreference(process.env.PORTHOLE_EDITOR);
    if (override) return { command: override, connected: false, ideName: null, reason: "env" };

    const preferred = fromPreference(cfg.editor);
    if (preferred) return { command: preferred, connected: false, ideName: null, reason: "config" };

    if (cfg.preferConnectedIde) {
        const ides = connectedIdes();
        if (ides.length > 0) {
            let chosen = null;
            if (contextPath) {
                chosen = ides.find((ide) =>
                    ide.workspaceFolders.some((wf) => wf && pathsRelated(contextPath, String(wf))),
                );
            }
            if (!chosen) [chosen] = ides;

            const launcher = launcherFor(chosen.ideName);
            if (launcher) {
                const cmd = whichEditor(launcher);
                if (cmd) {
                    return {
                        command: cmd,
                        connected: true,
                        ideName: chosen.ideName,
                        reason: "connected-ide",
                    };
                }
            }
        }
    }

    // Insiders is the preferred default.
    const insiders = whichEditor("code-insiders");
    if (insiders) return { command: insiders, connected: false, ideName: null, reason: "default" };
    const stable = whichEditor("code");
    if (stable) return { command: stable, connected: false, ideName: null, reason: "default" };

    return null;
}

/**
 * Finds the editor executable that sits beside the `bin/` launcher shim.
 *
 * `--open-url` must go to the .exe: the bin/*.cmd shim blocks without ever
 * delivering the URI (verified on VS Code Insiders 1.132). Everything else is
 * happy with the shim.
 *
 * Layout:  <install>\bin\code-insiders.cmd  ->  <install>\Code - Insiders.exe
 */
export function resolveEditorExe(launcherPath) {
    if (!isWindows) return launcherPath;

    const installRoot = dirname(dirname(launcherPath));
    for (const name of ["Code - Insiders.exe", "Code.exe", "Cursor.exe", "Windsurf.exe"]) {
        const candidate = join(installRoot, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Launches the editor fully detached.
 *
 * Windows needs care here:
 *  - Node refuses to spawn a .cmd/.bat without a shell (EINVAL, since the
 *    CVE-2024-27980 fix), and VS Code's launcher is `code-insiders.cmd`.
 *  - With `shell: true`, Node concatenates the command and argv into a single
 *    command line, so anything containing a space - such as
 *    "C:\Program Files\Microsoft VS Code Insiders\bin\code-insiders.cmd" -
 *    must be quoted or it is split at the space.
 *
 * Node runs `cmd.exe /d /s /c "<line>"`, and `/s` strips the outer quote pair,
 * so pre-quoting every element is exactly right.
 *
 * Failures are reported rather than swallowed: a launcher that cannot start is
 * otherwise invisible, because the handler has already logged success.
 */
export function launchEditor(session, command, args) {
    let child;

    if (isWindows) {
        const line = [command, ...args].map((a) => `"${a}"`).join(" ");
        child = spawn(line, [], {
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
            shell: true,
            windowsHide: true,
        });
    } else {
        child = spawn(command, args, {
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
    }

    let stderr = "";
    if (child.stderr) {
        child.stderr.on("data", (d) => {
            stderr += String(d);
        });
    }

    child.on("error", (err) => {
        void session.log(`porthole: could not launch the editor - ${err.message}`);
    });

    child.on("close", (code) => {
        if (code !== 0 && code !== null) {
            const detail = stderr.trim().split(/\r?\n/)[0] || `exit code ${code}`;
            void session.log(`porthole: the editor command failed - ${detail}`);
        }
    });

    child.unref();
}
