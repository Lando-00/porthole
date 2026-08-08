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
import { join } from "node:path";

import { callCompanion, explain } from "./companion.mjs";
import { ensureCompanion } from "./ensure.mjs";
import { copilotHome } from "./config.mjs";

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
export function listReviews({ repo = null, limit = 50 } = {}) {
    const root = sessionRoot();
    let sessions = [];
    try {
        sessions = readdirSync(root, { withFileTypes: true });
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
        return describeList(listReviews({ repo: args.repo, limit: args.limit }));
    }

    if (action === "save") {
        const result = await callCompanion(
            "review-save",
            { slug: args.slug, title: args.title },
            { contextPath: root },
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
            { contextPath: root },
        );
        if (result.ok) {
            return describeFindings(result.result.review, result.result.resolution);
        }

        // No window, or it refused: the findings are still useful, they just
        // come with a warning attached.
        if (result.reason === "absent") {
            const match = listReviews({ limit: 200 }).find((r) => r.slug === args.slug);
            if (match) return describeFindings(match, null) + openNote;
        }
        return `porthole: ${explain(result)}${openNote}`;
    }

    return `porthole: unknown action '${action}' - use list, save or load.`;
}

export function tools(getSession = null) {
    return [
        {
            name: "porthole_review",
            description:
                "Save the findings currently marked in the user's VS Code window as a named " +
                "review, list previously saved reviews, or load one back. Use 'save' after " +
                "walking through problems you found, so the work is not lost when the session " +
                "ends. Use 'list' and 'load' at the start of a session when the user refers to " +
                "an earlier review - reviews from OTHER sessions are visible too. Loading " +
                "reports which findings still apply, because code moves and changes; discuss " +
                "them with the user and create todos for the ones worth acting on. Requires " +
                "the porthole companion VS Code extension to save.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list", "save", "load"],
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
    ];
}
