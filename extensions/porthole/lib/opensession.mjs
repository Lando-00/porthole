// /cops - opening the project and its session folder together.
//
// Split deliberately into two phases:
//
//   planOpenSession()  works out everything and touches nothing
//   openSession()      carries that plan out
//
// The split is what makes a dry run honest. A preview that re-derives its own
// answers is a second implementation that can disagree with the real one; this
// way the preview prints the very plan that would be executed, down to the
// argument list.

import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { callCompanion, findCompanions } from "./companion.mjs";
import { config, copilotHome } from "./config.mjs";
import { launchEditor, resolveEditorTarget } from "./editor.mjs";
import { projectRoot } from "./git.mjs";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const DRY_WORDS = new Set(["dry", "dry-run", "dryrun", "show", "preview"]);
const NO_PLAN_WORDS = new Set(["noplan", "no-plan"]);

/** Parses `/cops dry noplan` and friends. Unknown words are reported, not ignored. */
export function parseArgs(raw) {
    const words = String(raw || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = { dryRun: false, revealPlan: true, unknown: [] };

    for (const word of words) {
        if (DRY_WORDS.has(word)) out.dryRun = true;
        else if (NO_PLAN_WORDS.has(word)) out.revealPlan = false;
        else out.unknown.push(word);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function sessionFolderFor(sessionId) {
    if (!sessionId) return null;
    const dir = join(copilotHome(), "session-state", sessionId);
    return existsSync(dir) ? dir : null;
}

/**
 * The session id, from whichever source has it.
 *
 * A command handler's `ctx.sessionId` is exact. A tool call has no ctx at all,
 * so it falls back to the SDK's own `session.workspacePath`, whose basename is
 * the id - otherwise the tool could never find the session folder.
 */
function resolveSessionId(session, ctx) {
    if (ctx?.sessionId) return ctx.sessionId;
    const dir = session?.workspacePath;
    if (typeof dir === "string" && dir) return basename(dir);
    return null;
}

function portholeTempDir(leaf, { create = true } = {}) {
    const configured = config().workspaceDir;
    const dir = configured ? join(configured, leaf) : join(tmpdir(), leaf);
    // A dry run must not create directories either.
    if (create) mkdirSync(dir, { recursive: true });
    return dir;
}

function safeName(value) {
    return String(value).replace(/[^\w.-]/g, "_");
}

function shortId(value, length = 8) {
    if (!value) return "none";
    return String(value).slice(0, length);
}

function describeReason(target) {
    switch (target.reason) {
        case "env":
            return "PORTHOLE_EDITOR is set";
        case "config":
            return "the config sets 'editor'";
        case "connected-ide":
            return `Copilot is connected to ${target.ideName}`;
        default:
            return "first editor found on PATH";
    }
}

/** The plan.md in a session folder, if there is one. */
function planFileFor(sessionFolder) {
    if (!sessionFolder) return null;
    const path = join(sessionFolder, "plan.md");
    try {
        const stat = statSync(path);
        if (!stat.isFile()) return null;
        return { path, exists: true, sizeBytes: stat.size, modified: stat.mtime.toISOString() };
    } catch {
        return { path, exists: false };
    }
}

/**
 * Works out exactly what opening the session would do.
 *
 * Pure: no launching, no files written, no directories created. Everything the
 * executor needs is on the returned object.
 */
export function planOpenSession(session, ctx, options = {}) {
    const revealPlanRequested = options.revealPlan !== false;

    const cwd = process.cwd();
    const root = projectRoot(cwd);
    const projectName = basename(root);
    const sessionId = resolveSessionId(session, ctx);
    const sessionFolder = sessionFolderFor(sessionId);
    const planFile = planFileFor(sessionFolder);

    const target = resolveEditorTarget(root);
    if (!target) {
        return {
            ok: false,
            error:
                "no editor found. Install VS Code and make sure 'code-insiders' or 'code' is on PATH.",
            cwd,
            projectRoot: root,
            projectName,
            sessionId,
            sessionFolder,
            planFile,
        };
    }

    const revealPlan = revealPlanRequested && Boolean(planFile && planFile.exists);
    const plan = {
        ok: true,
        error: null,
        cwd,
        projectRoot: root,
        projectName,
        sessionId,
        sessionFolder,
        planFile,
        revealPlanRequested,
        revealPlan,
        editor: {
            command: target.command,
            connected: Boolean(target.connected),
            ideName: target.ideName,
            reason: target.reason,
            because: describeReason(target),
        },
        steps: [],
    };

    if (target.connected) {
        // Reuse the window the user is already in rather than opening a second
        // one on a generated workspace.
        plan.action = "reuse-window";
        plan.workspaceFile = null;
        plan.addFolder = sessionFolder || root;
        plan.folders = null;
        plan.steps.push({
            what: sessionFolder
                ? `add the session folder to the connected ${target.ideName} window`
                : `add the project to the connected ${target.ideName} window (no session folder on disk yet)`,
            command: target.command,
            args: ["--reuse-window", "--add", plan.addFolder],
        });

        if (revealPlan) {
            // --add swallows --goto in the same invocation: the folder is added
            // and the file silently never opens. Verified on Insiders 1.132.
            // So this is a separate step, preferring the companion because it
            // acknowledges the request and targets the right window.
            plan.steps.push({
                what: "reveal plan.md",
                via: "companion, falling back to a second --goto launch",
                command: target.command,
                args: ["--reuse-window", "--goto", `${planFile.path}:1`],
            });
        }
        return plan;
    }

    plan.action = "new-workspace";
    plan.addFolder = null;

    const folders = [{ path: root, name: projectName }];
    if (sessionFolder) {
        folders.push({ path: sessionFolder, name: `Copilot Session (${shortId(sessionId)})` });
    }
    plan.folders = folders;

    // The name is stable per project+session, so re-running focuses the same
    // window instead of piling up duplicates.
    //
    // It lives in the session folder rather than the temp directory, and that
    // is a workspace-trust decision rather than a tidiness one. VS Code trusts
    // "folders, their subfolders, and workspace files" - so a workspace file
    // inside an already-trusted folder is trusted with it, while one in the
    // temp directory has to be trusted on its own, every session, forever.
    //
    // The cost of getting this wrong is not a dialog. An untrusted workspace
    // silently does not activate extensions, so the companion never starts,
    // every route times out, and nothing says why.
    const outDir = sessionFolder || portholeTempDir("porthole-workspaces", { create: false });
    plan.workspaceFile = join(
        outDir,
        sessionFolder
            ? `${safeName(projectName)}.code-workspace`
            : `${safeName(projectName)}-${shortId(sessionId)}.code-workspace`,
    );
    plan.workspaceExists = existsSync(plan.workspaceFile);

    // A workspace argument and --goto DO work together, unlike --add.
    const args = revealPlan
        ? [plan.workspaceFile, "--goto", `${planFile.path}:1`]
        : [plan.workspaceFile];

    plan.steps.push({
        what: `write ${plan.workspaceExists ? "and overwrite" : ""} the workspace file`.replace(
            /\s+/g,
            " ",
        ),
        writes: plan.workspaceFile,
    });
    plan.steps.push({
        what: revealPlan
            ? `open '${projectName}' + the session folder in one workspace, at plan.md`
            : `open '${projectName}'${sessionFolder ? " + the session folder" : ""} in one workspace`,
        command: target.command,
        args,
    });

    return plan;
}

// ---------------------------------------------------------------------------
// Describing
// ---------------------------------------------------------------------------

function bytes(n) {
    if (n === undefined || n === null) return "";
    if (n < 1024) return `${n} B`;
    return `${Math.round(n / 1024)} KB`;
}

/** The dry-run report: what would happen, and nothing happening. */
export function describePlan(plan) {
    const lines = ["porthole: dry run - nothing was opened or written.", ""];

    if (!plan.ok) {
        lines.push(`  PROBLEM   ${plan.error}`, "");
    }

    lines.push(`  project   ${plan.projectRoot}`);
    if (plan.projectRoot !== plan.cwd) lines.push(`  cwd       ${plan.cwd}`);

    lines.push(
        `  session   ${
            plan.sessionFolder ||
            (plan.sessionId ? "no folder on disk yet" : "unknown - no session id available")
        }`,
    );

    if (plan.planFile && plan.planFile.exists) {
        lines.push(
            `  plan.md   ${bytes(plan.planFile.sizeBytes)}, modified ${plan.planFile.modified.slice(0, 16).replace("T", " ")}`,
        );
    } else if (plan.sessionFolder) {
        lines.push("  plan.md   none in this session folder");
    }

    if (plan.ok) {
        lines.push(
            "",
            `  editor    ${plan.editor.command}`,
            `  because   ${plan.editor.because}`,
            `  window    ${
                plan.editor.connected
                    ? `reuse the connected ${plan.editor.ideName} window`
                    : "open a new window on a generated workspace"
            }`,
        );

        if (plan.revealPlanRequested && !plan.revealPlan) {
            lines.push("  plan.md   would not be revealed - there is none to reveal");
        } else if (!plan.revealPlanRequested) {
            lines.push("  plan.md   reveal disabled for this run");
        }

        lines.push("", "  would then:");
        for (const [i, step] of plan.steps.entries()) {
            lines.push(`    ${i + 1}. ${step.what}`);
            if (step.writes) {
                lines.push(
                    `       write  ${step.writes}${plan.workspaceExists ? "  (overwriting)" : ""}`,
                );
            }
            if (step.command) {
                lines.push(`       run    ${[step.command, ...step.args].join(" ")}`);
            }
            if (step.via) lines.push(`       via    ${step.via}`);
        }

        if (plan.folders) {
            lines.push("", "  workspace folders:");
            for (const f of plan.folders) lines.push(`    ${f.name}  ${f.path}`);
        }
    }

    lines.push("", "  Run /cops to do it.");
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

function writeJson(path, value) {
    writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8" });
}

/**
 * Reveals plan.md in a window that is already open.
 *
 * The companion is preferred because it answers, so a failure is visible
 * rather than assumed. Without one, a second --goto launch is the best
 * available, and cannot be confirmed.
 */
async function revealPlanFile(session, plan) {
    const result = await callCompanion(
        "reveal",
        { file: plan.planFile.path, startLine: 1, endLine: 1 },
        { contextPath: plan.projectRoot },
    );
    if (result.ok) return "revealed plan.md";

    launchEditor(session, plan.editor.command, [
        "--reuse-window",
        "--goto",
        `${plan.planFile.path}:1`,
    ]);
    return "opened plan.md";
}

/**
 * Carries out a plan.
 *
 * Returns the message to show, rather than logging it, so the same code serves
 * both the slash command and the tool.
 */
export async function openSession(session, ctx, options = {}) {
    const plan = planOpenSession(session, ctx, options);

    if (options.dryRun) return describePlan(plan);
    if (!plan.ok) return `porthole: ${plan.error}`;

    if (plan.action === "reuse-window") {
        launchEditor(session, plan.editor.command, ["--reuse-window", "--add", plan.addFolder]);

        let planNote = "";
        if (plan.revealPlan) {
            planNote = `\n  ${await revealPlanFile(session, plan)}`;
        }

        return plan.sessionFolder
            ? `porthole: added the session folder to the connected ${plan.editor.ideName} window.\n` +
                  `  project: ${plan.projectRoot}\n  session: ${plan.sessionFolder}${planNote}`
            : `porthole: no session folder on disk yet; added the project to the connected ${plan.editor.ideName} window.`;
    }

    const workspace = {
        folders: plan.folders,
        settings: {
            // Makes diagrams written into the session folder open rendered.
            "workbench.editorAssociations": {
                "*.diagram.md": "vscode.markdown.preview.editor",
            },
        },
    };

    // Only created when the session folder is unavailable and we have fallen
    // back to temp; the session folder itself already exists.
    if (!plan.sessionFolder) portholeTempDir("porthole-workspaces");
    try {
        writeJson(plan.workspaceFile, workspace);
    } catch (err) {
        return `porthole: could not write the workspace file - ${err.message}`;
    }

    const launchStep = plan.steps[plan.steps.length - 1];
    launchEditor(session, plan.editor.command, launchStep.args);

    const planNote = plan.revealPlan ? "\n  opened plan.md" : "";
    // Callers that wait for the companion themselves pass false, so the two
    // waits do not stack.
    const trustNote = options.notifyIfSilent === false ? "" : await noteIfNothingCameUp(plan);

    return plan.sessionFolder
        ? `porthole: opened '${plan.projectName}' + the Copilot session folder in one workspace.\n` +
              `  project: ${plan.projectRoot}\n  session: ${plan.sessionFolder}${planNote}${trustNote}`
        : `porthole: opened '${plan.projectName}'. No session folder found on disk yet.${trustNote}`;
}

/**
 * Says so when the new window came up without the companion.
 *
 * Almost always workspace trust: an untrusted workspace activates no
 * extensions, and VS Code does that silently. Without this the window simply
 * opens, every porthole route times out, and nothing anywhere explains why -
 * which is a worse experience than the dialog it is trying to explain.
 *
 * The parent-folder hint matters. Trusting just this workspace fixes today and
 * asks again next session; trusting the session-state folder covers every
 * session there will ever be, because VS Code trusts "folders, their
 * subfolders, and workspace files".
 */
async function noteIfNothingCameUp(plan) {
    // Enough for the window to start and the extension host to publish, but not
    // so long that /cops feels slow when something is genuinely wrong.
    for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        if (findCompanions().length > 0) return "";
    }

    const parent = plan.sessionFolder ? dirname(plan.sessionFolder) : null;
    return (
        "\n  the companion has not reported in. VS Code is probably asking whether you trust" +
        "\n  this workspace - until you say yes it disables every extension, porthole included." +
        (parent
            ? `\n  Choose the parent folder (${parent}) and it will not ask again.`
            : "")
    );
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function tools(getSession) {
    return [
        {
            name: "porthole_open_session",
            description:
                "Open the user's project and their current Copilot session folder together in " +
                "one VS Code workspace - the same thing the /cops command does. " +
                "ONLY call this when the user has explicitly asked you to open, show or set up " +
                "their session, workspace or editor. NEVER call it proactively, speculatively, " +
                "or because it might be convenient: it takes over the user's screen by opening " +
                "or re-arranging windows, which is disruptive if they did not ask for it. " +
                "If you are unsure whether they want it, ask instead of calling. " +
                "Use dryRun to describe what would happen without touching anything, which is " +
                "always safe.",
            parameters: {
                type: "object",
                properties: {
                    dryRun: {
                        type: "boolean",
                        description:
                            "Preview only: report the editor that would be used, whether an " +
                            "existing window would be reused, the paths involved and whether " +
                            "plan.md would open - without launching anything or writing any " +
                            "file. Default false.",
                    },
                    revealPlan: {
                        type: "boolean",
                        description:
                            "Open the session's plan.md as the active editor when one exists. " +
                            "Default true. Set false if the user only wants the folders open.",
                    },
                },
            },
            // No ctx: a tool call gets its session id from session.workspacePath.
            handler: async (args) =>
                openSession(getSession(), null, {
                    dryRun: Boolean(args?.dryRun),
                    revealPlan: args?.revealPlan !== false,
                }),
        },
    ];
}
