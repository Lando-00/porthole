// Walkthroughs, driven from the CLI.
//
// The model already explains code well in prose. What it cannot do in prose is
// put the explanation next to the code and let someone walk through it at their
// own pace. That is what this is for.
//
// A library, not a single tour: a change worth explaining rarely has one
// thread, and one fifty-step walk through a pull request is a list, not an
// explanation. Many tours can be loaded; one is being walked.
//
// The tool surface is split by the *shape of its parameters*, not by verb
// count. One tool with an `action` enum whose other parameters are conditional
// on it produces malformed calls; six near-identical tools waste context and
// make the model choose. Creating takes a deep nested array, listing takes
// almost nothing, and activate/close/delete/goto all take just an id - so
// three tools, and the last four verbs share one.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { EvidenceError, resolveComparison } from "./changes.mjs";
import { callCompanion, explain } from "./companion.mjs";
import { ensureCompanion } from "./ensure.mjs";
import { companionOptions } from "./target.mjs";
import { isGitRepo, projectRoot } from "./git.mjs";
import { withDeliveryNotes } from "./delivery-notes.mjs";

const MAX_STEPS = 50;

/**
 * Resolves a step's file against the working directory.
 *
 * Done here as well as in the companion so a bad path is reported to the model
 * as part of the tool result, where it can fix it, rather than only appearing
 * in the editor.
 */
function resolveStep(step, root) {
    const file = String(step.file || "");
    if (!file) return null;
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    return existsSync(absolute) ? absolute : null;
}

// --- creating ---------------------------------------------------------------

export async function tour(args = {}, getSession = null, deps = {}) {
    const root = process.cwd();
    const incoming = Array.isArray(args.steps) ? args.steps : [];
    if (incoming.length === 0) return "porthole: a tour needs at least one step.";
    if (incoming.length > MAX_STEPS) {
        return (
            `porthole: a tour is limited to ${MAX_STEPS} steps. ` +
            "Split it into several tours - that is what the library is for."
        );
    }

    const steps = [];
    const unresolved = [];
    for (const [i, step] of incoming.entries()) {
        const file = resolveStep(step, root);
        if (!file) {
            unresolved.push(`step ${i + 1}: ${step.file || "(no file)"}`);
            continue;
        }
        steps.push({ ...step, file });
    }

    if (steps.length === 0) {
        return `porthole: none of those files exist - ${unresolved.join(", ")}`;
    }

    const sourceRepo = isGitRepo(root) ? projectRoot(root) : null;

    let recorded;
    let comparisonNote = "";
    if (args.comparison !== undefined && args.comparison !== null) {
        let resolved;
        try {
            resolved = await (deps.resolveComparison || resolveComparison)(args.comparison, {
                cwd: root,
                files: steps.map((step) => step.file),
            });
        } catch (error) {
            if (!(error instanceof EvidenceError)) throw error;
            return `porthole: invalid comparison - ${error.message}. Nothing was published; copy the comparison porthole_changes printed.`;
        }
        if (resolved.unavailable) {
            comparisonNote = `\nNo Recorded comparison: ${resolved.unavailable}. Step diffs are unavailable for this Tour.`;
        } else if (!sourceRepo || !sameDirectory(resolved.root, sourceRepo)) {
            comparisonNote = "\nNo Recorded comparison: the comparison's repository is not this Tour's repository.";
        } else {
            const { kind, label, base, target, renames, renamesComplete, notes } = resolved;
            recorded = { comparison: { kind, label, base, target, renames, renamesComplete }, notes };
        }
    }

    const { note: openNote } = await ensureCompanion(getSession, {
        openIfClosed: args.openIfClosed === true,
        windowId: args.windowId,
    });

    const result = await callCompanion(
        "tour",
        {
            tourId: args.tourId,
            title: args.title,
            steps,
            activate: args.activate !== false,
            replace: args.replace,
            sourceRepo,
            ...(recorded ? { comparison: recorded.comparison } : {}),
        },
        companionOptions(root, getSession, { windowId: args.windowId }),
    );

    if (!result.ok) {
        if (result.result?.saved) {
            const savedId = result.result.tourId || args.tourId || "the Tour";
            return withDeliveryNotes(
                result,
                `porthole: saved '${savedId}' in the Tour Library, but did not display it - ` +
                    `${result.error || explain(result)}${openNote}`,
            );
        }
        return withDeliveryNotes(result, `porthole: ${explain(result)}${openNote}`);
    }

    const skipped = [
        ...unresolved,
        ...(result.result?.skipped || []).map((s) => `step ${s.index + 1}: ${s.reason}`),
    ];

    const { tourId, replaced, active, library } = result.result || {};
    const count = result.result?.steps ?? steps.length;

    let message =
        `porthole: ${replaced ? "replaced" : "created"} a ${count}-step walkthrough` +
        (args.title ? ` - "${args.title}"` : "") +
        ` (id: ${tourId}).`;

    if (active) {
        message +=
            " It is now the active tour. The user can step through it with the Next/Prev " +
            "controls above the code, Alt+] and Alt+[, or the porthole sidebar.";
    } else {
        message +=
            " It is in the library but not active - its steps appear in the Problems panel, " +
            "and the user can start it from the porthole sidebar.";
    }

    if (library > 1) message += ` ${library} tours are now loaded.`;
    if (skipped.length) message += `\nSkipped: ${skipped.join("; ")}`;
    if (recorded) {
        if (result.result?.comparisonRecorded) {
            message += `\nRecorded comparison: ${describeComparison(recorded.comparison)}. The user can open a Step diff from the Diff control above each step.`;
            for (const note of recorded.notes) message += `\n${note}`;
        } else {
            message += "\nThe running companion did not record the comparison; update the Porthole companion to enable Step diffs.";
        }
    }
    message += comparisonNote;

    return withDeliveryNotes(result, message);
}

