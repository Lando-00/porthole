// Turning a diff into candidate walkthrough steps.
//
// Asked to walk someone through a pull request or through what an autopilot
// session just did, the model otherwise has to go looking for the changed code:
// grep, read whole files, guess. That is slow, expensive, and - worst of all -
// silently incomplete, because a changed file it never opened simply does not
// appear in the walkthrough and nothing says so.
//
// So this reads the diff and hands back the changed hunks already shaped like
// tour steps. What is left for the model is the part only it can do: drop the
// hunks that do not earn a stop, order what remains the way control actually
// flows, and write the narration.
//
// Nothing here talks to the companion. There is no route, no capability and no
// protocol change - it is git, read locally, formatted for a reader. That is
// deliberate: the moment this needs the editor it stops being cheap.
//
// The one rule everything else follows from: every range this emits must be
// valid in the files on disk *right now*. A tour anchors against the working
// tree, so a range from a diff whose right-hand side is not checked out points
// at innocent code, and the reader has no way to tell. That is why a pull
// request that is not checked out is refused rather than approximated.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, isGitRepo, projectRoot } from "./git.mjs";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/** How far apart two hunks may be and still be one place worth stopping. */
const MERGE_GAP = 10;

/** A merged candidate wider than this has stopped being a stop. */
const MAX_SPAN = 200;

/** Beyond this, a new file needs sub-ranges rather than one enormous step. */
const NEW_FILE_CAP = 80;

// --- noise ------------------------------------------------------------------
//
// Things nobody wants a walkthrough of. This is an editorial judgement, not a
// security boundary: `includeAll` turns it off entirely, and being wrong here
// costs a wasted step, nothing more.

const NOISE_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "cargo.lock",
    "poetry.lock",
    "gemfile.lock",
    "go.sum",
    "composer.lock",
]);

const NOISE_SEGMENTS = new Set([
    "node_modules",
    "dist",
    "build",
    "out",
    "vendor",
    ".next",
    "coverage",
    "__snapshots__",
]);

const NOISE_SUFFIXES = [
    ".min.js",
    ".min.css",
    ".map",
    ".snap",
    ".lock",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".pdf",
    ".zip",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp4",
    ".wasm",
];

/**
 * Segments are compared whole rather than by substring, so `src/dist-helper.js`
 * survives while `src/dist/helper.js` does not.
 */
export function isNoise(relPath) {
    const lower = String(relPath || "").replace(/\\/g, "/").toLowerCase();
    if (!lower) return false;

    const segments = lower.split("/").filter(Boolean);
    const name = segments[segments.length - 1] || "";

    if (NOISE_FILES.has(name)) return true;
    if (segments.slice(0, -1).some((s) => NOISE_SEGMENTS.has(s))) return true;
    return NOISE_SUFFIXES.some((s) => name.endsWith(s));
}

// --- parsing ----------------------------------------------------------------

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Reads `git diff --unified=0` output into new-side ranges.
 *
 * Only the right-hand side is ever used - see the file header. A hunk with a
 * new-side length of zero is a pure deletion; it still deserves a stop, at the
 * line the removed code used to follow, so it becomes a single line marked as
 * such rather than being dropped.
 *
 * The text trailing the second `@@` is git's funcname guess. It is passed
 * through untouched and labelled as a guess everywhere it is shown, because it
 * is often not a function at all: git's default rule is roughly "the nearest
 * line above that starts with a letter", which in a plain text file is simply
 * the previous sentence.
 */
export function parseHunks(diffText) {
    const hunks = [];
    let file = null;

    for (const line of String(diffText || "").split(/\r?\n/)) {
        if (line.startsWith("+++ ")) {
            const path = line.slice(4).trim();
            file = path === "/dev/null" ? null : stripPrefix(path);
            continue;
        }
        if (!file || !line.startsWith("@@")) continue;

        const m = HUNK.exec(line);
        if (!m) continue;

        const start = Number(m[1]);
        const length = m[2] === undefined ? 1 : Number(m[2]);
        if (!Number.isFinite(start) || !Number.isFinite(length)) continue;

        const deletion = length === 0;
        const from = deletion ? Math.max(1, start) : start;
        const to = deletion ? from : start + length - 1;

        hunks.push({
            file,
            start: from,
            end: Math.max(from, to),
            context: m[3].trim(),
            deletion,
            hunks: 1,
        });
    }

    return hunks;
}

