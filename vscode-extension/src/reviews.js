// Saved reviews.
//
// A review is a set of findings plus enough context to make sense of them
// later: which repository, which commit, and - critically - what the code
// actually said at the time.
//
// The point is that a later session can pick one up. Reviews are written into
// the session folder that produced them, but loading scans every session
// folder, so "the findings from yesterday's audit" survives the session that
// produced them.
//
// The hard part is not storage, it is honesty. Line numbers rot: after a few
// edits, line 25 may be something else entirely, and showing a finding against
// innocent code is the worst thing a review tool can do. Every finding
// therefore carries a hash of the text it was written about, and loading
// reports how many still apply. That machinery lives in ./anchors, because
// saved tours need exactly the same thing.

const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const { diag } = require("./log");
const anchors = require("./anchors");
const annotations = require("./annotations");
const tour = require("./tour");
const { findSession, sessionRoot } = require("./session");

const SCHEMA = 1;
const SLUG_PATTERN = /^[\w-]{1,64}$/;

// --- saving -----------------------------------------------------------------

function save(payload = {}) {
    const session = findSession();
    if (!session) {
        return {
            ok: false,
            error: "no Copilot session folder found for this window; run /cops first",
        };
    }

    const findings = collectFindings();
    if (findings.length === 0) {
        return { ok: false, error: "there are no annotations or tour steps to save" };
    }

    const title = String(payload.title || "").trim() || defaultTitle();
    const slug = normaliseSlug(payload.slug || title);
    if (!SLUG_PATTERN.test(slug)) {
        return { ok: false, error: `'${slug}' is not a usable name` };
    }

    const repo = projectFolder();
    const review = {
        schema: SCHEMA,
        slug,
        title,
        createdAt: new Date().toISOString(),
        sessionId: session.id,
        repo,
        branch: repo ? gitHead(repo).branch : null,
        commit: repo ? gitHead(repo).commit : null,
        findings: findings.map((f) => toFinding(f, repo)),
    };

    const dir = path.join(session.dir, "porthole", "reviews");
    const file = path.join(dir, `${slug}.json`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        // Write then rename, so a reader never sees a half-written review.
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(review, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (err) {
        return { ok: false, error: `could not write the review: ${err.message}` };
    }

    diag(`review saved: ${file} (${review.findings.length} findings)`);
    return { ok: true, result: { file, slug, findings: review.findings.length } };
}

/**
 * Whatever is currently on screen.
 *
 * A tour wins when one is running, because its narration and ordering are
 * richer than a flat annotation set.
 */
function collectFindings() {
    const activeTour = tour.getState();
    if (activeTour.steps.length > 0) {
        return activeTour.steps.map((s) => ({
            file: s.file,
            startLine: s.startLine,
            endLine: s.endLine,
            severity: s.severity,
            stepTitle: s.stepTitle,
            message: s.stepTitle,
            narration: s.narration,
        }));
    }
    return annotations.getState().entries.map((e) => ({
        file: e.file,
        startLine: e.startLine,
        endLine: e.endLine,
        severity: e.severity,
        message: e.message,
    }));
}

function defaultTitle() {
    return tour.getState().title || annotations.getState().title || "review";
}

function toFinding(f, repo) {
    const out = {
        file: repo && isInside(repo, f.file) ? path.relative(repo, f.file) : f.file,
        startLine: f.startLine,
        endLine: f.endLine,
        severity: f.severity || "info",
        message: f.message || "",
    };
    if (f.stepTitle) out.stepTitle = f.stepTitle;
    if (f.narration) out.narration = f.narration;

    const anchor = anchors.anchorFor(f.file, f.startLine, f.endLine);
    if (anchor) out.anchor = anchor;
    return out;
}

// --- listing ----------------------------------------------------------------

/**
 * Every review on this machine, newest first.
 *
 * Scans sibling session folders rather than just this one: a review is only
 * useful if a later session can find it.
 */
function list(payload = {}) {
    const limit = Math.min(200, Math.max(1, Number.parseInt(payload.limit, 10) || 50));
    const wantRepo = payload.repo ? String(payload.repo).toLowerCase() : null;
    const root = sessionRoot();

    let sessions = [];
    try {
        sessions = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return { ok: true, result: { reviews: [] } };
    }

    const reviews = [];
    for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name, "porthole", "reviews");
        let files = [];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        } catch {
            continue;
        }
        for (const name of files) {
            const file = path.join(dir, name);
            const review = readReview(file);
            if (!review) continue;
            if (wantRepo && String(review.repo || "").toLowerCase() !== wantRepo) continue;
            reviews.push({
                slug: review.slug,
                title: review.title,
                file,
                createdAt: review.createdAt,
                sessionId: review.sessionId,
                repo: review.repo,
                branch: review.branch,
                findings: (review.findings || []).length,
            });
        }
    }

    reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { ok: true, result: { reviews: reviews.slice(0, limit) } };
}

function readReview(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || parsed.schema !== SCHEMA) return null;
        return parsed;
    } catch {
        return null;
    }
}

// --- loading ----------------------------------------------------------------