function shortOid(oid) {
    return oid ? String(oid).slice(0, 7) : "empty tree";
}

/** One line naming a Recorded comparison, for the model and the user. */
export function describeComparison(comparison) {
    if (!comparison) return "none";
    const to = comparison.kind === "live" ? "saved files" : shortOid(comparison.target);
    return `${comparison.label} (${shortOid(comparison.base)} -> ${to})`;
}

function sameDirectory(left, right) {
    const canonical = (dir) => {
        try { return realpathSync.native(dir); } catch { return resolve(dir); }
    };
    const a = canonical(left);
    const b = canonical(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// --- listing ----------------------------------------------------------------

export async function tours(args = {}, sessionSource = null) {
    const result = await callCompanion(
        "tour-list",
        {
            includeSteps: args.includeSteps === true,
            includeArchived: args.includeArchived === true,
            repo: args.repo,
            limit: args.limit,
        },
        companionOptions(process.cwd(), sessionSource, { windowId: args.windowId }),
    );
    if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);

    const list = result.result?.tours || [];
    if (list.length === 0) {
        return withDeliveryNotes(
            result,
            "porthole: this Copilot session's Tour Library is empty.",
        );
    }

    const lines = [`porthole: ${list.length} tour(s).`];
    for (const t of list) {
        const bits = [`${t.steps} steps`];
        if (t.archivedAt) bits.push("ARCHIVED");
        if (t.active) bits.push("ACTIVE");
        else if (t.loaded) bits.push("loaded");
        else bits.push("saved, not loaded");
        if (t.branch) bits.push(t.branch);

        const stale = describeStaleness(t.staleness);
        if (stale) bits.push(stale);
        if (t.revisionState === "revision-changed") bits.push("REVISION CHANGED");
        else if (t.revisionState === "unknown") bits.push("revision unknown");
        else if (t.revisionState === "same-revision") bits.push("same revision");
        if (t.savedPublicationChanged) bits.push("saved copy differs");
        if (t.comparison) bits.push(`comparison ${describeComparison(t.comparison)}`);

        lines.push(`  ${t.tourId} - "${t.title}" (${bits.join(", ")})`);

        for (const s of t.stepDetail || []) {
            lines.push(
                `      ${s.startLine}-${s.endLine} ${s.file} - ${s.stepTitle}` +
                    (s.status && s.status !== "resolved" ? ` [${s.status}]` : ""),
            );
        }
    }

    if (list.some((t) => t.staleness && (t.staleness.changed || t.staleness.missing))) {
        lines.push(
            "\nA tour with changed or missing steps was written against older code. " +
                "Say so before walking the user through it, and offer to rebuild it.",
        );
    }
    if (list.some((t) => t.revisionState === "revision-changed")) {
        lines.push(
            "\nRepository revision changed since this Tour was published; " +
                "the explanation may need updating.",
        );
    }
    if (list.some((t) => t.savedPublicationChanged)) {
        lines.push("\nA saved publication differs from this window's loaded copy. Explicitly activate that Tour to load the saved publication.");
    }

    return withDeliveryNotes(result, lines.join("\n"));
}

export async function discoverTours(args = {}, sessionSource = null) {
    const result = await callCompanion(
        "tour-discover",
        {
            query: args.query,
            repo: args.repo,
            sourceSessionId: args.sourceSessionId,
            limit: args.limit,
            includeLegacyCurrent: true,
        },
        companionOptions(process.cwd(), sessionSource),
    );
    if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);

    const list = result.result?.tours || [];
    if (list.length === 0) {
        return withDeliveryNotes(
            result,
            "porthole: Saved Tour Discovery found no matching Tours.",
        );
    }

    const lines = [`porthole: Saved Tour Discovery found ${list.length} Tour(s).`];
    for (const entry of list) {
        const stale = describeStaleness(entry.staleness);
        const legacy =
            entry.legacyStatus === "legacy-copy"
                ? "LEGACY COPY"
                : entry.legacyStatus === "uncertain"
                  ? "UNCERTAIN"
                  : null;
        lines.push(
            `  ${entry.sourceSessionId}/${entry.tourId} - "${entry.title}" ` +
                `(${entry.steps} steps${entry.branch ? `, ${entry.branch}` : ""}` +
                `${stale ? `, ${stale}` : ""}${legacy ? `, ${legacy}` : ""})`,
            `      ${entry.repo || "(no repository)"} · created ${entry.createdAt || "unknown"}` +
                ` · updated ${entry.updatedAt || "unknown"}`,
        );
        if (entry.legacyEvidence) {
            lines.push(
                `      ${entry.legacyEvidence.reason}: ` +
                    `${entry.legacyEvidence.recordCreatedAt || "unknown"} vs session ` +
                    `${entry.legacyEvidence.claimedSessionCreatedAt || "unknown"}`,
            );
        }
    }
    return withDeliveryNotes(result, lines.join("\n"));
}

