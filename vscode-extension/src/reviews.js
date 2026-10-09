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
const atomic = require("./atomic");
const { findWorkspaceSession, sessionRoot } = require("./session");
const { projectFolder, gitHead, isInside, storedPath, absoluteFile, normaliseSlug } = require("./repo");

const SCHEMA = 1;
const SLUG_PATTERN = /^[\w-]{1,64}$/;

// --- saving -----------------------------------------------------------------

function save(payload = {}) {
    const session = findWorkspaceSession();
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
    const preferred = normaliseSlug(payload.slug || title);
    if (!SLUG_PATTERN.test(preferred)) {
        return { ok: false, error: `'${preferred}' is not a usable name` };
    }

    // A save must never quietly destroy an earlier one. `defaultTitle()` falls
    // back to the literal "review", so two untitled saves in the same session
    // both wanted `review.json` - and the second overwrote hand-written
    // findings and narration with no warning at all. Import already derives a
    // free name on collision; saving now does the same, and reports the name it
    // actually used. Overwriting stays possible, but only when asked for.
    const slug = payload.replace === true ? preferred : availableSlug(session.id, preferred);
    const replaced = slug === preferred && payload.replace === true;

    const inherited = inheritedSource();
    const repo = inherited ? inherited.repo : projectFolder();
    const head = inherited || (repo ? gitHead(repo) : { branch: null, commit: null });
    const review = {
        schema: SCHEMA,
        slug,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: session.id,
        repo,
        branch: head.branch || null,
        commit: head.commit || null,
        findings: findings.map((f) => toFinding(f, repo)),
    };

    const dir = path.join(session.dir, "porthole", "reviews");
    const file = path.join(dir, `${slug}.json`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        atomic.writeJson(file, review);
    } catch (err) {
        return { ok: false, error: `could not write the review: ${err.message}` };
    }

    diag(`review saved: ${file} (${review.findings.length} findings)`);
    return {
        ok: true,
        result: {
            file,
            slug,
            findings: review.findings.length,
            replaced,
            renamedFrom: slug === preferred ? undefined : preferred,
        },
    };
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
            anchor: s.anchor || null,
            inheritedEvidence: true,
        }));
    }
    return annotations.getState().entries.map((entry) => {
        const authored = entry.authored || {};
        return {
            file: entry.file,
            startLine: entry.startLine,
            endLine: entry.endLine,
            severity: entry.inheritedEvidence ? authored.severity : entry.severity,
            message: entry.inheritedEvidence ? authored.message : entry.message,
            stepTitle: entry.inheritedEvidence ? authored.stepTitle : undefined,
            narration: entry.inheritedEvidence ? authored.narration : undefined,
            anchor: entry.inheritedEvidence ? authored.anchor : null,
            inheritedEvidence: entry.inheritedEvidence === true,
        };
    });
}

function inheritedSource() {
    const activeTour = tour.getState();
    if (activeTour.steps.length > 0 && activeTour.tourId) {
        const entry = tour.getTour(activeTour.tourId);
        if (entry) {
            return {
                repo: entry.publication?.repo || entry.repo || null,
                branch: entry.branch || null,
                commit: entry.publication?.commit || entry.commit || null,
            };
        }
    }
    return annotations.getState().source || null;
}

function defaultTitle() {
    return tour.getState().title || annotations.getState().title || "review";
}

function toFinding(f, repo) {
    const out = {
        file: storedPath(f.file, repo),
        startLine: f.startLine,
        endLine: f.endLine,
        severity: f.severity || "info",
        message: f.message || "",
    };
    if (f.stepTitle) out.stepTitle = f.stepTitle;
    if (f.narration) out.narration = f.narration;

    if (f.anchor?.sha256) {
        out.anchor = f.anchor;
    } else if (!f.inheritedEvidence) {
        const anchor = anchors.anchorFor(f.file, f.startLine, f.endLine);
        if (anchor) out.anchor = anchor;
    }
    return out;
}

// --- listing ----------------------------------------------------------------

/**
 * Every review on this machine, newest first.
 *
 * Scans sibling session folders rather than just this one: a review is only
 * useful if a later session can find it.
 */
