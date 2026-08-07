// /porthole - the diagnostic report.
//
// Everything porthole depends on is invisible: a lock file, a heartbeat, which
// launcher PATH resolves to, whether a URI actually arrives. When a command
// does nothing there is no way to tell which of those failed. This prints all
// of them, marked, with the fix.
//
// It is deliberately deterministic: no model, no interpretation.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { config, configPath, copilotHome, loadConfig } from "./config.mjs";
import { callCompanion, explain, findCompanions } from "./companion.mjs";
import { connectedIdes, resolveEditorExe, resolveEditorTarget, whichEditor } from "./editor.mjs";
import * as endpoint from "./endpoint.mjs";
import { findEndpoints, portholeHome } from "./endpoint.mjs";
import { currentBranch, dirtyCount, isGitRepo, projectRoot } from "./git.mjs";

const MARK = { ok: "ok  ", warn: "warn", fail: "fail", info: "    " };

class Report {
    constructor() {
        this.lines = [];
        this.problems = [];
    }

    section(title) {
        this.lines.push("", title);
    }

    add(level, text, fix) {
        this.lines.push(`  ${MARK[level]}  ${text}`);
        // The same fix can be reached from several checks; saying it twice
        // makes the verdict look longer than the problem is.
        if (fix && (level === "fail" || level === "warn") && !this.problems.includes(fix)) {
            this.problems.push(fix);
        }
    }

    detail(text) {
        this.lines.push(`        ${text}`);
    }

    toString() {
        return this.lines.join("\n");
    }
}

export async function doctor(session, ctx) {
    const report = new Report();
    const cwd = process.cwd();

    versions(report, ctx);
    configSection(report);
    editors(report);
    ides(report, cwd);
    await companion(report, cwd);
    reverseChannel(report, session, ctx);
    await toursSection(report, cwd);
    sessionSection(report, session, ctx);
    gitSection(report, cwd);
    verdict(report);

    await session.log(`porthole doctor\n${report.toString()}`);
}

function versions(report, ctx) {
    report.section("versions");
    report.add("info", `porthole      ${pluginVersion()}`);
    report.add("info", `node          ${process.version}`);
    report.add("info", `platform      ${process.platform} ${process.arch}`);
    if (ctx?.sessionId) report.add("info", `session       ${ctx.sessionId}`);
}

export function pluginVersion() {
    // The manifest sits two levels above lib/, whether the plugin is running
    // from the repo or from the installed cache.
    const candidates = [
        new URL("../../../plugin.json", import.meta.url),
        new URL("../../plugin.json", import.meta.url),
    ];
    for (const url of candidates) {
        try {
            return JSON.parse(readFileSync(url, "utf8")).version;
        } catch {
            // try the next one
        }
    }
    return "unknown";
}

function configSection(report) {
    report.section("config");
    const loaded = loadConfig({ reload: true });

    if (!loaded.exists) {
        report.add("info", `${loaded.path} (not present, using defaults)`);
    } else if (loaded.errors.length) {
        report.add("fail", `${loaded.path} could not be used`, `fix or delete ${loaded.path}`);
        for (const error of loaded.errors) report.detail(error);
    } else {
        report.add("ok", loaded.path);
    }

    for (const warning of loaded.warnings) {
        report.add("warn", warning, `review ${loaded.path}`);
    }

    const values = loaded.values;
    report.detail(`editor             ${values.editor}`);
    report.detail(`preferConnectedIde ${values.preferConnectedIde}`);
    report.detail(`workspaceDir       ${values.workspaceDir || "(temp folder)"}`);
    report.detail(`companionTimeoutMs ${values.companionTimeoutMs}`);
    report.detail(`goto.symbolFallback ${values.goto.symbolFallback}`);

    report.add(
        process.env.PORTHOLE_EDITOR ? "info" : "info",
        `PORTHOLE_EDITOR ${process.env.PORTHOLE_EDITOR || "(unset)"}`,
    );
    if (configPath() !== join(copilotHome(), "porthole.json")) {
        report.detail(`COPILOT_HOME ${copilotHome()}`);
    }
}

