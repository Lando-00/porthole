// Saved reviews, from the CLI side.
//
// Listing is a filesystem scan, so the CLI does it directly: routing a
// directory walk through a URI, a window choice and a timeout would add
// failure modes without adding capability.
//
// Loading prefers the companion, because only the editor can check each
// finding against the code as it is now AND put the results on screen. Without
// a companion the findings are still returned, just labelled as unverified.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { callCompanion, explain } from "./companion.mjs";
import { ensureCompanion } from "./ensure.mjs";
import { copilotHome } from "./config.mjs";
import { companionOptions, sessionPath } from "./target.mjs";

const SCHEMA = 1;
const SLUG_PATTERN = /^[\w-]{1,64}$/;

function sessionRoot() {
    return join(copilotHome(), "session-state");
}

function readReview(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed && parsed.schema === SCHEMA ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Every review on this machine, newest first.
 *
 * Scans sibling session folders, not just this session's, because the whole
 * point is that a later session can pick up an earlier one's findings.
 */
export function listReviews({ repo = null, limit = 50, currentSessionPath = null } = {}) {
    const root = sessionRoot();
    let sessions = [];
    try {
        const currentId = currentSessionPath ? basename(currentSessionPath) : null;
        sessions = readdirSync(root, { withFileTypes: true }).filter(
            (entry) => !currentId || entry.name === currentId,
        );
    } catch {
        return [];
    }

    const found = [];
    for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name, "porthole", "reviews");
        let files = [];
        try {
            files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        } catch {
            continue;
        }
        for (const name of files) {
            const file = join(dir, name);
            const review = readReview(file);
            if (!review) continue;
            if (repo && String(review.repo || "").toLowerCase() !== repo.toLowerCase()) continue;
            found.push({ ...review, file });
        }
    }

    found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return found.slice(0, Math.max(1, limit));
}

function describeList(reviews) {
    if (reviews.length === 0) return "No saved reviews.";
    const lines = [`${reviews.length} saved review(s), newest first:`, ""];
    for (const r of reviews) {
        lines.push(
            `  ${r.slug}  -  ${r.title}` +
                `\n      ${r.findings.length} finding(s) · ${String(r.createdAt).slice(0, 16).replace("T", " ")}` +
                `${r.branch ? ` · ${r.branch}` : ""}${r.repo ? `\n      ${r.repo}` : ""}`,
        );
    }
    return lines.join("\n");
}

function describeFindings(review, resolution) {
    const lines = [`# ${review.title}`, ""];
    lines.push(
        `Saved ${String(review.createdAt).slice(0, 16).replace("T", " ")}` +
            `${review.branch ? ` on ${review.branch}` : ""}` +
            `${review.commit ? ` at ${review.commit}` : ""}.`,
    );

    if (resolution) {
        const parts = [];
        if (resolution.resolved) parts.push(`${resolution.resolved} still apply`);
        if (resolution.shifted) parts.push(`${resolution.shifted} moved but were found again`);
        if (resolution.changed) parts.push(`${resolution.changed} sit on code that has changed`);
        if (resolution.missing) parts.push(`${resolution.missing} point at files that are gone`);
        lines.push("", parts.length ? `Of these findings, ${parts.join(", ")}.` : "");
    } else {
        lines.push(
            "",
            "_No VS Code window was available, so these findings have not been checked " +
                "against the current code and may be out of date._",
        );
    }

    lines.push("");
    for (const [i, f] of (review.findings || []).entries()) {
        const where = f.startLine === f.endLine ? `${f.startLine}` : `${f.startLine}-${f.endLine}`;
        // The status belongs on the finding, not just in the summary: "one has
        // changed" is useless if you cannot tell which one.
        const mark = {
            shifted: "  _(moved since it was saved; line numbers below are the current ones)_",
            changed: "  _(the code here has changed - this may no longer apply)_",
            missing: "  _(this file no longer exists)_",
        }[f.status];
        lines.push(`${i + 1}. **${f.stepTitle || f.severity}** - ${f.file}:${where}${mark || ""}`);
        const body = f.narration || f.message;
        if (body) lines.push(`   ${String(body).split(/\r?\n/).join("\n   ")}`);
    }
    return lines.join("\n");
}