function scan({ sessionId = null, repo = null } = {}) {
    const wantRepo = repo ? String(repo).toLowerCase() : null;
    const root = sessionRoot();

    let sessions = [];
    try {
        sessions = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }

    const reviews = [];
    for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        if (sessionId && entry.name !== sessionId) continue;
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
            if (sessionId && review.sessionId !== sessionId) continue;
            if (wantRepo && String(review.repo || "").toLowerCase() !== wantRepo) continue;
            reviews.push({ ...review, file });
        }
    }

    reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return reviews;
}

function list(payload = {}) {
    const session = findWorkspaceSession();
    const limit = Math.min(200, Math.max(1, Number.parseInt(payload.limit, 10) || 50));
    const reviews = session
        ? scan({ sessionId: session.id, repo: payload.repo })
        : [];
    return {
        ok: true,
        result: {
            reviews: reviews.slice(0, limit).map((review) => ({
                slug: review.slug,
                title: review.title,
                file: review.file,
                createdAt: review.createdAt,
                updatedAt: review.updatedAt,
                sessionId: review.sessionId,
                repo: review.repo,
                branch: review.branch,
                findings: (review.findings || []).length,
            })),
        },
    };
}

function discover(payload = {}) {
    const current = findWorkspaceSession();
    if (!current) return { ok: false, error: "no Copilot session is bound to this window" };
    const limit = Math.min(200, Math.max(1, Number.parseInt(payload.limit, 10) || 50));
    const reviews = scan({ repo: payload.repo })
        .filter((review) => review.sessionId !== current?.id)
        .filter(
            (review) =>
                !payload.sourceSessionId ||
                review.sessionId === String(payload.sourceSessionId),
        )
        .slice(0, limit)
        .map((review) => ({
            slug: review.slug,
            title: review.title,
            sourceSessionId: review.sessionId,
            repo: review.repo,
            branch: review.branch,
            createdAt: review.createdAt,
            updatedAt: review.updatedAt,
            findings: (review.findings || []).length,
        }));
    return { ok: true, result: { reviews } };
}

function availableSlug(sessionId, preferred) {
    const used = new Set(scan({ sessionId }).map((review) => review.slug));
    if (!used.has(preferred)) return preferred;
    for (let number = 2; number < 1000; number += 1) {
        const suffix = `-${number}`;
        const candidate = `${preferred.slice(0, 64 - suffix.length)}${suffix}`;
        if (!used.has(candidate)) return candidate;
    }
    return `${preferred.slice(0, 50)}-${Date.now()}`.slice(0, 64);
}

async function importReview(payload = {}) {
    const session = findWorkspaceSession();
    if (!session) return { ok: false, error: "no Copilot session is bound to this window" };
    const sourceSessionId = String(payload.sourceSessionId || "").trim();
    const sourceSlug = String(payload.sourceSlug || "").trim();
    if (!sourceSessionId || !SLUG_PATTERN.test(sourceSlug)) {
        return { ok: false, error: "sourceSessionId and sourceSlug are required" };
    }

    if (sourceSessionId === session.id) {
        return { ok: false, error: "that Saved Review already belongs to this Copilot session" };
    }
    const source = scan({ sessionId: sourceSessionId }).find(
        (review) => review.slug === sourceSlug,
    );
    if (!source) return { ok: false, error: "the source Saved Review was not found" };

    const preferred = normaliseSlug(payload.targetSlug || sourceSlug);
    if (!SLUG_PATTERN.test(preferred)) return { ok: false, error: "targetSlug is invalid" };
    const existing = scan({ sessionId: session.id }).find(
        (review) => review.slug === preferred,
    );
    let slug = preferred;
    let replacing = false;
    if (existing && payload.replace === true) {
        const answer = await vscode.window.showWarningMessage(
            `Replace the Saved Review "${preferred}" in this Copilot session?`,
            { modal: true, detail: "The historical source review will not be changed." },
            "Replace",
        );
        if (answer !== "Replace") {
            return {
                ok: true,
                imported: false,
                cancelled: true,
                suggestedSlug: availableSlug(session.id, preferred),
            };
        }
        replacing = true;
    } else {
        slug = availableSlug(session.id, preferred);
    }

    const now = new Date().toISOString();
    const record = {
        ...source,
        file: undefined,
        slug,
        sessionId: session.id,
        createdAt: now,
        updatedAt: now,
        provenance: {
            sourceSessionId,
            sourceSlug,
            importedAt: payload.importedAt || now,
        },
        findings: (source.findings || []).map((finding) => ({ ...finding })),
    };
    const dir = path.join(session.dir, "porthole", "reviews");
    fs.mkdirSync(dir, { recursive: true });
    let file;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        file = path.join(dir, `${slug}.json`);
        record.slug = slug;
        try {
            if (replacing) {
                atomic.writeJson(file, record);
            } else {
                fs.writeFileSync(file, JSON.stringify(record, null, 2), {
                    encoding: "utf8",
                    flag: "wx",
                });
            }
            break;
        } catch (err) {
            if (!replacing && err.code === "EEXIST") {
                slug = availableSlug(session.id, preferred);
                continue;
            }
            return { ok: false, error: `could not import the Saved Review: ${err.message}` };
        }
    }
    if (!file || !fs.existsSync(file)) {
        return { ok: false, error: "could not find a free Saved Review slug" };
    }
    return { ok: true, result: { slug, file, provenance: record.provenance } };
}

