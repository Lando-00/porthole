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
//   PORTHOLE_EDITOR   force an editor: "insiders" | "stable" | an absolute path
//   COPILOT_HOME      Copilot config dir (default: ~/.copilot)
//
// Standing preferences live in ~/.copilot/porthole.json - see lib/config.mjs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

import { config, copilotHome, reportConfigProblems } from "./lib/config.mjs";
import {
    annotate,
    clearAnnotations,
    goto,
    parseTarget,
    resolveFile,
    tools as portholeTools,
} from "./lib/annotate.mjs";
import { doctor, pluginVersion } from "./lib/doctor.mjs";
import * as endpoint from "./lib/endpoint.mjs";
import * as outbox from "./lib/outbox.mjs";
import { git, projectRoot, isGitRepo } from "./lib/git.mjs";
import { launchEditor, resolveEditorTarget } from "./lib/editor.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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

/**
 * Where generated files go. Configurable, because a workspace file in the temp
 * folder is invisible to backups and easy to lose track of.
 */
function portholeTempDir(leaf) {
    const configured = config().workspaceDir;
    const dir = configured ? join(configured, leaf) : join(tmpdir(), leaf);
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

function writeJson(path, value) {
    writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// /cops, /open-session
// ---------------------------------------------------------------------------

async function handleOpenSession(session, ctx) {
    await reportConfigProblems(session);
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
// /goto, /annotate, /annotate-clear
// ---------------------------------------------------------------------------

async function handleGoto(session, ctx) {
    const raw = (ctx.args || "").trim();
    if (!raw) {
        await session.log(
            "porthole: usage - /goto <file>[:line[:column]], /goto <file>:<start>-<end>, or /goto <symbolName>",
        );
        return;
    }
    await session.log(await goto(session, raw));
}

async function handleAnnotate(session, ctx) {
    const raw = (ctx.args || "").trim();
    if (!raw) {
        await session.log("porthole: usage - /annotate <file>:<start>[-<end>] [message]");
        return;
    }

    // Everything up to the first space is the location; the rest is the note.
    const split = raw.indexOf(" ");
    const locator = split === -1 ? raw : raw.slice(0, split);
    const message = split === -1 ? "" : raw.slice(split + 1).trim();

    const target = parseTarget(locator);
    if (!target || target.kind === "symbol") {
        await session.log(await goto(session, locator, message));
        return;
    }

    const file = resolveFile(target.file);
    if (!file) {
        await session.log(`porthole: file not found - ${target.file}`);
        return;
    }

    await session.log(
        await annotate({
            title: message || undefined,
            annotations: [
                {
                    file,
                    startLine: target.startLine,
                    endLine: target.endLine || target.startLine,
                    message,
                },
            ],
        }),
    );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Refreshes presence on every command.
 *
 * `ctx.sessionId` is exact and only exists here, so this is where a session id
 * that was unknown at load finally gets filled in.
 */
const withPresence = (handler) => (ctx) => {
    endpoint.touch(session, ctx);
    return handler(ctx);
};

const session = await joinSession({
    commands: [
        {
            name: "cops",
            description:
                "Open this worktree + the current Copilot session folder in one VS Code workspace",
            handler: withPresence((ctx) => handleOpenSession(session, ctx)),
        },
        {
            name: "open-session",
            description:
                "Open this worktree + the current Copilot session folder in one VS Code workspace",
            handler: withPresence((ctx) => handleOpenSession(session, ctx)),
        },
        {
            name: "vsdiff",
            description:
                "Open diffs in VS Code: no args = uncommitted, or a commit, a range, 'staged', or two file paths",
            handler: withPresence((ctx) => handleVsDiff(session, ctx)),
        },
        {
            name: "goto",
            description:
                "Open a file in VS Code: /goto <file>[:line[:col]], <file>:<start>-<end> to highlight a range, or a symbol name",
            handler: withPresence((ctx) => handleGoto(session, ctx)),
        },
        {
            name: "annotate",
            description:
                "Annotate code in VS Code: /annotate <file>:<start>[-<end>] [message], or a symbol name",
            handler: withPresence((ctx) => handleAnnotate(session, ctx)),
        },
        {
            name: "annotate-clear",
            description: "Remove every porthole annotation from VS Code",
            handler: withPresence(async () => session.log(await clearAnnotations())),
        },
        {
            name: "porthole",
            description:
                "Diagnose porthole: config, editors, connected windows, the companion extension, session and git",
            handler: withPresence((ctx) => doctor(session, ctx)),
        },
    ],
    tools: portholeTools(() => session),
});

// ---------------------------------------------------------------------------
// The reverse channel
// ---------------------------------------------------------------------------

// Publishing presence is what makes this session addressable from VS Code, and
// the listener is what makes "Send to Copilot" arrive. Both start at load
// rather than on first command, because the endpoint id - unlike the session
// id - is known immediately.
endpoint.start(session, { version: pluginVersion(), projectRoot: projectRoot(process.cwd()) });
outbox.start(session);