export async function review(args = {}, getSession = null) {
    const action = args.action || "list";
    const root = process.cwd();

    if (action === "list") {
        return describeList(
            listReviews({
                repo: args.repo,
                limit: args.limit,
                currentSessionPath: sessionPath(getSession),
            }),
        );
    }

    if (action === "save") {
        const result = await callCompanion(
            "review-save",
            { slug: args.slug, title: args.title },
            companionOptions(root, getSession),
        );
        if (!result.ok) return `porthole: ${explain(result)}`;
        return (
            `porthole: saved ${result.result.findings} finding(s) as '${result.result.slug}'.\n` +
            `Load it later with porthole_review { action: "load", slug: "${result.result.slug}" }.`
        );
    }

    if (action === "load") {
        if (args.slug && !SLUG_PATTERN.test(String(args.slug))) {
            return `porthole: '${args.slug}' is not a valid review name.`;
        }

        const { note: openNote } = await ensureCompanion(getSession, {
            openIfClosed: args.openIfClosed === true,
        });

        // The companion checks each finding against the code as it is now and
        // puts them on screen, so try it first.
        const result = await callCompanion(
            "review-load",
            { slug: args.slug, file: args.file },
            companionOptions(root, getSession),
        );
        if (result.ok) {
            return describeFindings(result.result.review, result.result.resolution);
        }

        // No window, or it refused: the findings are still useful, they just
        // come with a warning attached.
        if (result.reason === "absent") {
            const match = listReviews({
                limit: 200,
                currentSessionPath: sessionPath(getSession),
            }).find((r) => r.slug === args.slug);
            if (match) return describeFindings(match, null) + openNote;
        }
        return `porthole: ${explain(result)}${openNote}`;
    }

    if (action === "delete") {
        const result = await callCompanion(
            "review-delete",
            { slug: args.slug },
            companionOptions(root, getSession),
        );
        if (!result.ok) return `porthole: ${explain(result)}`;
        if (result.cancelled || result.deleted === false) {
            return "porthole: Saved Review deletion cancelled.";
        }
        return `porthole: deleted '${args.slug}' from this Copilot session only.`;
    }

    return `porthole: unknown action '${action}' - use list, save, load or delete.`;
}

async function discoverReviews(args = {}, getSession = null) {
    const result = await callCompanion(
        "review-discover",
        { repo: args.repo, sourceSessionId: args.sourceSessionId, limit: args.limit },
        companionOptions(process.cwd(), getSession),
    );
    if (!result.ok) return `porthole: ${explain(result)}`;
    const reviews = result.result?.reviews || [];
    if (!reviews.length) return "porthole: Saved Review Discovery found no matches.";
    return reviews.map((review) =>
        `${review.sourceSessionId}/${review.slug} - ${review.title} ` +
        `(${review.findings} findings, ${review.branch || "no branch"}, ` +
        `created ${review.createdAt || "unknown"}, updated ${review.updatedAt || "unknown"})`,
    ).join("\n");
}

async function importSavedReview(args = {}, getSession = null) {
    const result = await callCompanion(
        "review-import",
        {
            sourceSessionId: args.sourceSessionId,
            sourceSlug: args.sourceSlug,
            targetSlug: args.targetSlug,
            replace: args.replace === true,
        },
        companionOptions(process.cwd(), getSession),
    );
    if (!result.ok) return `porthole: ${explain(result)}`;
    if (result.cancelled || result.imported === false) {
        return `porthole: Saved Review import cancelled.${result.suggestedSlug ? ` Suggested slug: ${result.suggestedSlug}.` : ""}`;
    }
    return `porthole: imported '${args.sourceSlug}' as '${result.result.slug}' into this Copilot session.`;
}

export function tools(getSession = null) {
    return [
        {
            name: "porthole_review",
            description:
                "Save the findings currently marked in the user's VS Code window as a named " +
                "review, list this session's reviews, load one back, or delete one. Use 'save' after " +
                "walking through problems you found, so the work is not lost when the session " +
                "ends. Other sessions are available only through porthole_review_discover and " +
                "porthole_review_import. Loading " +
                "reports which findings still apply, because code moves and changes; discuss " +
                "them with the user and create todos for the ones worth acting on. Requires " +
                "the porthole companion VS Code extension to save.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list", "save", "load", "delete"],
                        description: "What to do. Defaults to 'list'.",
                    },
                    slug: {
                        type: "string",
                        description:
                            "Short name for the review, e.g. 'launch-path-audit'. Required to load.",
                    },
                    title: {
                        type: "string",
                        description: "Human-readable title, used when saving.",
                    },
                    repo: {
                        type: "string",
                        description: "Filter the list to one repository path.",
                    },
                    limit: { type: "integer", description: "Maximum reviews to list." },
                    openIfClosed: {
                        type: "boolean",
                        description:
                            "When loading, open an editor window if none is running. Default " +
                            "false. Only set this when the user has explicitly asked to be " +
                            "shown the review - it takes over their screen.",
                    },
                },
            },
            handler: async (args) => review(args, getSession),
        },
        {
            name: "porthole_review_discover",
            description:
                "Search Saved Reviews owned by other Copilot sessions without loading them. " +
                "Results are read-only and include source session, repository, branch, dates " +
                "and finding count.",
            parameters: {
                type: "object",
                properties: {
                    repo: { type: "string" },
                    sourceSessionId: { type: "string" },
                    limit: { type: "integer" },
                },
            },
            handler: async (args) => discoverReviews(args, getSession),
        },
        {
            name: "porthole_review_import",
            description:
                "Import a discovered Saved Review as an independent current-session copy with " +
                "provenance. Collisions derive a safe slug unless replacement is explicitly " +
                "requested and confirmed in VS Code.",
            parameters: {
                type: "object",
                properties: {
                    sourceSessionId: { type: "string" },
                    sourceSlug: { type: "string" },
                    targetSlug: { type: "string" },
                    replace: { type: "boolean" },
                },
                required: ["sourceSessionId", "sourceSlug"],
            },
            handler: async (args) => importSavedReview(args, getSession),
        },
    ];
}