async function load(payload = {}) {
    const file = payload.file ? resolveReviewPath(payload.file) : findBySlug(payload.slug);
    if (!file) {
        return {
            ok: false,
            error: payload.file
                ? "that path is not inside a session's reviews folder"
                : `no review found for '${payload.slug}'`,
        };
    }

    const review = readReview(file);
    if (!review) return { ok: false, error: `could not read a review from ${file}` };

    const resolution = anchors.tally();
    const entries = [];
    const resolved = [];

    for (const finding of review.findings || []) {
        const absolute = absoluteFile(finding.file, review.repo);
        const state = anchors.resolve(finding, absolute);
        resolution[state.status] += 1;

        // The resolved range, not the stored one, is what callers get. The CLI
        // cannot see the screen, so if it were handed the original line numbers
        // it would read or edit whatever now sits there - the exact failure the
        // anchors exist to prevent.
        resolved.push({
            ...finding,
            startLine: state.startLine,
            endLine: state.endLine,
            status: state.status,
        });

        if (state.status === "missing") continue;

        entries.push({
            file: absolute,
            startLine: state.startLine,
            endLine: state.endLine,
            severity: state.status === "changed" ? "warn" : finding.severity,
            message: describe(finding, state.status),
        });
    }

    if (entries.length === 0) {
        return {
            ok: false,
            error: "none of this review's files still exist",
            result: { review: { ...review, findings: resolved }, resolution },
        };
    }

    await annotations.annotate({
        title: `${review.title} (${review.createdAt.slice(0, 10)})`,
        clearExisting: true,
        annotations: entries,
    });

    diag(`review loaded: ${file} ${JSON.stringify(resolution)}`);
    return {
        ok: true,
        result: { review: { ...review, findings: resolved }, resolution, file },
    };
}

/** How a finding reads once we know whether it still applies. */
function describe(finding, status) {
    const head = finding.stepTitle ? `**${finding.stepTitle}**\n\n` : "";
    const body = finding.narration || finding.message || "";
    if (status === "resolved") return `${head}${body}`;
    if (status === "shifted") {
        return `${head}${body}\n\n_(this code moved since the review was saved)_`;
    }
    return `${head}${body}\n\n_(the code here has changed since the review was saved, so this may no longer apply)_`;
}

function findBySlug(slug) {
    if (!slug || !SLUG_PATTERN.test(String(slug))) return null;
    const match = list({ limit: 200 }).result.reviews.find((r) => r.slug === slug);
    return match ? match.file : null;
}

/**
 * Containment.
 *
 * `file` comes from outside, and without this check `review-load` is an
 * arbitrary JSON file reader.
 */
function resolveReviewPath(file) {
    const resolved = path.resolve(String(file));
    const root = path.resolve(sessionRoot());
    if (!isInside(root, resolved)) return null;
    const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
    // <sessionId>/porthole/reviews/<name>.json
    if (parts.length !== 4) return null;
    if (parts[1] !== "porthole" || parts[2] !== "reviews") return null;
    if (!parts[3].endsWith(".json")) return null;
    return resolved;
}

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function absoluteFile(file, repo) {
    if (path.isAbsolute(file)) return file;
    if (repo) return path.join(repo, file);
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    return folder ? path.join(folder.uri.fsPath, file) : file;
}

// --- context ----------------------------------------------------------------

function projectFolder() {
    const root = sessionRoot().toLowerCase();
    const folder = (vscode.workspace.workspaceFolders || [])
        .map((f) => f.uri.fsPath)
        .find((p) => !p.toLowerCase().startsWith(root));
    return folder || null;
}

/** Reads .git directly, which is cheaper and more predictable than shelling out. */
function gitHead(dir) {
    try {
        const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
        const ref = /^ref:\s*(.+)$/.exec(head);
        if (!ref) return { branch: null, commit: head.slice(0, 7) };
        const branch = ref[1].replace(/^refs\/heads\//, "");
        let commit = null;
        try {
            commit = fs
                .readFileSync(path.join(dir, ".git", ref[1]), "utf8")
                .trim()
                .slice(0, 7);
        } catch {
            commit = null;
        }
        return { branch, commit };
    } catch {
        return { branch: null, commit: null };
    }
}

function normaliseSlug(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^\w-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

// --- commands ---------------------------------------------------------------

async function saveCommand() {
    const title = await vscode.window.showInputBox({
        title: "porthole: save review",
        prompt: "A name for this review",
        value: defaultTitle(),
    });
    if (title === undefined) return;
    const result = save({ title });
    vscode.window.showInformationMessage(
        result.ok
            ? `porthole: saved ${result.result.findings} finding(s) as '${result.result.slug}'.`
            : `porthole: ${result.error}`,
    );
}

async function loadCommand() {
    const { reviews } = list({ limit: 100 }).result;
    if (reviews.length === 0) {
        vscode.window.showInformationMessage("porthole: no saved reviews.");
        return;
    }
    const picked = await vscode.window.showQuickPick(
        reviews.map((r) => ({
            label: `$(checklist) ${r.title}`,
            description: `${r.findings} finding(s) · ${String(r.createdAt).slice(0, 10)}`,
            detail: r.repo || "",
            file: r.file,
        })),
        { title: "porthole: load review", placeHolder: "Pick a review" },
    );
    if (!picked) return;

    const result = await load({ file: picked.file });
    if (!result.ok) {
        vscode.window.showWarningMessage(`porthole: ${result.error}`);
        return;
    }
    const r = result.result.resolution;
    vscode.window.showInformationMessage(
        `porthole: ${r.resolved} finding(s) still apply` +
            (r.shifted ? `, ${r.shifted} moved` : "") +
            (r.changed ? `, ${r.changed} may be stale` : "") +
            (r.missing ? `, ${r.missing} file(s) gone` : "") +
            ".",
    );
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.saveReview", saveCommand),
        vscode.commands.registerCommand("porthole.loadReview", loadCommand),
    );
}

module.exports = { activate, save, list, load };
