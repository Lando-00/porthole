// Extension: porthole
//
// Registers deterministic slash commands that open things in VS Code:
//
//   /cops, /open-session   project (worktree) + current session folder, one workspace
//   /vsdiff                diffs for uncommitted changes, a commit, a range, or two files
//   /goto <file:line:col>  jump to a position
//
// These are real CommandDefinition handlers, not skills: the CLI invokes the
// handler directly, so each command does exactly one thing every time. No model
// in the loop, no tokens spent, no chance of a mis-chosen argument.
//
// NOTE: SDK-registered commands are surfaced by the TUI. In a non-interactive
// `copilot -p "/cops"` run there is no TUI, so the text is treated as an
// ordinary prompt and the agent-driven skills handle it instead. Test these
// commands from an interactive session.
//
// Everything runs in Node, so there is no PowerShell dependency and the same
// file works on Windows, macOS and Linux.
//
// Environment overrides:
//   PORTHOLE_EDITOR   force an editor: "insiders" | "code" | an absolute path
//   COPILOT_HOME      Copilot config dir (default: ~/.copilot)

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && existsSync(configured)) return configured;
    return join(homedir(), ".copilot");
}

/**
 * The session folder for a given session id.
 *
 * The command handler receives the real session id, so this is exact - unlike
 * the standalone scripts, which fall back to "most recently modified".
 */
function sessionFolderFor(sessionId) {
    if (!sessionId) return null;
    const dir = join(copilotHome(), "session-state", sessionId);
    return existsSync(dir) ? dir : null;
}