function editors(report) {
    report.section("editors on PATH");
    let any = false;

    for (const name of ["code-insiders", "code", "cursor", "windsurf"]) {
        const launcher = whichEditor(name);
        if (!launcher) {
            report.add("info", `${name.padEnd(14)} not found`);
            continue;
        }
        any = true;
        report.add("ok", `${name.padEnd(14)} ${launcher}`);

        // The URI transport needs the executable, not the shim.
        const exe = resolveEditorExe(launcher);
        if (exe) {
            report.detail(`--open-url target: ${exe}`);
        } else {
            report.add(
                "warn",
                `${name}: could not find the executable beside the launcher`,
                `${name} is on PATH but its .exe was not found next to bin/; range highlighting will not work`,
            );
        }
    }

    if (!any) {
        report.add(
            "fail",
            "no editor found",
            "install VS Code and make sure its bin/ directory is on PATH",
        );
    }
}

function ides(report, cwd) {
    report.section("connected IDE windows");
    const found = connectedIdes();

    if (found.length === 0) {
        report.add("info", "none - porthole will open a new window");
    }
    for (const ide of found) {
        report.add("ok", `${ide.ideName} (pid ${ide.pid})`);
        for (const folder of ide.workspaceFolders) report.detail(folder);
    }

    const target = resolveEditorTarget(cwd);
    if (!target) {
        report.add("fail", "no editor could be resolved for this directory", "see 'editors' above");
        return;
    }
    report.add(
        "ok",
        `chosen: ${target.command}`,
    );
    report.detail(
        `because: ${describeReason(target)}${target.connected ? " (reusing that window)" : ""}`,
    );
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
            return "no preference or connected window, so the default was used";
    }
}

async function companion(report, cwd) {
    report.section("companion extension");
    const companions = findCompanions();

    if (companions.length === 0) {
        report.add(
            "fail",
            "not running in any window",
            "install it: cd vscode-extension && npm run install-local, then reload the VS Code window",
        );
        report.detail("without it: no range selection, no annotations, no symbol lookup");
        return;
    }

    for (const c of companions) {
        report.add("ok", `v${c.version} in ${c.appName} (pid ${c.pid}, ${c.uriScheme})`);
        report.detail(`session.db readable in-process: ${c.hostSqlite ? "yes" : "no, uses node"}`);
        for (const folder of c.workspaceFolders || []) report.detail(folder);
    }

    // A heartbeat only proves the window started. This proves a URI arrives,
    // which is the part that actually breaks.
    const started = Date.now();
    const ping = await callCompanion("ping", null, { contextPath: cwd });
    const elapsed = Date.now() - started;

    if (ping.ok) {
        report.add("ok", `round trip ${elapsed}ms (pid ${ping.pid})`);
    } else {
        report.add(
            "fail",
            `no answer after ${elapsed}ms (${ping.reason}): ${ping.error}`,
            "reload the VS Code window; if it persists, reinstall the companion",
        );
    }
}

/**
 * Is this session reachable from VS Code, and can the two halves see the same
 * filesystem?
 *
 * A remote or WSL window is the failure worth naming: everything looks healthy
 * on both sides, but the directories they each write to are different, so every
 * message vanishes.
 */
