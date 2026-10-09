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
import { classifyOwnership } from "./ownership.mjs";
import { withDeliveryNotes } from "./delivery-notes.mjs";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const DRY_WORDS = new Set(["dry", "dry-run", "dryrun", "show", "preview"]);
const NO_PLAN_WORDS = new Set(["noplan", "no-plan"]);

// How long to wait for a freshly launched window to publish its presence, and
// how often to look. The budget is unchanged from the original twelve one-second
// ticks; only the granularity is finer, so a window that comes up quickly is
// noticed quickly instead of being rounded up to the next second.
const COMPANION_WAIT_MS = 12_000;
const COMPANION_POLL_MS = 200;

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
export function resolveSessionId(session, ctx) {
    if (ctx?.sessionId) return ctx.sessionId;
    const dir = session?.workspacePath;
    if (typeof dir === "string" && dir) return basename(dir);
    return null;
}

export function resolveSessionPath(session, ctx) {
    if (typeof session?.workspacePath === "string" && session.workspacePath) {
        return session.workspacePath;
    }
    return sessionFolderFor(resolveSessionId(session, ctx));
}

function windowSummary(companion) {
    return {
        windowId: companion.windowId || null,
        pid: companion.pid,
        appName: companion.appName || companion.ideName || "VS Code",
        sessionId: companion.sessionId || null,
        sessionFolder: companion.sessionFolder || null,
        sessionLabel: companion.sessionLabel || null,
        repository: companion.repository || null,
        branch: companion.branch || null,
        connectionHealth: companion.connectionHealth || null,
        compatibility: companion.compatibility || null,
        workspaceFolders: companion.workspaceFolders || [],
    };
}

function companionHasSession(companion, sessionId, sessionFolder) {
    return classifyOwnership(companion, { sessionId, sessionPath: sessionFolder }) === "owned";
}

function isBoundToDifferentSession(companion, sessionId, sessionFolder) {
    return !["owned", "unbound"].includes(
        classifyOwnership(companion, { sessionId, sessionPath: sessionFolder }),
    );
}

/**
 * Oldest window first, matching the primary rule in companion.mjs.
 *
 * `startedAt` is fixed for an extension host's lifetime; `updatedAt` changes on
 * every handled request, so it cannot decide which window came first.
 */
function bySessionWindowAge(a, b) {
    const left = Date.parse(a.startedAt);
    const right = Date.parse(b.startedAt);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    if (Number.isFinite(left)) return -1;
    if (Number.isFinite(right)) return 1;
    return String(a.windowId || "").localeCompare(String(b.windowId || ""));
}

/**
 * Pure window policy. It never reads the filesystem or launches an editor.
 */