export async function importSavedTour(args = {}, sessionSource = null) {
    const result = await callCompanion(
        "tour-import",
        {
            sourceSessionId: args.sourceSessionId,
            sourceTourId: args.sourceTourId,
            targetTourId: args.targetTourId,
            replace: args.replace === true,
        },
        companionOptions(process.cwd(), sessionSource),
    );
    if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
    if (result.cancelled || result.imported === false) {
        return withDeliveryNotes(
            result,
            "porthole: import cancelled; the source Tour and current Tour Library are unchanged." +
                (result.suggestedTourId ? ` Suggested id: ${result.suggestedTourId}.` : ""),
        );
    }

    const imported = result.result || result;
    return withDeliveryNotes(
        result,
        `porthole: imported '${args.sourceTourId}' as '${imported.tourId}' into this ` +
            "Copilot session's Tour Library. The historical source remains unchanged.",
    );
}

export async function cleanupLegacyTour(args = {}, sessionSource = null) {
    const result = await callCompanion(
        "tour-legacy-cleanup",
        {
            sourceSessionId: args.sourceSessionId,
            sourceTourId: args.sourceTourId,
        },
        companionOptions(process.cwd(), sessionSource),
    );
    if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
    if (result.cancelled || result.deleted === false) {
        return withDeliveryNotes(
            result,
            "porthole: legacy cleanup cancelled; no stored Tour was changed.",
        );
    }
    const cleaned = result.result || result;
    return withDeliveryNotes(
        result,
        `porthole: deleted the exact legacy copy '${cleaned.sourceTourId}' from ` +
            `session '${cleaned.sourceSessionId}'. Other same-ID Tours were untouched.`,
    );
}