function portholeTempDir(leaf) {
    const dir = join(tmpdir(), leaf);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function safeName(value) {
    return String(value).replace(/[^\w.-]/g, "_");
}

function shortId(value, length = 8) {
    if (!value) return "none";
    return String(value).slice(0, length);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(args, cwd) {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * --show-toplevel from the cwd returns the *worktree* root, so a linked
 * worktree resolves to itself rather than to the main repository.
 */
function projectRoot(cwd) {
    const top = git(["rev-parse", "--show-toplevel"], cwd);
    return top ? resolve(top) : resolve(cwd);
}

function isGitRepo(cwd) {
    return git(["rev-parse", "--git-dir"], cwd) !== null;
}

// ---------------------------------------------------------------------------
// Editor selection
// ---------------------------------------------------------------------------

function whichEditor(name) {
    const probe = isWindows ? "where" : "which";
    try {
        const out = execFileSync(probe, [name], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const first = out.split(/\r?\n/).find(Boolean);
        return first || null;
    } catch {
        return null;
    }
}

/**
 * Reads the IDE lock files the CLI writes for each connected editor window.
 * Only locks whose process is still alive count, matching the host's own rule.
 */
function connectedIdes() {
    const ideDir = join(copilotHome(), "ide");
    if (!existsSync(ideDir)) return [];

    const found = [];
    for (const entry of readdirSync(ideDir)) {
        if (!entry.endsWith(".lock")) continue;
        try {
            const info = JSON.parse(readFileSync(join(ideDir, entry), "utf8"));
            if (!info.pid) continue;
            try {
                process.kill(info.pid, 0); // liveness probe only
            } catch {
                continue;
            }
            found.push({
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

const IDE_LAUNCHERS = {
    "vscode-insiders": "code-insiders",
    vscode: "code",
    cursor: "cursor",
    windsurf: "windsurf",
};

function pathsRelated(a, b) {
    const x = a.replace(/[\\/]+$/, "").toLowerCase();
    const y = b.replace(/[\\/]+$/, "").toLowerCase();
    return x === y || x.startsWith(y + sep.toLowerCase()) || y.startsWith(x + sep.toLowerCase());
}

/**
 * Picks the editor to drive. A connected IDE window always wins, so commands
 * land in the window the user is already looking at instead of spawning
 * another instance. PORTHOLE_EDITOR overrides everything.
 */
function resolveEditorTarget(contextPath) {
    const override = process.env.PORTHOLE_EDITOR;
    if (override) {
        if (override === "insiders" || override === "code") {
            const cmd = whichEditor(override === "insiders" ? "code-insiders" : "code");
            if (cmd) return { command: cmd, connected: false, ideName: null };
        } else if (existsSync(override)) {
            return { command: override, connected: false, ideName: null };
        }
    }

    const ides = connectedIdes();
    if (ides.length > 0) {
        let chosen = null;
        if (contextPath) {
            for (const ide of ides) {
                if (ide.workspaceFolders.some((wf) => wf && pathsRelated(contextPath, String(wf)))) {
                    chosen = ide;
                    break;
                }
            }
        }
        if (!chosen) chosen = ides[0];

        const launcher = IDE_LAUNCHERS[chosen.ideName.toLowerCase()];
        if (launcher) {
            const cmd = whichEditor(launcher);
            if (cmd) return { command: cmd, connected: true, ideName: chosen.ideName };
        }
    }

    // Insiders is the preferred default.
    const insiders = whichEditor("code-insiders");
    if (insiders) return { command: insiders, connected: false, ideName: null };
    const stable = whichEditor("code");
    if (stable) return { command: stable, connected: false, ideName: null };

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
function resolveEditorExe(launcherPath) {
    if (!isWindows) return launcherPath;

    const binDir = dirname(launcherPath);
    const installRoot = dirname(binDir);
    const candidates = [
        "Code - Insiders.exe",
        "Code.exe",
        "Cursor.exe",
        "Windsurf.exe",
    ];
    for (const name of candidates) {
        const candidate = join(installRoot, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Asks the porthole companion VS Code extension to select and highlight a range.
 *
 * The VS Code CLI cannot select a range - `--goto` only places a cursor - so
 * this is delegated to the companion extension over its URI handler. Returns
 * false when the companion cannot be driven, so callers can fall back.
 */
function revealRange(session, launcherPath, file, startLine, endLine) {
    const exe = resolveEditorExe(launcherPath);
    if (!exe) return false;

    // The URI authority is the extension id, which VS Code lower-cases.
    const scheme = /insiders/i.test(exe) ? "vscode-insiders" : "vscode";
    const query =
        `file=${encodeURIComponent(file)}` +
        `&start=${startLine}` +
        (endLine && endLine !== startLine ? `&end=${endLine}` : "");
    const uri = `${scheme}://lando-00.porthole-companion/reveal?${query}`;

    const child = spawn(exe, ["--open-url", "--", uri], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
    });
    child.on("error", (err) => {
        void session.log(`porthole: could not reach the companion extension - ${err.message}`);
    });
    child.unref();
    return true;
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
function launchEditor(session, command, args) {
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

function writeJson(path, value) {
    writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// /cops, /open-session
// ---------------------------------------------------------------------------

async function handleOpenSession(session, ctx) {
    const cwd = process.cwd();
    const root = projectRoot(cwd);
    const name = basename(root);
    const sessionFolder = sessionFolderFor(ctx.sessionId);

    const target = resolveEditorTarget(root);
    if (!target) {
        await session.log(
            "porthole: no editor found. Install VS Code and make sure 'code-insiders' or 'code' is on PATH.",
        );
        return;
    }

    // Reuse the window the user already has open rather than opening a second
    // one on a generated workspace.
    if (target.connected) {
        if (sessionFolder) {
            launchEditor(session, target.command, ["--reuse-window", "--add", sessionFolder]);
            await session.log(
                `porthole: added the session folder to the connected ${target.ideName} window.\n` +
                    `  project: ${root}\n  session: ${sessionFolder}`,
            );
        } else {
            launchEditor(session, target.command, ["--reuse-window", "--add", root]);
            await session.log(
                `porthole: no session folder on disk yet; added the project to the connected ${target.ideName} window.`,
            );
        }
        return;
    }

    const folders = [{ path: root, name }];
    if (sessionFolder) {
        folders.push({ path: sessionFolder, name: `Copilot Session (${shortId(ctx.sessionId)})` });
    }

    const workspace = {
        folders,
        settings: {
            // Makes diagrams written into the session folder open rendered.
            "workbench.editorAssociations": {
                "*.diagram.md": "vscode.markdown.preview.editor",
            },
        },
    };

    // Written to temp, never into the repository, so it cannot be committed by
    // accident. The name is stable per project+session, so re-running focuses
    // the same window instead of piling up duplicates.
    const outDir = portholeTempDir("porthole-workspaces");
    const wsFile = join(outDir, `${safeName(name)}-${shortId(ctx.sessionId)}.code-workspace`);
    writeJson(wsFile, workspace);

    launchEditor(session, target.command, [wsFile]);

    await session.log(
        sessionFolder
            ? `porthole: opened '${name}' + the Copilot session folder in one workspace.\n` +
                  `  project: ${root}\n  session: ${sessionFolder}`
            : `porthole: opened '${name}'. No session folder found on disk yet.`,
    );
}

// ---------------------------------------------------------------------------
// /vsdiff
// ---------------------------------------------------------------------------

function writeSide(repoRoot, relPath, ref, outDir, label) {
    const target = join(outDir, `${label}.${basename(relPath)}`);

    if (ref === "") {
        const src = join(repoRoot, relPath);
        if (!existsSync(src)) return null;
        writeFileSync(target, readFileSync(src));
        return target;
    }

    const spec = ref === ":staged" ? `:${relPath}` : `${ref}:${relPath}`;
    let content;
    try {
        content = execFileSync("git", ["-C", repoRoot, "show", spec], {
            encoding: "buffer",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return null;
    }
    writeFileSync(target, content);
    return target;
}

function emptyPlaceholder(outDir, label, relPath) {
    const target = join(outDir, `${label}.${basename(relPath)}`);
    writeFileSync(target, "");
    return target;
}

async function handleVsDiff(session, ctx) {
    const raw = (ctx.args || "").trim();
    const cwd = process.cwd();

    // Two explicit paths: diff them directly, no git involved.
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 2 && parts.every((p) => existsSync(p))) {
        const target = resolveEditorTarget(dirname(resolve(parts[0])));
        if (!target) {
            await session.log("porthole: no editor found on PATH.");
            return;
        }
        launchEditor(session, target.command, ["--reuse-window", "--diff", resolve(parts[0]), resolve(parts[1])]);
        await session.log(`porthole: opened a diff of ${parts[0]} and ${parts[1]}.`);
        return;
    }

    if (!isGitRepo(cwd)) {
        await session.log("porthole: not a git repository, so there is nothing to diff.");
        return;
    }
    const repoRoot = projectRoot(cwd);

    let leftRef = "HEAD";
    let rightRef = "";
    let description = "uncommitted changes (HEAD vs working tree)";
    let nameArgs = ["-C", repoRoot, "diff", "--name-only", "HEAD"];

    if (raw === "staged" || raw === "cached" || raw === "--staged" || raw === "--cached") {
        rightRef = ":staged";
        description = "staged changes (HEAD vs index)";
        nameArgs = ["-C", repoRoot, "diff", "--name-only", "--cached"];
    } else if (raw.includes("..")) {
        const [a, b] = raw.split(/\.\.\.?/, 2);
        leftRef = a;
        rightRef = b || "HEAD";
        description = `range ${leftRef}..${rightRef}`;
        nameArgs = ["-C", repoRoot, "diff", "--name-only", `${leftRef}..${rightRef}`];
    } else if (raw) {
        leftRef = `${raw}^`;
        rightRef = raw;
        description = `commit ${raw} (vs parent)`;
        nameArgs = ["-C", repoRoot, "diff", "--name-only", `${raw}^`, raw];
    }

    const listed = git(nameArgs);
    if (listed === null) {
        await session.log(`porthole: git could not resolve '${raw}'. Check the commit or range exists.`);
        return;
    }

    let changed = listed.split(/\r?\n/).filter(Boolean);
    if (changed.length === 0) {
        await session.log(`porthole: no changes found for ${description}.`);
        return;
    }

    const MAX_FILES = 10;
    let truncated = false;
    if (changed.length > MAX_FILES) {
        truncated = true;
        changed = changed.slice(0, MAX_FILES);
    }

    const target = resolveEditorTarget(repoRoot);
    if (!target) {
        await session.log("porthole: no editor found on PATH.");
        return;
    }

    // git difftool cannot be used here: it blocks until the editor closes,
    // because git deletes its temp files as soon as the command returns.
    // Materialising the sides ourselves keeps the launch detached.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join(portholeTempDir("porthole-diffs"), `${stamp}-${safeName(basename(repoRoot))}`);
    mkdirSync(outDir, { recursive: true });

    for (const rel of changed) {
        const fileDir = join(outDir, safeName(rel.replace(/[\\/]/g, "_")));
        mkdirSync(fileDir, { recursive: true });

        const left = writeSide(repoRoot, rel, leftRef, fileDir, "BEFORE") ??
            emptyPlaceholder(fileDir, "BEFORE", rel);
        const right = writeSide(repoRoot, rel, rightRef, fileDir, "AFTER") ??
            emptyPlaceholder(fileDir, "AFTER", rel);

        launchEditor(session, target.command, ["--reuse-window", "--diff", left, right]);
    }

    const where = target.connected ? ` in the connected ${target.ideName} window` : "";
    await session.log(
        `porthole: opened ${changed.length} diff(s) for ${description}${where}.\n` +
            changed.map((c) => `  ${c}`).join("\n") +
            (truncated ? `\n  (capped at ${MAX_FILES} files)` : ""),
    );
}

// ---------------------------------------------------------------------------
// /goto
// ---------------------------------------------------------------------------

async function handleGoto(session, ctx) {
    const raw = (ctx.args || "").trim();
    if (!raw) {
        await session.log("porthole: usage - /goto <file>[:line[:column]]  or  /goto <file>:<start>-<end>");
        return;
    }

    let filePart = raw;
    let position = "";
    let startLine = 0;
    let endLine = 0;

    // file:start-end selects a range; file:line[:col] just places a cursor.
    const rangeMatch = /^(?<f>.+?):(?<s>\d+)-(?<e>\d+)$/.exec(raw);
    const pointMatch = /^(?<f>.+?):(?<l>\d+)(?::(?<c>\d+))?$/.exec(raw);

    if (rangeMatch && rangeMatch.groups.f.length > 1) {
        filePart = rangeMatch.groups.f;
        startLine = Number.parseInt(rangeMatch.groups.s, 10);
        endLine = Number.parseInt(rangeMatch.groups.e, 10);
        position = `:${startLine}`;
    } else if (pointMatch && pointMatch.groups.f.length > 1) {
        filePart = pointMatch.groups.f;
        startLine = Number.parseInt(pointMatch.groups.l, 10);
        position = pointMatch.groups.c ? `:${startLine}:${pointMatch.groups.c}` : `:${startLine}`;
    }

    const cwd = process.cwd();
    let resolved = null;
    if (isAbsolute(filePart) && existsSync(filePart)) {
        resolved = filePart;
    } else {
        for (const base of [projectRoot(cwd), cwd]) {
            const candidate = join(base, filePart);
            if (existsSync(candidate)) {
                resolved = candidate;
                break;
            }
        }
    }

    if (!resolved) {
        await session.log(`porthole: file not found - ${filePart}`);
        return;
    }

    const target = resolveEditorTarget(dirname(resolved));
    if (!target) {
        await session.log("porthole: no editor found on PATH.");
        return;
    }

    const where = target.connected ? ` in the connected ${target.ideName} window` : "";

    // A real multi-line selection needs the companion extension; the CLI alone
    // can only place a cursor.
    if (endLine && endLine !== startLine) {
        // Open the file first so the range lands in the right window, then select.
        launchEditor(session, target.command, ["--reuse-window", "--goto", `${resolved}:${startLine}`]);
        const ok = revealRange(session, target.command, resolved, startLine, endLine);
        if (ok) {
            await session.log(
                `porthole: highlighted ${resolved} lines ${startLine}-${endLine}${where}.\n` +
                    "  (needs the porthole companion VS Code extension; see vscode-extension/)",
            );
        } else {
            await session.log(
                `porthole: opened ${resolved} at line ${startLine}${where}. ` +
                    "Could not locate the editor executable to request a range selection.",
            );
        }
        return;
    }

    launchEditor(session, target.command, ["--reuse-window", "--goto", `${resolved}${position}`]);
    await session.log(`porthole: opened ${resolved}${position}${where}.`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const session = await joinSession({
    commands: [
        {
            name: "cops",
            description:
                "Open this worktree + the current Copilot session folder in one VS Code workspace",
            handler: (ctx) => handleOpenSession(session, ctx),
        },
        {
            name: "open-session",
            description:
                "Open this worktree + the current Copilot session folder in one VS Code workspace",
            handler: (ctx) => handleOpenSession(session, ctx),
        },
        {
            name: "vsdiff",
            description:
                "Open diffs in VS Code: no args = uncommitted, or a commit, a range, 'staged', or two file paths",
            handler: (ctx) => handleVsDiff(session, ctx),
        },
        {
            name: "goto",
            description: "Open a file in VS Code: /goto <file>[:line[:col]] or <file>:<start>-<end> to highlight a range",
            handler: (ctx) => handleGoto(session, ctx),
        },
    ],
});

await session.log("porthole ready - /cops, /open-session, /vsdiff, /goto");