async function deleteReview(payload = {}) {
    const session = findWorkspaceSession();
    const slug = String(payload.slug || "").trim();
    if (!session) return { ok: false, error: "no Copilot session is bound to this window" };
    if (!SLUG_PATTERN.test(slug)) return { ok: false, error: "a review slug is required" };
    const review = scan({ sessionId: session.id }).find((entry) => entry.slug === slug);
    if (!review) return { ok: false, error: `no Saved Review called '${slug}' was found` };

    const answer = await vscode.window.showWarningMessage(
        `Delete the Saved Review "${review.title || slug}"?`,
        { modal: true, detail: "Only this Copilot session's exact review file will be deleted." },
        "Delete review",
    );
    if (answer !== "Delete review") return { ok: true, deleted: false, cancelled: true };
    try {
        fs.rmSync(review.file, { force: true });
    } catch (err) {
        return { ok: false, error: `could not delete the Saved Review: ${err.message}` };
    }
    return { ok: true, result: { slug, deleted: review.file } };
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
    const session = findWorkspaceSession();
    if (!session) return { ok: false, error: "no Copilot session is bound to this window" };
    const file = payload.file
        ? resolveReviewPath(payload.file, session.id)
        : findBySlug(payload.slug, session.id);
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
            authored: {
                severity: finding.severity || "info",
                message: finding.message || "",
                stepTitle: finding.stepTitle,
                narration: finding.narration,
                anchor: finding.anchor || null,
            },
        });
    }

    if (entries.length === 0) {
        return {
            ok: false,
            error: "none of this review's files still exist",
            result: { review: { ...review, findings: resolved }, resolution },
        };
    }

    await annotations.restore({
        title: `${review.title} (${review.createdAt.slice(0, 10)})`,
        clearExisting: true,
        source: {
            repo: review.repo || null,
            branch: review.branch || null,
            commit: review.commit || null,
        },
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

function findBySlug(slug, sessionId) {
    if (!slug || !SLUG_PATTERN.test(String(slug))) return null;
    const match = scan({ sessionId }).find((r) => r.slug === slug);
    return match ? match.file : null;
}

/**
 * Containment.
 *
 * `file` comes from outside, and without this check `review-load` is an
 * arbitrary JSON file reader.
 */
function resolveReviewPath(file, sessionId) {
    const resolved = path.resolve(String(file));
    const root = path.resolve(sessionRoot());
    if (!isInside(root, resolved)) return null;
    const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
    // <sessionId>/porthole/reviews/<name>.json
    if (parts.length !== 4) return null;
    if (parts[0] !== sessionId) return null;
    if (parts[1] !== "porthole" || parts[2] !== "reviews") return null;
    if (!parts[3].endsWith(".json")) return null;
    return resolved;
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

module.exports = {
    activate,
    save,
    list,
    discover,
    importReview,
    deleteReview,
    load,
    scan,
};