function reverseChannel(report, session, ctx) {
    report.section("reverse channel");

    const me = endpoint.describe(session, ctx);
    if (!me.endpointId) {
        report.add("fail", "this session has no endpoint id", "reload the extension");
        return;
    }

    report.add("ok", `addressable as ${me.endpointId}`);
    report.detail(`session ${me.sessionId || "unknown until a command runs"}`);

    const dir = join(portholeHome(), "outbox", me.endpointId);
    if (existsSync(dir)) {
        const waiting = safeCount(dir);
        report.add("ok", `outbox ready${waiting ? `, ${waiting} message(s) waiting` : ""}`);
    } else {
        report.add(
            "warn",
            "outbox directory does not exist yet",
            "reload the extension - the listener creates it at startup",
        );
    }

    for (const c of findCompanions()) {
        if (c.remoteName) {
            report.add(
                "fail",
                `a window is running in ${c.remoteName}, which cannot see this machine's files`,
                "run the CLI inside the same environment as VS Code",
            );
            continue;
        }
        if (c.copilotHome && c.copilotHome.toLowerCase() !== copilotHome().toLowerCase()) {
            report.add(
                "fail",
                `a window is using a different Copilot home (${c.copilotHome})`,
                "make COPILOT_HOME match in both",
            );
        }
    }

    const others = findEndpoints().filter((e) => e.endpointId !== me.endpointId);
    if (others.length > 0) {
        report.add("warn", `${others.length} other CLI session(s) are live`);
        report.detail("VS Code will ask which one to send to");
    }
}

/**
 * The walkthrough library.
 *
 * Worth its own section because a tour that has drifted is the failure this
 * feature is most likely to hit in practice: the explanation is still there,
 * still opens, and quietly describes code that has since changed.
 */
async function toursSection(report, cwd) {
    report.section("tours");

    const result = await callCompanion("tour-list", {}, { contextPath: cwd });
    if (!result.ok) {
        report.add("warn", `could not read the tour library: ${explain(result)}`);
        return;
    }

    const list = result.result?.tours || [];
    if (list.length === 0) {
        report.add("info", "no tours loaded or saved");
        return;
    }

    const loaded = list.filter((t) => t.loaded).length;
    const active = list.find((t) => t.active);
    report.add("ok", `${list.length} tour(s), ${loaded} loaded`);
    report.detail(active ? `walking "${active.title}" (${active.tourId})` : "none active");

    for (const t of list) {
        const s = t.staleness;
        if (!s) continue;
        const drifted = (s.changed || 0) + (s.missing || 0);
        if (drifted === 0) continue;
        report.add(
            "warn",
            `"${t.title}" has ${drifted} step(s) that no longer match the code`,
            "ask Copilot to rebuild it",
        );
    }
}

function safeCount(dir) {
    try {
        return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
        return 0;
    }
}

function sessionSection(report, session, ctx) {
    report.section("session");

    // session.workspacePath is the SDK's own answer and beats rebuilding the
    // path from the id.
    const dir =
        session.workspacePath ||
        (ctx?.sessionId ? join(copilotHome(), "session-state", ctx.sessionId) : null);

    if (!dir || !existsSync(dir)) {
        report.add("warn", "no session folder on disk yet", "run /cops once the session has state");
        return;
    }

    report.add("ok", dir);

    const db = join(dir, "session.db");
    if (existsSync(db)) {
        report.detail(`session.db ${(statSync(db).size / 1024).toFixed(0)} KB`);
    } else {
        report.detail("session.db not created yet");
    }

    report.detail(`plan.md ${existsSync(join(dir, "plan.md")) ? "present" : "none"}`);
}

function gitSection(report, cwd) {
    report.section("git");
    if (!isGitRepo(cwd)) {
        report.add("info", "not a git repository - /vsdiff is unavailable here");
        return;
    }
    const root = projectRoot(cwd);
    report.add("ok", root);
    report.detail(`branch ${currentBranch(cwd) || "unknown"}`);
    const dirty = dirtyCount(cwd);
    report.detail(dirty === 0 ? "working tree clean" : `${dirty} changed file(s)`);
}

function verdict(report) {
    report.section("verdict");
    if (report.problems.length === 0) {
        report.add("ok", "everything porthole needs is in place");
        return;
    }
    report.add("warn", `${report.problems.length} thing(s) to fix:`);
    for (const problem of report.problems) report.detail(`- ${problem}`);
}