function stripPrefix(path) {
    let value = path;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("b/")) value = value.slice(2);
    return value;
}

/**
 * Collapses hunks that are close enough to be one place.
 *
 * A three-line edit and a two-line edit four lines apart are one change to a
 * human. Two stops for them is padding, and padding is what makes a walkthrough
 * feel like a list.
 */
export function mergeHunks(hunks, gap = MERGE_GAP, maxSpan = MAX_SPAN) {
    const merged = [];

    for (const hunk of hunks) {
        const last = merged[merged.length - 1];
        const adjacent =
            last &&
            last.file === hunk.file &&
            hunk.start - last.end - 1 <= gap &&
            hunk.end - last.start + 1 <= maxSpan;

        if (!adjacent) {
            merged.push({ ...hunk });
            continue;
        }

        last.end = Math.max(last.end, hunk.end);
        last.hunks += hunk.hunks;
        last.deletion = last.deletion && hunk.deletion;
        if (!last.context) last.context = hunk.context;
    }

    return merged;
}

// --- choosing what to compare ------------------------------------------------

const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

function refExists(run, root, ref) {
    return run(["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
}

function isBranch(run, root, name) {
    return (
        run(["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null ||
        run(["-C", root, "rev-parse", "--verify", "--quiet", `refs/remotes/${name}`]) !== null
    );
}

function defaultBranch(run, root) {
    const head = run(["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head) return head;
    return BASE_CANDIDATES.find((ref) => refExists(run, root, ref)) || null;
}

function hasChanges(run, root, spec) {
    const out = run(["-C", root, "diff", "--name-only", ...spec]);
    return out !== null && out.trim() !== "";
}

/**
 * Works out what "what changed" means when nobody said.
 *
 * Uncommitted work comes first because that is the autopilot case: the agent
 * has just edited files and has not committed them. Then the branch, compared
 * against its merge-base so that commits which landed on main in the meantime
 * are not mistaken for this branch's work. Then, having run out of better
 * ideas, the last commit.
 */
export function resolveSpec(args = {}, run = git, cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const raw = typeof args.since === "string" ? args.since.trim() : "";

    if (!raw) {
        const dirty = run(["-C", root, "status", "--porcelain"]);
        if (dirty !== null && dirty.trim() !== "") {
            return {
                spec: ["HEAD"],
                worktree: true,
                description: "uncommitted changes (HEAD vs working tree)",
                auto: "you have uncommitted changes",
            };
        }

        const base = defaultBranch(run, root);
        if (base && hasChanges(run, root, [`${base}...HEAD`])) {
            return {
                spec: [`${base}...HEAD`],
                description: `${base}...HEAD`,
                auto: `you are on a branch that has moved on from ${base}`,
            };
        }

        return {
            spec: ["HEAD~1..HEAD"],
            description: "the last commit (HEAD~1..HEAD)",
            auto: "there is nothing uncommitted and no branch to compare against",
        };
    }

    if (["staged", "cached", "--staged", "--cached"].includes(raw)) {
        return { spec: ["--cached"], description: "staged changes (HEAD vs index)" };
    }
    if (raw === "uncommitted") {
        return { spec: ["HEAD"], worktree: true, description: "uncommitted changes (HEAD vs working tree)" };
    }
    if (raw.includes("..")) {
        return { spec: [raw], description: raw };
    }

    if (isBranch(run, root, raw)) {
        return { spec: [`${raw}...HEAD`], description: `${raw}...HEAD` };
    }
    if (refExists(run, root, raw)) {
        return { spec: [`${raw}..HEAD`], description: `${raw}..HEAD` };
    }

    return { error: `porthole: git could not resolve '${raw}'. Check the branch or commit exists.` };
}

// --- collecting --------------------------------------------------------------

/**
 * numstat writes a rename as `old => new` or `dir/{old => new}/file`. Only the
 * new path can be pointed at, so that is what is kept.
 */
export function numstatPath(raw) {
    let value = String(raw || "").trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!value.includes("=>")) return value;

    if (value.includes("{")) {
        return value.replace(/\{([^}]*)=>([^}]*)\}/, (_, __, after) => after.trim()).replace(/\/{2,}/g, "/");
    }
    return value.split("=>").pop().trim();
}

function counts(run, root, spec) {
    const out = run(["-C", root, "diff", "--numstat", "--find-renames", ...spec]);
    const byFile = new Map();
    const binary = [];
    if (out === null) return { byFile, binary };

    for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [added, removed, ...rest] = line.split("\t");
        const file = numstatPath(rest.join("\t"));
        if (!file) continue;
        if (added === "-" || removed === "-") {
            binary.push(file);
            continue;
        }
        byFile.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
    }
    return { byFile, binary };
}

function deletions(run, root, spec, includeAll) {
    const out = run(["-C", root, "diff", "--name-only", "--diff-filter=D", "--find-renames", ...spec]);
    if (!out) return [];
    return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((f) => includeAll || !isNoise(f));
}

function fileLines(root, relPath) {
    try {
        return readFileSync(join(root, relPath), "utf8").split(/\r?\n/).length;
    } catch {
        return null;
    }
}

// --- pull requests -----------------------------------------------------------

function defaultGh(args, cwd) {
    try {
        return execFileSync("gh", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * A pull request can only be walked if it is the code on disk.
 *
 * The alternative - emitting the PR's line numbers against whatever happens to
 * be checked out - produces a walkthrough that points confidently at unrelated
 * code. There is no way for the reader to notice, so this refuses instead, and
 * names the one command that fixes it.
 */
function pullRequest(number, run, runGh, root) {
    const raw = runGh(
        ["pr", "view", String(number), "--json", "headRefOid,headRefName,baseRefName,title"],
        root,
    );
    if (!raw) {
        return {
            error:
                `porthole: could not read PR ${number} - the GitHub CLI (gh) is not available, ` +
                "not authenticated, or that pull request does not exist. Check out the branch " +
                "and use 'since' instead.",
        };
    }

    let info;
    try {
        info = JSON.parse(raw);
    } catch {
        return { error: `porthole: could not understand what gh reported for PR ${number}.` };
    }

    const head = run(["-C", root, "rev-parse", "HEAD"]);
    if (info.headRefOid && head && info.headRefOid !== head) {
        const files = runGh(["pr", "diff", String(number), "--name-only"], root);
        const list = files ? `\n${files.split(/\r?\n/).filter(Boolean).map((f) => `  ${f}`).join("\n")}` : "";
        return {
            error:
                `porthole: PR ${number} ("${info.title || "untitled"}", ${info.headRefName} into ` +
                `${info.baseRefName}) is not checked out here, so its line numbers do not match ` +
                "the files on disk. A walkthrough built from them would point at the wrong code." +
                `${list}\n\nRun 'gh pr checkout ${number}', then call porthole_changes again.`,
        };
    }

    const base = info.baseRefName || "main";
    const spec = refExists(run, root, `origin/${base}`) ? `origin/${base}...HEAD` : `${base}...HEAD`;
    return {
        spec: [spec],
        description: `PR ${number} "${info.title || "untitled"}" (${spec})`,
    };
}

// --- formatting --------------------------------------------------------------

/**
 * Laid out so the model can transcribe a line straight into a tour step, and so
 * a human reading the transcript can see what was on offer and what was left
 * out. The closing paragraph is instruction, not decoration: without it the
 * model tends to narrate the diff back rather than build anything.
 */
export function formatChanges(model) {
    const { description, auto, candidates, files, totals, deleted, skipped, truncated, total } = model;

    if (candidates.length === 0) {
        return `porthole: no changes found for ${description}.`;
    }

    const lines = [
        `Comparing ${description} - ${candidates.length} candidate step(s) in ${files.length} file(s) ` +
            `(+${totals.added} -${totals.removed}).`,
    ];
    if (auto) lines.push(`Auto-detected: ${auto}.`);
    lines.push("");

    let current = null;
    for (const c of candidates) {
        if (c.file !== current) {
            current = c.file;
            // The counts belong to the file, so they are shown once. Repeating
            // them on every range read as if each hunk had added them all.
            const n = c.counts;
            lines.push(n ? `${current}  (+${n.added} -${n.removed})` : current);
        }
        const range = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`;
        const bits = [];
        if (c.newFile) {
            bits.push(
                c.newFileLines > NEW_FILE_CAP
                    ? `new file, ${c.newFileLines} lines - pick sub-ranges rather than touring all of it`
                    : `new file, ${c.newFileLines} lines`,
            );
        } else if (c.context) {
            bits.push(`~ ${c.context}`);
        }
        if (c.deletion) bits.push("code removed here");
        if (c.hunks > 1) bits.push(`${c.hunks} hunks`);

        lines.push(`  ${range.padEnd(10)}${bits.join(", ")}`.trimEnd());
    }

    const notes = [];
    if (deleted.length) {
        const shown = deleted.slice(0, 10).join(", ");
        const more = deleted.length > 10 ? ` and ${deleted.length - 10} more` : "";
        notes.push(`Deleted, so they cannot be walked: ${shown}${more}`);
    }
    if (skipped > 0) {
        notes.push(`${skipped} file(s) skipped as generated or binary - pass includeAll to see them.`);
    }
    if (truncated) {
        notes.push(`(showing ${candidates.length} of ${total} candidates - narrow with 'since', or raise 'limit')`);
    }
    if (notes.length) lines.push("", ...notes);

    lines.push(
        "",
        "These are candidate steps, not a tour. Drop the ones that do not help, order what is",
        "left the way control actually flows, then call porthole_tour with a stepTitle and",
        "narration for each. The `~` text is git's guess at the enclosing function and is often",
        "wrong - read the code before repeating it to the user.",
    );

    return lines.join("\n");
}

// --- the tool ----------------------------------------------------------------

export async function changes(args = {}, _getSession = null, deps = {}) {
    const cwd = process.cwd();
    const run = deps.run || git;
    const runGh = deps.runGh || defaultGh;

    if (!isGitRepo(cwd)) {
        return "porthole: not a git repository, so there is nothing to compare.";
    }
    if (args.pr !== undefined && args.pr !== null && args.since) {
        return "porthole: give either 'since' or 'pr', not both.";
    }

    const root = projectRoot(cwd);
    const resolved =
        args.pr === undefined || args.pr === null
            ? resolveSpec(args, run, cwd)
            : pullRequest(args.pr, run, runGh, root);
    if (resolved.error) return resolved.error;

    const { spec, description, auto } = resolved;

    const diff = run([
        "-C",
        root,
        "-c",
        "core.quotePath=false",
        "diff",
        "--unified=0",
        "--no-color",
        "--find-renames",
        "--diff-filter=ACMRT",
        ...spec,
    ]);
    if (diff === null) {
        return `porthole: git could not compare ${description}.`;
    }

    const includeAll = args.includeAll === true;
    const { byFile, binary } = counts(run, root, spec);

    const raw = parseHunks(diff);
    if (resolved.worktree) raw.push(...untrackedCandidates(run, root));

    // A file is dropped whole, never hunk by hunk, so the count reported to the
    // reader counts files - which is what they are thinking in.
    const seen = new Set();
    const dropped = new Set();
    for (const h of raw) {
        if (seen.has(h.file)) continue;
        seen.add(h.file);
        if (!includeAll && isNoise(h.file)) dropped.add(h.file);
        else if (binary.includes(h.file)) dropped.add(h.file);
        else if (!existsSync(join(root, h.file))) dropped.add(h.file);
    }
    const skipped = dropped.size;

    const usable = raw.filter((h) => !dropped.has(h.file));
    const merged = args.merge === false ? usable : mergeHunks(usable);

    const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const truncated = merged.length > limit;
    const candidates = merged.slice(0, limit);

    const newFiles = newFileSet(run, root, spec);
    for (const c of candidates) {
        c.counts = byFile.get(c.file) || null;
        if (newFiles.has(c.file) || c.untracked) {
            c.newFile = true;
            c.newFileLines = fileLines(root, c.file);
            if (c.untracked && c.newFileLines !== null) {
                c.end = Math.max(1, c.newFileLines);
                c.counts = c.counts || { added: c.newFileLines, removed: 0 };
            }
            if (c.newFileLines !== null && c.newFileLines > NEW_FILE_CAP) {
                c.start = 1;
                c.end = NEW_FILE_CAP;
            }
        }
    }

    const totals = { added: 0, removed: 0 };
    const files = [...new Set(candidates.map((c) => c.file))];
    const counted = new Set();
    for (const c of candidates) {
        if (counted.has(c.file)) continue;
        counted.add(c.file);
        const entry = byFile.get(c.file) || c.counts;
        if (!entry) continue;
        totals.added += entry.added;
        totals.removed += entry.removed;
    }

    return formatChanges({
        description,
        auto,
        candidates,
        files,
        totals,
        deleted: deletions(run, root, spec, includeAll),
        skipped,
        truncated,
        total: merged.length,
    });
}

function newFileSet(run, root, spec) {
    const out = run(["-C", root, "diff", "--name-only", "--diff-filter=A", "--find-renames", ...spec]);
    if (!out) return new Set();
    return new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

/**
 * A file that has been created but never added is invisible to `git diff`, and
 * that is exactly the file an autopilot session most often wants explained.
 *
 * Listing them separately keeps this read-only. The obvious alternative,
 * `git add -N`, would make a tool whose whole job is to look at things quietly
 * write to the user's index.
 */
export function untrackedCandidates(run, root) {
    const out = run(["-C", root, "ls-files", "--others", "--exclude-standard"]);
    if (!out) return [];
    return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((file) => ({ file, start: 1, end: 1, context: "", deletion: false, hunks: 1, untracked: true }));
}

export function tools(getSession = null) {
    return [
        {
            name: "porthole_changes",
            description:
                "Read a diff and get back the changed code as candidate walkthrough steps: " +
                "file plus line range, already pointing at the files on disk. Call this FIRST " +
                "whenever the user asks to be walked through a change - a pull request, a " +
                "branch, or what you yourself just did - instead of searching for the changed " +
                "code. It is faster, and it means you cannot silently miss a changed file. " +
                "With no arguments it works out what to compare: uncommitted work if there is " +
                "any, otherwise this branch against its base, otherwise the last commit. Feed " +
                "the ranges you keep into porthole_tour. This reads git only and shows the " +
                "user nothing, so it is always safe to call.",
            parameters: {
                type: "object",
                properties: {
                    since: {
                        type: "string",
                        description:
                            "What to compare against: a branch (compared against the merge-base), " +
                            "a commit, a range like 'a..b', 'staged', or 'uncommitted'. Omit to " +
                            "let porthole work it out.",
                    },
                    pr: {
                        type: "integer",
                        description:
                            "A GitHub pull request number. Requires the gh CLI, and requires the " +
                            "pull request to be checked out - otherwise its line numbers would not " +
                            "match the files on disk and the walkthrough would point at the wrong " +
                            "code. Cannot be combined with 'since'.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum candidate steps to return (default 60, max 200).",
                    },
                    includeAll: {
                        type: "boolean",
                        description:
                            "Include lockfiles, generated output and binaries, which are skipped " +
                            "by default. Rarely useful.",
                    },
                    merge: {
                        type: "boolean",
                        description:
                            "Merge changes that are within ten lines of each other into one " +
                            "candidate. Default true; turn it off to see every hunk separately.",
                    },
                },
            },
            handler: async (args) => changes(args, getSession),
        },
    ];
}