function describeStaleness(s) {
    if (!s) return "";
    const parts = [];
    if (s.shifted) parts.push(`${s.shifted} moved`);
    if (s.changed) parts.push(`${s.changed} changed`);
    if (s.missing) parts.push(`${s.missing} gone`);
    return parts.length ? `saved ranges: ${parts.join(", ")}` : "saved ranges match";
}

// --- activate / close / delete / goto ---------------------------------------

export async function manage(args = {}, sessionSource = null) {
    const action = String(args.action || "activate");
    const tourId = String(args.tourId || "").trim();
    const presentationAction =
        action === "activate" || action === "goto" || action === "close" || action === "diff";

    if (args.windowId && !presentationAction) {
        return (
            `porthole: windowId is only valid for activate, goto, close, or diff. ` +
            `'${action}' changes the session-owned Tour artifact on the primary window.`
        );
    }

    if (action !== "close" && !tourId) {
        return "porthole: which tour? Call porthole_tours to see the ids.";
    }

    if (action === "diff") {
        const result = await callCompanion(
            "tour-diff",
            {
                tourId,
                step: Number.isInteger(args.step) ? args.step : undefined,
                side: args.side === "target" ? "target" : "saved",
            },
            companionOptions(process.cwd(), sessionSource, { windowId: args.windowId }),
        );
        if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
        const r = result.result || {};
        let message =
            `porthole: opened the Step diff for step ${(r.step ?? 0) + 1} of '${tourId}' ` +
            `(${r.title || "comparison"}). The Tour did not move.`;
        if (r.savedDiffersFromTarget) {
            message += " The saved file differs from the recorded target revision; side 'target' shows the recorded revisions.";
        }
        if (r.noChangesInRange) message += " The comparison changed nothing inside this step's range.";
        for (const note of r.notes || []) message += `\n${note}`;
        return withDeliveryNotes(result, message);
    }

    if (action === "activate" || action === "goto") {
        const result = await callCompanion(
            "tour-activate",
            { tourId, step: Number.isInteger(args.step) ? args.step : undefined },
            companionOptions(process.cwd(), sessionSource, { windowId: args.windowId }),
        );
        if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);

        const { title, steps, current, staleness, revisionState } = result.result || {};
        let message = `porthole: now walking "${title}" (${steps} steps), at step ${(current ?? 0) + 1}.`;
        const stale = describeStaleness(staleness);
        if (staleness && (staleness.changed || staleness.missing)) {
            message +=
                `\nThis tour came off disk and ${stale}. Tell the user before walking them ` +
                "through it - the narration was written about code that has since moved on.";
        } else if (staleness?.shifted) {
            message +=
                `\nThis Tour's saved code moved; its anchored range was relocated before display.`;
        }
        if (revisionState === "revision-changed") {
            message +=
                "\nRepository revision changed since this Tour was published; " +
                "the explanation may need updating.";
        } else if (revisionState === "unknown") {
            message += "\nThe Tour's publication revision could not be compared.";
        }
        return withDeliveryNotes(result, message);
    }

    if (action === "close") {
        const result = await callCompanion(
            "tour-exit",
            tourId ? { tourId } : {},
            companionOptions(process.cwd(), sessionSource, { windowId: args.windowId }),
        );
        if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
        return withDeliveryNotes(
            result,
            `porthole: stopped walking ${tourId ? `'${tourId}'` : "the active tour"}. ` +
                "It is still in the library and still saved - use delete to remove it.",
        );
    }

    if (action === "delete") {
        const result = await callCompanion(
            "tour-delete",
            { tourId },
            companionOptions(process.cwd(), sessionSource),
        );
        if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
        return withDeliveryNotes(
            result,
            `porthole: deleted '${tourId}' from the library and from disk.`,
        );
    }

    if (action === "archive" || action === "unarchive") {
        const result = await callCompanion(
            "tour-archive",
            { tourId, archived: action === "archive" },
            companionOptions(process.cwd(), sessionSource),
        );
        if (!result.ok) return withDeliveryNotes(result, `porthole: ${explain(result)}`);
        return withDeliveryNotes(
            result,
            action === "archive"
                ? `porthole: archived '${tourId}'. It is hidden from the default Tour Library but remains saved.`
                : `porthole: unarchived '${tourId}'. It is back in this session's Tour Library.`,
        );
    }

    return `porthole: '${action}' is not one of activate, goto, close, archive, unarchive, delete, diff.`;
}