export function chooseWindowAction({
    mode = "auto",
    windowId = null,
    sessionId = null,
    sessionFolder = null,
    companions = [],
} = {}) {
    const requested = ["auto", "new", "reuse"].includes(mode) ? mode : null;
    const candidates = companions.map(windowSummary);
    if (!requested) {
        return { ok: false, action: "refuse", error: `unknown window mode '${mode}'`, candidates };
    }
    if (windowId && requested !== "reuse") {
        return {
            ok: false,
            action: "refuse",
            error: "windowId requires mode 'reuse'; omit windowId for automatic or new-window behavior",
            candidates,
        };
    }

    if (requested === "new") return { ok: true, action: "new-workspace", candidates: [] };
    if (requested === "reuse" && !sessionId && !sessionFolder) {
        return {
            ok: false,
            action: "refuse",
            error: "this Copilot session's identity is unknown; no window can be safely reused",
            candidates,
        };
    }

    const exact = companions.filter((c) => companionHasSession(c, sessionId, sessionFolder));
    if (requested === "auto") {
        if (exact.length > 0) {
            // Several windows owned by one session is not an error. Ownership is
            // which session folder is open in a window, and a session may hold
            // more than one - usually because it was deliberately asked for a
            // second. The oldest is the primary and answers for the session;
            // refusing here used to break /cops for a layout the user chose.
            const [primary] = [...exact].sort(bySessionWindowAge);
            return {
                ok: true,
                action: "existing-window",
                companion: windowSummary(primary),
                candidates: [],
            };
        }
        return { ok: true, action: "new-workspace", candidates: [] };
    }

    if (windowId) {
        const selected = companions.find((c) => c.windowId === windowId);
        if (!selected) {
            return {
                ok: false,
                action: "refuse",
                error: `window '${windowId}' is no longer available`,
                candidates,
            };
        }
        if (isBoundToDifferentSession(selected, sessionId, sessionFolder)) {
            return {
                ok: false,
                action: "refuse",
                error:
                    `window '${windowId}' is already bound to Copilot session ` +
                    `'${selected.sessionId || "unknown"}'; reusing it would mix two sessions`,
                candidates: [windowSummary(selected)],
            };
        }
        return {
                  ok: true,
                  action: "reuse-window",
                  companion: windowSummary(selected),
                  candidates: [],
              };
    }

    if (companions.length === 1) {
        if (isBoundToDifferentSession(companions[0], sessionId, sessionFolder)) {
            return {
                ok: false,
                action: "refuse",
                error:
                    "the only available window is already bound to another Copilot session; " +
                    "open a new window instead",
                candidates: companions.map(windowSummary),
            };
        }
        return {
            ok: true,
            action: "reuse-window",
            companion: windowSummary(companions[0]),
            candidates: [],
        };
    }
    if (companions.length === 0) {
        return {
            ok: false,
            action: "refuse",
            error: "there is no running porthole window to reuse",
            candidates: [],
        };
    }
    return {
        ok: false,
        action: "refuse",
        error: "more than one VS Code window is available; choose one before reusing",
        candidates,
    };
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

export function workspaceLaunchArgs(workspaceFile, planFile = null) {
    return planFile
        ? ["--new-window", workspaceFile, "--goto", `${planFile}:1`]
        : ["--new-window", workspaceFile];
}

/**
 * Works out exactly what opening the session would do.
 *
 * Pure: no launching, no files written, no directories created. Everything the
 * executor needs is on the returned object.
 */
export function planOpenSession(session, ctx, options = {}) {
    const revealPlanRequested = options.revealPlan !== false;
    const mode = options.mode || "auto";

    const cwd = process.cwd();
    const root = projectRoot(cwd);
    const projectName = basename(root);
    const sessionId = resolveSessionId(session, ctx);
    const sessionFolder = sessionFolderFor(sessionId);
    const planFile = planFileFor(sessionFolder);
    const windowChoice = chooseWindowAction({
        mode,
        windowId: options.windowId || null,
        sessionId,
        sessionFolder,
        companions: findCompanions(),
    });

    const target = resolveEditorTarget(root);
    if (!target && windowChoice.action === "new-workspace") {
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
        ok: windowChoice.ok,
        error: windowChoice.error || null,
        cwd,
        projectRoot: root,
        projectName,
        sessionId,
        sessionFolder,
        planFile,
        revealPlanRequested,
        revealPlan,
        editor: {
            command: target?.command || null,
            connected: Boolean(windowChoice.companion),
            ideName: target?.ideName || windowChoice.companion?.appName || null,
            reason: target?.reason || "companion",
            because: target ? describeReason(target) : "the selected companion is already running",
        },
        mode,
        companion: windowChoice.companion || null,
        candidates: windowChoice.candidates || [],
        steps: [],
    };

    if (!windowChoice.ok) {
        plan.action = "refuse";
        plan.workspaceFile = null;
        plan.addFolder = null;
        plan.folders = null;
        return plan;
    }

    if (windowChoice.action === "existing-window") {
        plan.action = "existing-window";
        plan.workspaceFile = null;
        plan.addFolder = null;
        plan.folders = null;
        if (revealPlan) {
            plan.steps.push({
                what: "reveal plan.md in the window already bound to this Copilot session",
                via: `companion window ${windowChoice.companion.windowId}`,
            });
        }
        return plan;
    }

    if (windowChoice.action === "reuse-window") {
        plan.action = "reuse-window";
        plan.workspaceFile = null;
        plan.addFolder = sessionFolder;
        plan.folders = null;
        plan.steps.push({
            what: `add the project and session folder to window ${windowChoice.companion.windowId}`,
            via: "the addressed porthole companion",
        });

        if (revealPlan) {
            plan.steps.push({
                what: "reveal plan.md",
                via: `companion window ${windowChoice.companion.windowId}`,
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
    const args = workspaceLaunchArgs(plan.workspaceFile, revealPlan ? planFile.path : null);

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
        for (const candidate of plan.candidates || []) {
            lines.push(
                `  candidate ${candidate.windowId || "legacy"}  ${candidate.appName}` +
                    `  session ${candidate.sessionId || "unbound"}`,
            );
            for (const folder of candidate.workspaceFolders || []) lines.push(`            ${folder}`);
        }
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
            `  editor    ${plan.editor.command || plan.companion?.appName || "running companion"}`,
            `  because   ${plan.editor.because}`,
            `  window    ${
                plan.action === "existing-window"
                    ? `use this session's existing window (${plan.companion.windowId})`
                    : plan.action === "reuse-window"
                      ? `reuse selected window ${plan.companion.windowId}`
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
        {
            contextPath: plan.projectRoot,
            sessionId: plan.sessionId,
            sessionPath: plan.sessionFolder,
            windowId: plan.companion?.windowId,
        },
    );
    if (result.ok) return withDeliveryNotes(result, "revealed plan.md");

    return withDeliveryNotes(result, `could not reveal plan.md - ${result.error || result.reason}`);
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

    if (plan.action === "existing-window") {
        let planNote = "";
        if (plan.revealPlan) planNote = `\n  ${await revealPlanFile(session, plan)}`;
        return (
            "porthole: this Copilot session already has its own VS Code window.\n" +
            `  project: ${plan.projectRoot}\n  session: ${plan.sessionFolder}${planNote}`
        );
    }

    if (plan.action === "reuse-window") {
        if (!plan.sessionId || !plan.sessionFolder) {
            return "porthole: this Copilot session's folder is unavailable; the selected window was not changed.";
        }
        const folders = [plan.projectRoot, plan.sessionFolder].filter(Boolean);
        const added = await callCompanion(
            "workspace-add",
            { folders },
            {
                windowId: plan.companion.windowId,
                contextPath: plan.projectRoot,
                sessionId: plan.sessionId,
                sessionPath: plan.sessionFolder,
                adoptUnbound: classifyOwnership(plan.companion, {
                    sessionId: plan.sessionId,
                    sessionPath: plan.sessionFolder,
                }) === "unbound",
            },
        );
        if (!added.ok) {
            return withDeliveryNotes(added, `porthole: could not reuse the selected window - ${added.error || added.reason}`);
        }

        let planNote = "";
        if (plan.revealPlan) {
            planNote = `\n  ${await revealPlanFile(session, plan)}`;
        }

        return withDeliveryNotes(added,
            `porthole: reused the selected ${plan.companion.appName} window.\n` +
            `  project: ${plan.projectRoot}\n` +
            `  session: ${plan.sessionFolder || "no session folder on disk yet"}${planNote}`
        );
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
    const trustNote =
        options.notifyIfSilent === false ? "" : await noteIfNothingCameUp(plan);

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
    //
    // Checked before the first sleep and polled several times a second, because
    // sleeping first charged every successful /cops a full second it never
    // needed, and a one-second tick then rounded the answer up on top of that.
    const deadline = Date.now() + COMPANION_WAIT_MS;
    for (;;) {
        if (
            findCompanions().some((companion) =>
                companionHasSession(companion, plan.sessionId, plan.sessionFolder),
            )
        ) {
            return "";
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(COMPANION_POLL_MS, remaining)));
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

export function windows() {
    const companions = findCompanions().map(windowSummary);
    if (companions.length === 0) return "porthole: no companion windows are running.";

    const lines = [`porthole: ${companions.length} companion window(s).`];
    for (const window of companions) {
        const folders = window.workspaceFolders.length
            ? window.workspaceFolders.join(" | ")
            : "(no workspace folders)";
        lines.push(
            `  ${window.windowId || "legacy"}  ${window.appName}  ` +
                `${window.sessionLabel || `session ${window.sessionId || "unbound"}`}` +
                `${window.repository ? `  ${window.repository}${window.branch ? `@${window.branch}` : ""}` : ""}` +
                `${window.connectionHealth ? `  ${window.connectionHealth}` : ""}` +
                (window.compatibility
                    ? `  update ${window.compatibility.updateTarget}: ` +
                      `${(window.compatibility.missingCapabilities || []).join(", ")}`
                    : ""),
            `      ${folders}`,
        );
    }
    return lines.join("\n");
}

export async function focusWindow(options = {}, session = null) {
    const sessionPath = resolveSessionPath(session, null);
    const result = await callCompanion("focus", null, {
        contextPath: process.cwd(),
        sessionId: resolveSessionId(session, null),
        sessionPath,
        windowId: options.windowId || null,
    });
    if (!result.ok) {
        return withDeliveryNotes(result, `porthole: could not focus the window - ${result.error || result.reason}`);
    }
    return withDeliveryNotes(result, result.focused
        ? "porthole: focused the exact VS Code window for this Copilot session."
        : "porthole: requested attention from the exact VS Code window for this Copilot session.");
}

export function tools(getSession) {
    return [
        {
            name: "porthole_open_session",
            description:
                "Open the user's project and their current Copilot session folder together in " +
                "one VS Code workspace. Default mode 'auto' does the safe /cops behavior: reuse " +
                "only a window already bound to this exact Copilot session, otherwise open a " +
                "new window. Use mode 'new' when the user asks for separation. Use mode 'reuse' " +
                "only when the user explicitly asks to use an unbound existing window. A window " +
                "already bound to another Copilot session is refused, because one companion " +
                "window cannot safely represent two sessions. If several windows exist, call " +
                "porthole_windows, ask the user which one " +
                "they mean, then pass its windowId; never guess. " +
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
                    mode: {
                        type: "string",
                        enum: ["auto", "new", "reuse"],
                        description:
                            "'auto' (default) reuses only this session's existing window, else " +
                            "opens a new one. 'new' forces a separate window. 'reuse' adds this " +
                            "project/session to one explicitly selected unbound window.",
                    },
                    windowId: {
                        type: "string",
                        description:
                            "Exact id from porthole_windows. Use with mode 'reuse' when more than " +
                            "one window exists. Never invent or guess it.",
                    },
                },
            },
            // No ctx: a tool call gets its session id from session.workspacePath.
            handler: async (args) =>
                openSession(getSession(), null, {
                    dryRun: Boolean(args?.dryRun),
                    revealPlan: args?.revealPlan !== false,
                    mode: args?.mode || "auto",
                    windowId: args?.windowId || null,
                }),
        },
        {
            name: "porthole_windows",
            description:
                "List the live VS Code windows running the porthole companion, including each " +
                "window's stable id, workspace folders, and bound Copilot session. Call this " +
                "when the user asks to reuse an existing window and more than one might match. " +
                "Show the human-readable choices and ask the user which one they mean; then pass " +
                "the selected windowId to porthole_open_session. This tool is read-only.",
            parameters: { type: "object", properties: {} },
            handler: async () => windows(),
        },
        {
            name: "porthole_focus_window",
            description:
                "Focus the exact VS Code window bound to the current Copilot session without " +
                "opening, reusing, or modifying any workspace. If the user selected a window " +
                "from porthole_windows, pass its windowId. Never guess between multiple windows. " +
                "ONLY call this when the user explicitly asks to focus, bring forward, or switch " +
                "to a VS Code window because it deliberately changes their foreground context.",
            parameters: {
                type: "object",
                properties: {
                    windowId: {
                        type: "string",
                        description:
                            "Optional exact id from porthole_windows. Omit it to target the " +
                            "window bound to the current Copilot session.",
                    },
                },
            },
            handler: async (args) => focusWindow(args, getSession()),
        },
    ];
}