/** The pre-library name, kept so /tour-exit keeps working. */
export async function exitTour(sessionSource = null) {
    const result = await callCompanion(
        "tour-exit",
        {},
        companionOptions(process.cwd(), sessionSource),
    );
    return withDeliveryNotes(
        result,
        result.ok
            ? "porthole: stopped walking the active tour. It stays in the library."
            : `porthole: ${explain(result)}`,
    );
}

// --- the model-facing surface ------------------------------------------------

const STEP_SCHEMA = {
    type: "object",
    properties: {
        file: {
            type: "string",
            description: "Absolute path, or relative to the working directory.",
        },
        startLine: { type: "integer", description: "First line of this step, 1-based." },
        endLine: { type: "integer", description: "Last line; defaults to startLine." },
        stepTitle: {
            type: "string",
            description: "A few words naming this step, shown in the CodeLens and the sidebar.",
        },
        narration: {
            type: "string",
            description: "What you want to say about this step. Shown on hover and in the lens.",
        },
        severity: {
            type: "string",
            enum: ["info", "warn", "error", "note"],
            description: "Styling only: info, warn, error or note.",
        },
    },
    required: ["file", "startLine", "stepTitle"],
};

export function tools(getSession = null) {
    return [
        {
            name: "porthole_tour",
            description:
                "Walk the user through code as an ordered, narrated tour in their VS Code " +
                "window. Each step highlights a range and shows your narration in a CodeLens " +
                "directly above it, with Next/Prev controls, so they follow the path at their " +
                "own pace. Use this when explaining how something works across several places: " +
                "a request's path through a system, why a bug happens, what a refactor will " +
                "touch, or how to find your way around an unfamiliar module.\n\n" +
                "Many tours can be loaded at once, and one is active. For a pull request or " +
                "any change with several independent threads, create ONE TOUR PER THREAD - the " +
                "auth path, the error handling, the migration - rather than one long tour. " +
                "Call porthole_tours first so you extend the library instead of duplicating it.\n\n" +
                "A step is a place worth stopping, not every mention of the subject. Order the " +
                "steps the way you would narrate them aloud. Keep each narration short - it is " +
                "read in a two-line lens, so say what is needed to understand this step and " +
                "stop. Requires the porthole companion VS Code extension.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description:
                            "What this walkthrough shows, e.g. 'how a request reaches the editor'. " +
                            "Used as the tour's name everywhere the user sees it.",
                    },
                    tourId: {
                        type: "string",
                        description:
                            "A short slug identifying this tour, e.g. 'auth-path'. Derived from " +
                            "the title when omitted. Reuse an id to replace that tour.",
                    },
                    steps: {
                        type: "array",
                        description: "The steps, in the order the user should follow them.",
                        items: STEP_SCHEMA,
                    },
                    activate: {
                        type: "boolean",
                        description:
                            "Start walking it immediately. Default true. Pass false when adding " +
                            "several tours at once, so you do not drag the user between files - " +
                            "then activate the one you want to talk about first.",
                    },
                    replace: {
                        type: "boolean",
                        description:
                            "Allow overwriting a tour that already has this id. Default true. " +
                            "Pass false to be told about a clash instead.",
                    },
                    openIfClosed: {
                        type: "boolean",
                        description:
                            "Open an editor window if none is running. Default false. Only set " +
                            "this when the user has explicitly asked to be walked through " +
                            "something, e.g. the /walkthrough command - it takes over their " +
                            "screen, so never set it on a tour you decided to build yourself.",
                    },
                    windowId: {
                        type: "string",
                        description:
                            "Optional owned Porthole window to present this Tour in. The target " +
                            "must be supplied again on follow-up calls; omitting it uses the primary.",
                    },
                    comparison: {
                        type: "object",
                        description:
                            "The change this Tour explains, so the user can open a Step diff of " +
                            "old vs new code. Copy the value porthole_changes printed after " +
                            "'pass comparison:'. Omit for Tours that explain code rather than a change.",
                        properties: {
                            since: {
                                type: "string",
                                description: "a..b, a...b, <commit>^!, a branch, uncommitted, or staged.",
                            },
                            pr: { type: "integer", description: "GitHub PR number whose commits exist locally." },
                            label: { type: "string", description: "Short human name, e.g. 'main...HEAD'." },
                        },
                    },
                },
                required: ["steps"],
            },
            handler: async (args) => tour(args, getSession),
        },

        {
            name: "porthole_tours",
            description:
                "List this Copilot session's Tour Library in its Porthole window: which Tours " +
                "are loaded, which one is active, and which session-owned Tours are saved but " +
                "not yet loaded. Tours from other sessions are never included.\n\n" +
                "Call this before creating a tour, so you add to the library instead of " +
                "duplicating one already owned by this session.\n\n" +
                "It also reports how many steps have gone stale - moved, changed, or pointing " +
                "at a file that no longer exists - so you can tell whether a tour still " +
                "describes the current code before pointing the user at it. A tour with " +
                "changed steps was written against older code and its narration may now be " +
                "wrong; say so rather than walking them through it.",
            parameters: {
                type: "object",
                properties: {
                    includeSteps: {
                        type: "boolean",
                        description:
                            "Include each tour's steps and where they now point. Verbose; use " +
                            "when you need to reason about a specific tour's contents.",
                    },
                    includeArchived: {
                        type: "boolean",
                        description:
                            "Include archived Tours owned by this Copilot session. Default false.",
                    },
                    repo: {
                        type: "string",
                        description: "Only tours saved against this repository path.",
                    },
                    limit: { type: "integer", description: "Maximum tours to return. Default 50." },
                    windowId: {
                        type: "string",
                        description:
                            "Optional owned Porthole window whose loaded and active Tour state " +
                            "should be queried. Omitting it queries the primary.",
                    },
                },
            },
            handler: async (args) => tours(args, getSession),
        },
        {
            name: "porthole_tour_discover",
            description:
                "Search Saved Tours owned by other Copilot sessions without loading them into " +
                "the current Tour Library. This is the only cross-session Tour lookup. Results " +
                "are read-only and include source session, repository, branch, dates and " +
                "staleness. Use porthole_tour_import for a deliberate session-owned copy.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Text matched against Tour id and title." },
                    repo: { type: "string", description: "Only Tours saved for this repository path." },
                    sourceSessionId: { type: "string", description: "Only Tours from this source Copilot session." },
                    limit: { type: "integer", description: "Maximum results. Default 50." },
                },
            },
            handler: async (args) => discoverTours(args, getSession),
        },
        {
            name: "porthole_tour_import",
            description:
                "Import one Tour found by Saved Tour Discovery as an independent copy owned by " +
                "the current Copilot session. The copy records Tour Provenance and can never " +
                "mutate the historical source. ID collisions derive a safe id unless the user " +
                "explicitly requests replacement; replacement is confirmed in VS Code.",
            parameters: {
                type: "object",
                properties: {
                    sourceSessionId: { type: "string", description: "Source session id from porthole_tour_discover." },
                    sourceTourId: { type: "string", description: "Source Tour id from porthole_tour_discover." },
                    targetTourId: { type: "string", description: "Optional preferred id for the Imported Tour." },
                    replace: { type: "boolean", description: "Ask VS Code to confirm replacing a same-id current-session Tour. Default false." },
                },
                required: ["sourceSessionId", "sourceTourId"],
            },
            handler: async (args) => importSavedTour(args, getSession),
        },
        {
            name: "porthole_tour_cleanup_legacy",
            description:
                "Permanently delete one exact record that Saved Tour Discovery marked LEGACY " +
                "COPY. VS Code shows the provenance evidence and requires confirmation. " +
                "UNCERTAIN records are refused, and same-ID Tours elsewhere are never touched. " +
                "Use only when the user explicitly asks to clean up that discovered copy.",
            parameters: {
                type: "object",
                properties: {
                    sourceSessionId: { type: "string", description: "Claimed session id from Saved Tour Discovery." },
                    sourceTourId: { type: "string", description: "Exact LEGACY COPY Tour id from Saved Tour Discovery." },
                },
                required: ["sourceSessionId", "sourceTourId"],
            },
            handler: async (args) => cleanupLegacyTour(args, getSession),
        },

        {
            name: "porthole_tour_manage",
            description:
                "Switch, close, archive, unarchive or delete a Tour in this Copilot session's " +
                "Porthole window, by id.\n\n" +
                "  activate - make this the tour the user is walking, loading it from disk if " +
                "needed from this session's Tour Library.\n" +
                "  goto     - activate it and jump straight to a particular step.\n" +
                "  close    - stop walking it. It stays in the library, in the Problems panel " +
                "and on disk.\n" +
                "  archive  - hide it durably from the default Tour Library while keeping it " +
                "saved and searchable with porthole_tours includeArchived.\n" +
                "  unarchive - return an archived Tour to the default Tour Library.\n" +
                "  delete   - remove it from the library and from disk. Destructive; only when " +
                "the user asks.\n" +
                "  diff     - open the Step diff for a step of a Tour with a Recorded comparison: " +
                "the native VS Code diff of what that change did to the step's file, beside the " +
                "source. Does not move the Tour. The Tour must be loaded in that window.\n\n" +
                "Use porthole_tours first to find the id. Close, Archive and Delete are distinct: " +
                "prefer close for a pause, archive for durable decluttering, and delete only " +
                "when the user wants the Tour permanently removed.",
            parameters: {
                type: "object",
                properties: {
                    tourId: {
                        type: "string",
                        description: "The tour's id, as reported by porthole_tours.",
                    },
                    action: {
                        type: "string",
                        enum: ["activate", "goto", "close", "archive", "unarchive", "delete", "diff"],
                        description: "What to do with it. Defaults to activate.",
                    },
                    step: {
                        type: "integer",
                        description: "For 'goto' and 'diff': the step, 0-based. 'diff' defaults to the current step.",
                    },
                    side: {
                        type: "string",
                        enum: ["saved", "target"],
                        description:
                            "For 'diff': compare against the saved file (default) or the recorded " +
                            "target revision.",
                    },
                    windowId: {
                        type: "string",
                        description:
                            "Optional owned Porthole window for activate, goto, close, or diff. It is " +
                            "rejected for archive, unarchive, and delete.",
                    },
                },
                required: ["tourId"],
            },
            handler: async (args) => manage(args, getSession),
        },
    ];
}
