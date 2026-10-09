// A change inventory is not a walkthrough. Git supplies evidence about a
// comparison; the model reads current saved files and chooses the actual stops.
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { runCommand } from "./command.mjs";

export const CHANGE_LIMITS = Object.freeze({
    totalMs: 10_000,
    gitMs: 3000,
    ghMs: 6000,
    inventoryBytes: 4 * 1024 * 1024,
    patchBytes: 512 * 1024,
    resultBytes: 256 * 1024,
    fileBytes: 512 * 1024,
    smallFiles: 50,
    smallLines: 2000,
});

const NOISE_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock", "gemfile.lock", "go.sum", "composer.lock"]);
const NOISE_SEGMENTS = new Set(["node_modules", "dist", "build", "out", "vendor", ".next", "coverage", "__snapshots__"]);
const NOISE_SUFFIXES = [".min.js", ".min.css", ".map", ".snap", ".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf", ".zip", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".wasm"];
const COMMIT = /^[a-f0-9]{40,64}$/i;

class EvidenceError extends Error {
    constructor(reason, message) {
        super(message);
        this.reason = reason;
    }
}

export function isNoise(file) {
    const segments = String(file).replace(/\\/g, "/").toLowerCase().split("/");
    const name = segments.at(-1);
    return NOISE_FILES.has(name) || segments.slice(0, -1).some((part) => NOISE_SEGMENTS.has(part)) ||
        NOISE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function nulFields(text) {
    if (!text) return [];
    if (!text.endsWith("\0")) throw new EvidenceError("invalid-metadata", "Git returned incomplete filename metadata");
    return text.slice(0, -1).split("\0");
}

export function parseNameStatus(text) {
    const fields = nulFields(text);
    const files = [];
    for (let i = 0; i < fields.length;) {
        const status = fields[i++];
        if (!/^[ACDMRTUXB](?:\d+)?$/.test(status || "")) throw new EvidenceError("invalid-metadata", "Git returned an invalid file status");
        const first = fields[i++];
        const renamed = /^[RC]/.test(status);
        const file = renamed ? fields[i++] : first;
        if (!first || !file) throw new EvidenceError("invalid-metadata", "Git returned an incomplete rename or filename");
        files.push({ path: file, status, ...(renamed ? { oldPath: first } : {}) });
    }
    return files;
}

export function parseNumstat(text) {
    const fields = nulFields(text);
    const counts = new Map();
    for (let i = 0; i < fields.length;) {
        const line = fields[i++];
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(line);
        if (!match) throw new EvidenceError("invalid-metadata", "Git returned invalid line counts");
        let file = match[3];
        if (!file) {
            const old = fields[i++];
            file = fields[i++];
            if (!old || !file) throw new EvidenceError("invalid-metadata", "Git returned incomplete rename counts");
        }
        const binary = match[1] === "-" || match[2] === "-";
        counts.set(file, { added: binary ? null : Number(match[1]), removed: binary ? null : Number(match[2]), binary });
    }
    return counts;
}

function patchPath(raw) {
    let value = raw;
    if (value.startsWith('"')) {
        const match = /^"((?:\\.|[^"\\])*)"(?:\t.*)?$/.exec(value);
        if (!match) throw new EvidenceError("invalid-patch", "Git returned an invalid quoted patch path");
        const parts = [];
        const text = match[1];
        const escapes = { t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"' };
        for (let i = 0; i < text.length;) {
            if (text[i] !== "\\") {
                let end = text.indexOf("\\", i);
                if (end < 0) end = text.length;
                parts.push(Buffer.from(text.slice(i, end)));
                i = end;
                continue;
            }
            i += 1;
            const octal = /^[0-7]{1,3}/.exec(text.slice(i));
            if (octal) {
                parts.push(Buffer.from([Number.parseInt(octal[0], 8)]));
                i += octal[0].length;
            } else {
                if (!(text[i] in escapes)) throw new EvidenceError("invalid-patch", "Git returned an unknown path escape");
                parts.push(Buffer.from(escapes[text[i++]]));
            }
        }
        value = Buffer.concat(parts).toString("utf8");
    } else {
        value = value.split("\t", 1)[0];
    }
    return value === "/dev/null" ? null : value.replace(/^b\//, "");
}

/** Hunk state prevents an added source line beginning `+++ ` becoming a filename. */
export function parseHunks(text) {
    const hunks = [];
    let file = null;
    let oldRemaining = 0;
    let newRemaining = 0;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            file = null;
            oldRemaining = newRemaining = 0;
            continue;
        }
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
        if (header && file) {
            oldRemaining = Number(header[2] ?? 1);
            newRemaining = Number(header[4] ?? 1);
            const newStart = Number(header[3]);
            hunks.push({
                file,
                start: Math.max(1, newStart),
                end: Math.max(1, newStart + Math.max(1, newRemaining) - 1),
                oldStart: Number(header[1]),
                oldCount: oldRemaining,
                newStart,
                newCount: newRemaining,
                deletion: newRemaining === 0,
                context: header[5].trim().slice(0, 200),
                hunks: 1,
            });
            continue;
        }
        if (oldRemaining > 0 || newRemaining > 0) {
            if (line.startsWith("+")) newRemaining -= 1;
            else if (line.startsWith("-")) oldRemaining -= 1;
            else if (line.startsWith(" ")) { oldRemaining -= 1; newRemaining -= 1; }
            continue;
        }
        if (line.startsWith("+++ ")) file = patchPath(line.slice(4));
    }
    return hunks;
}

export function mergeHunks(hunks, gap = 10, maxSpan = 200) {
    const merged = [];
    for (const hunk of hunks) {
        const last = merged.at(-1);
        if (last && last.file === hunk.file && !last.deletion && !hunk.deletion &&
            hunk.start >= last.start && hunk.start - last.end - 1 <= gap &&
            hunk.end - last.start + 1 <= maxSpan) {
            last.end = Math.max(last.end, hunk.end);
            last.hunks += hunk.hunks;
            last.context ||= hunk.context;
        } else merged.push({ ...hunk });
    }
    return merged;
}

function absoluteFile(root, file) {
    const absolute = resolve(root, file);
    const rel = relative(root, absolute);
    if (!file || !rel || isAbsolute(file) || /^[a-z]:/i.test(file) ||
        rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
        throw new EvidenceError("invalid-path", "A comparison filename is outside the repository");
    }
    return absolute;
}

function commandFailure(result, purpose) {
    const detail = (result.stderr || result.error || result.reason || "unknown failure").trim();
    throw new EvidenceError(result.reason || "command-failed", `${purpose}: ${detail}`);
}

function context(deps) {
    const limits = { ...CHANGE_LIMITS, ...deps.limits };
    const now = deps.now || (() => performance.now());
    const deadline = now() + limits.totalMs;
    const ctx = {
        root: resolve(deps.cwd || process.cwd()),
        limits,
        files: deps.fs || { lstat, open },
        remaining: () => Math.max(0, deadline - now()),
    };
    ctx.run = async (command, args, options = {}) => {
        const injected = command === "gh" ? deps.runGh : deps.runGit;
        const timeoutMs = Math.min(ctx.remaining(), command === "gh" ? limits.ghMs : limits.gitMs);
        if (timeoutMs <= 0) return { ok: false, reason: "timeout", stdout: "", stderr: "", error: "overall comparison budget exhausted" };
        if (injected) {
            const result = await injected(args, ctx.root, { timeoutMs, ...options });
            if (typeof result === "string") return { ok: true, code: 0, stdout: result, stderr: "" };
            return result || { ok: false, reason: "command-failed", stdout: "", stderr: "", error: `${command} is not available or the request failed` };
        }
        return (deps.runCommand || runCommand)(command, args, {
            cwd: ctx.root,
            timeoutMs,
            maxStdoutBytes: limits.inventoryBytes,
            ...options,
        });
    };
    ctx.git = (args, options) => ctx.run("git", ["--no-pager", "-c", "core.quotePath=false", ...args], options);
    return ctx;
}

async function commit(ctx, ref) {
    if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new EvidenceError("invalid-ref", `Invalid revision '${ref}'`);
    const result = await ctx.git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (!result.ok) {
        if (result.code === 1) return null;
        commandFailure(result, `Could not resolve '${ref}'`);
    }
    const oid = result.stdout.trim();
    if (!COMMIT.test(oid)) throw new EvidenceError("invalid-ref", `Git returned an invalid commit for '${ref}'`);
    return oid;
}

async function mergeBase(ctx, left, right, { optional = false } = {}) {
    const result = await ctx.git(["merge-base", left, right]);
    if (!result.ok && optional && result.code === 1) return null;
    if (!result.ok) commandFailure(result, "Could not find the merge-base (history may be shallow or unrelated)");
    const oid = result.stdout.trim();
    if (!COMMIT.test(oid)) throw new EvidenceError("invalid-ref", "Git returned an invalid merge-base");
    return oid;
}

async function comparison(args, ctx, head) {
    const raw = args.since?.trim() || "";
    if (["staged", "cached", "--staged", "--cached"].includes(raw)) {
        return { spec: ["--cached"], description: head ? "staged changes (HEAD vs index)" : "staged initial files (empty tree vs index)", basis: "index" };
    }
    if (raw === "uncommitted") {
        return { spec: head ? [head] : [], initial: !head, worktree: true, description: head ? "uncommitted changes (HEAD vs working tree)" : "initial files (no HEAD commit)", basis: "working tree" };
    }
    if (raw) {
        if (!head) throw new EvidenceError("unborn", "This repository has no HEAD commit; use an initial-file inventory");
        const range = /^(.*?)\.{2,3}(.*?)$/.exec(raw);
        if (range) {
            const left = await commit(ctx, range[1] || "HEAD");
            const right = await commit(ctx, range[2] || "HEAD");
            if (!left || !right) throw new EvidenceError("invalid-ref", `Git could not resolve '${raw}'`);
            return { spec: [raw.includes("...") ? await mergeBase(ctx, left, right) : left, right], description: raw, basis: `revision ${right}` };
        }
        const oid = await commit(ctx, raw);
        if (!oid) throw new EvidenceError("invalid-ref", `Git could not resolve '${raw}'`);
        const refs = /^refs\/(?:heads|remotes)\//.test(raw) ? [raw] : [`refs/heads/${raw}`, `refs/remotes/${raw}`];
        let isBranch = false;
        for (const ref of refs) {
            const branch = await ctx.git(["show-ref", "--verify", "--quiet", ref]);
            if (!branch.ok && branch.code !== 1) commandFailure(branch, "Could not inspect the branch");
            if (branch.ok) { isBranch = true; break; }
        }
        return { spec: [isBranch ? await mergeBase(ctx, oid, head) : oid, head], description: `${raw}${isBranch ? "..." : ".."}HEAD`, basis: `revision ${head}` };
    }

    const status = await ctx.git(["status", "--porcelain=v1", "-z"]);
    if (!status.ok) commandFailure(status, "Could not inventory working-tree status");
    if (status.stdout || !head) {
        return { spec: head ? [head] : [], initial: !head, worktree: true, description: head ? "uncommitted changes (HEAD vs working tree)" : "initial files (no HEAD commit)", basis: "working tree", auto: "uncommitted or initial files" };
    }
    const symbolic = await ctx.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (!symbolic.ok && symbolic.code !== 1 && symbolic.code !== 128) commandFailure(symbolic, "Could not inspect the default branch");
    const bases = [...new Set([symbolic.ok ? symbolic.stdout.trim() : null, "origin/main", "origin/master", "main", "master"].filter(Boolean))];
    for (const name of bases) {
        const base = await commit(ctx, name);
        if (!base) continue;
        const ancestor = await mergeBase(ctx, base, head);
        if (ancestor !== head) return { spec: [ancestor, head], description: `${name}...HEAD`, basis: `revision ${head}`, auto: `branch compared with ${name}` };
        break;
    }
    const parents = await ctx.git(["rev-list", "--parents", "-n", "1", head]);
    if (!parents.ok) commandFailure(parents, "Could not read the last commit");
    const parent = parents.stdout.trim().split(/\s+/)[1];
    return { spec: parent ? [parent, head] : [head], rootCommit: !parent, description: "the last commit", basis: `revision ${head}`, auto: "no uncommitted or branch changes" };
}

function diffArgs(selected, mode) {
    const args = selected.rootCommit
        ? ["diff-tree", "--root", "--no-commit-id", "-r"]
        : ["diff"];
    args.push("--no-ext-diff", "--no-textconv", "--no-color", "--find-renames");
    if (mode === "patch") args.push("--patch", "--unified=0", "--src-prefix=a/", "--dst-prefix=b/");
    else args.push(mode === "status" ? "--name-status" : "--numstat", "-z");
    return [...args, ...selected.spec, "--"];
}

async function untracked(ctx, selected) {
    if (!selected.worktree) return [];
    const result = await ctx.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (!result.ok) commandFailure(result, "Could not list untracked files");
    return nulFields(result.stdout).map((path) => ({ path, status: "?", untracked: true }));
}

async function fileCounts(ctx, entry) {
    if (ctx.remaining() <= 0) return { countNote: "count not read: comparison budget exhausted" };
    let expired = false;
    let timer;
    const timeout = new Promise((resolveTimeout) => {
        timer = setTimeout(() => {
            expired = true;
            resolveTimeout({ countNote: "file-count read exceeded its budget" });
        }, Math.min(ctx.remaining(), ctx.limits.gitMs));
    });
    try {
        return await Promise.race([readFileCounts(ctx, entry, () => expired), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function readFileCounts(ctx, entry, expired) {
    let handle;
    try {
        const stat = await ctx.files.lstat(entry.file);
        if (expired()) return { countNote: "file-count read exceeded its budget" };
        if (!stat.isFile()) return { countNote: "not a regular file" };
        if (stat.size > ctx.limits.fileBytes) return { countNote: "file exceeds the bounded read size" };
        handle = await ctx.files.open(entry.file, "r");
        if (expired()) return { countNote: "file-count read exceeded its budget" };
        const buffer = Buffer.alloc(Math.min(stat.size + 1, ctx.limits.fileBytes + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > ctx.limits.fileBytes || bytesRead !== stat.size) return { countNote: "file changed while its count was read" };
        const bytes = buffer.subarray(0, bytesRead);
        if (bytes.includes(0)) return { binary: true };
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch (error) {
            if (!(error instanceof TypeError)) throw error;
            return { countNote: "not UTF-8 text" };
        }
        const count = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
        return { added: count, removed: 0 };
    } catch (error) {
        if (!error.code) throw error;
        return { countNote: `unreadable (${error.code})` };
    } finally {
        if (handle) await handle.close();
    }
}

function json(text, purpose) {
    try { return JSON.parse(text); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new EvidenceError("invalid-metadata", `${purpose} returned invalid JSON`);
    }
}

async function pullRequest(args, ctx, head) {
    const result = await ctx.run("gh", ["pr", "view", String(args.pr), "--json", "headRefOid,baseRefOid,headRefName,baseRefName,title,changedFiles,url"]);
    if (!result.ok) commandFailure(result, `Could not read PR ${args.pr}; check GitHub CLI availability, authentication and repository access`);
    const info = json(result.stdout, "GitHub CLI");
    if (!info || !COMMIT.test(info.headRefOid || "")) throw new EvidenceError("invalid-metadata", "GitHub CLI returned no valid PR head");
    const description = `PR ${args.pr} ${JSON.stringify(info.title || "untitled")}`;
    if (head === info.headRefOid && COMMIT.test(info.baseRefOid || "")) {
        const base = await commit(ctx, info.baseRefOid);
        const ancestor = base ? await mergeBase(ctx, base, head, { optional: true }) : null;
        if (ancestor) return { spec: [ancestor, head], description, basis: `PR revision ${head}` };
    }
    let url;
    try { url = new URL(info.url); }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new EvidenceError("invalid-metadata", "GitHub CLI returned no valid PR repository URL");
    }
    const location = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (!location || Number(location[3]) !== args.pr || !["https:", "http:"].includes(url.protocol)) {
        throw new EvidenceError("invalid-metadata", "GitHub CLI returned a different PR location");
    }
    const api = ["api", "--paginate", "--slurp", "--hostname", url.host,
        `repos/${location[1]}/${location[2]}/pulls/${args.pr}/files?per_page=100`];
    const inventory = await ctx.run("gh", api);
    if (!inventory.ok) commandFailure(inventory, "Could not obtain the PR file inventory");
    const pages = json(inventory.stdout, "PR file inventory");
    if (!Array.isArray(pages)) throw new EvidenceError("invalid-metadata", "PR file inventory is not an array");
    const statuses = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "T", unchanged: "M" };
    const files = pages.flat().map((entry) => {
        if (!entry || typeof entry.filename !== "string" || !Number.isInteger(entry.additions) || entry.additions < 0 ||
            !Number.isInteger(entry.deletions) || entry.deletions < 0) {
            throw new EvidenceError("invalid-metadata", "PR file inventory contains invalid paths or counts");
        }
        const ambiguousZero = entry.additions === 0 && entry.deletions === 0;
        return {
            path: entry.filename,
            status: statuses[entry.status] || "?",
            oldPath: entry.previous_filename,
            added: ambiguousZero ? null : entry.additions,
            removed: ambiguousZero ? null : entry.deletions,
            ...(ambiguousZero ? { countNote: "GitHub reports zero counts; binary/type-only changes are not distinguishable" } : {}),
        };
    });
    return {
        spec: [],
        description,
        basis: `PR revision ${info.headRefOid}`,
        remoteFiles: files,
        remoteComplete: Number.isInteger(info.changedFiles) && info.changedFiles === files.length &&
            new Set(files.map((file) => file.path)).size === files.length,
        inventoryReason: "PR revision is not checked out or its comparison history is unavailable locally; read current files before authoring a Tour",
    };
}

export async function collectChanges(args = {}, deps = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new EvidenceError("invalid-input", "Changes parameters must be an object");
    if (args.since !== undefined && typeof args.since !== "string") throw new EvidenceError("invalid-input", "'since' must be a revision or comparison name");
    if (args.pr !== undefined && (!Number.isInteger(args.pr) || args.pr < 1)) throw new EvidenceError("invalid-input", "'pr' must be a positive pull request number");
    if (args.pr !== undefined && args.since) throw new EvidenceError("invalid-input", "give either 'since' or 'pr', not both");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) throw new EvidenceError("invalid-input", "'limit' must be a positive integer");
    const ctx = context(deps);
    const root = await ctx.git(["rev-parse", "--show-toplevel"]);
    if (!root.ok) {
        if (/not a git repository/i.test(root.stderr)) throw new EvidenceError("not-repository", "not a git repository, so there is nothing to compare");
        commandFailure(root, "Could not locate the repository");
    }
    ctx.root = resolve(root.stdout.trim());
    const head = await commit(ctx, "HEAD");
    const selected = args.pr !== undefined ? await pullRequest(args, ctx, head) : await comparison(args, ctx, head);
    const warnings = [];
    let files;
    if (selected.remoteFiles) {
        files = selected.remoteFiles;
        if (!selected.remoteComplete) warnings.push("PR inventory is incomplete or its total could not be confirmed; API caps may apply.");
    } else if (selected.initial) {
        const indexed = await ctx.git(["ls-files", "--cached", "-z"]);
        if (!indexed.ok) commandFailure(indexed, "Could not list initial indexed files");
        files = nulFields(indexed.stdout).map((path) => ({ path, status: "A", untracked: true }));
        files.push(...await untracked(ctx, selected));
        selected.inventoryReason = "initial-file inventory: this repository has no committed HEAD";
    } else {
        const names = await ctx.git(diffArgs(selected, "status"));
        if (!names.ok) commandFailure(names, "Could not collect comparison filenames");
        files = parseNameStatus(names.stdout);
        const stat = await ctx.git(diffArgs(selected, "counts"));
        if (!stat.ok) commandFailure(stat, "Could not collect comparison line counts");
        const counts = parseNumstat(stat.stdout);
        for (const entry of files) Object.assign(entry, counts.get(entry.path) || { countNote: "count unavailable" });
        const known = new Set(files.map((entry) => entry.path));
        for (const [path, count] of counts) {
            if (!known.has(path)) {
                files.push({ path, status: "?", ...count });
                warnings.push("Comparison files changed during collection; metadata is not a single snapshot.");
            }
        }
        files.push(...await untracked(ctx, selected));
    }
    const unique = new Map();
    for (const entry of files) {
        const value = { added: null, removed: null, binary: false, ...entry, file: absoluteFile(ctx.root, entry.path), noise: isNoise(entry.path) };
        if (entry.oldPath) value.oldFile = absoluteFile(ctx.root, entry.oldPath);
        unique.set(entry.path, value);
    }
    files = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of files.filter((file) => file.untracked)) {
        Object.assign(entry, files.length <= ctx.limits.smallFiles
            ? await fileCounts(ctx, entry)
            : { countNote: "untracked count omitted in large inventory" });
    }
    const changedLines = files.reduce((sum, file) => sum + (file.added || 0) + (file.removed || 0), 0);
    let reason = selected.inventoryReason ||
        (files.length > ctx.limits.smallFiles ? "changed-file limit" : changedLines > ctx.limits.smallLines ? "changed-line limit" : null);
    let candidates = [];
    if (!reason && files.length) {
        const patch = await ctx.git(diffArgs(selected, "patch"), { maxStdoutBytes: ctx.limits.patchBytes });
        if (!patch.ok) {
            reason = `${patch.reason}: patch detail unavailable within its budget`;
            warnings.push(patch.error || patch.stderr || reason);
        } else {
            const byPath = new Map(files.map((file) => [file.path, file]));
            for (const hunk of parseHunks(patch.stdout)) {
                const entry = byPath.get(hunk.file);
                if (!entry || entry.status === "D" || entry.binary || (!args.includeAll && entry.noise)) continue;
                candidates.push({ ...hunk, file: entry.file, path: entry.path });
            }
            for (const entry of files) {
                if (!entry.untracked || entry.binary || entry.added === null || entry.added === 0 || (!args.includeAll && entry.noise)) continue;
                candidates.push({ file: entry.file, path: entry.path, start: 1, end: entry.added, context: "", deletion: false, hunks: 1 });
            }
            candidates.sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start);
            if (args.merge !== false) candidates = mergeHunks(candidates);
            for (const candidate of candidates) {
                const entry = byPath.get(candidate.path);
                if (entry && (entry.status === "A" || entry.untracked)) {
                    candidate.newFile = true;
                    candidate.newFileLines = entry.added;
                    candidate.end = Math.min(candidate.end, 80);
                }
            }
        }
    }
    const totalCandidates = candidates.length;
    if (files.length && !totalCandidates && !reason) reason = "no selectable text detail in this comparison";
    candidates = candidates.slice(0, Math.min(args.limit || 60, 200));
    return {
        root: ctx.root,
        description: selected.description,
        auto: selected.auto,
        coordinateBasis: selected.basis,
        mode: reason ? "inventory-only" : "candidates",
        inventoryReason: reason,
        inventoryComplete: selected.remoteFiles ? selected.remoteComplete : !warnings.some((warning) => warning.includes("changed during collection")),
        files,
        candidates,
        totalCandidates,
        warnings: [...new Set(warnings)],
        resultBytes: ctx.limits.resultBytes,
    };
}

function printable(value) {
    const text = String(value);
    return /[\u0000-\u001f\u007f]/.test(text) ? JSON.stringify(text) : text;
}

export function formatChanges(model) {
    const { files, candidates, description } = model;
    if (!files.length && model.inventoryComplete) return `porthole: no changes found for ${description}.`;
    const lines = [
        `porthole: ${description}`,
        `Mode: ${model.mode}; ${files.length} changed file(s); ${candidates.length} candidate step(s).`,
        `Coordinate basis: ${model.coordinateBasis}. Historical/index coordinates are evidence, not guaranteed current-file locations.`,
    ];
    if (model.auto) lines.push(`Auto-detected: ${model.auto}.`);
    if (model.inventoryReason) lines.push(`Inventory only: ${model.inventoryReason}.`);
    if (!model.inventoryComplete) lines.push("INCOMPLETE INVENTORY: do not claim complete change coverage.");
    lines.push("");
    for (const entry of files) {
        const counts = entry.binary ? "binary; line counts not applicable" :
            entry.added === null || entry.removed === null ? `line counts unknown${entry.countNote ? `: ${entry.countNote}` : ""}` :
            `+${entry.added} -${entry.removed}`;
        const notes = [
            entry.status === "D" ? "deleted; no current-file step" : "",
            entry.noise ? "generated/noise detail may be omitted" : "",
            entry.oldFile ? `renamed/copied from ${printable(entry.oldFile)}` : "",
        ].filter(Boolean);
        lines.push(`${entry.status} ${printable(entry.file)}  (${counts})${notes.length ? ` - ${notes.join("; ")}` : ""}`);
        for (const candidate of candidates.filter((item) => item.file === entry.file)) {
            const range = candidate.start === candidate.end ? candidate.start : `${candidate.start}-${candidate.end}`;
            const detail = [];
            if (candidate.deletion) detail.push(`deletion boundary after new-side line ${candidate.newStart}; inspect current code`);
            else if (candidate.newFile) detail.push(`new file, ${candidate.newFileLines} lines${candidate.newFileLines > 80 ? " - pick sub-ranges beyond this preview" : ""}`);
            else if (candidate.context) detail.push(`~ ${printable(candidate.context)}`);
            if (candidate.hunks > 1) detail.push(`${candidate.hunks} hunks`);
            lines.push(`  ${String(range).padEnd(10)}${detail.join("; ")}`.trimEnd());
        }
    }
    if (model.totalCandidates > candidates.length) lines.push(`\n(showing ${candidates.length} of ${model.totalCandidates} candidates; read the remaining files directly or raise limit)`);
    for (const warning of model.warnings || []) lines.push(`Warning: ${printable(warning)}`);
    lines.push(
        "",
        "These are candidate steps, not a tour. Read the current saved files, choose meaningful",
        "locations, and call porthole_tour with titles and narration. Inventory-only results",
        "need normal repository reading, not another paging tool. The `~` text is git's guess,",
        "not a verified symbol. A listed file is not a claim that its changes were reviewed.",
    );
    const text = lines.join("\n");
    return Buffer.byteLength(text) <= (model.resultBytes || CHANGE_LIMITS.resultBytes)
        ? text
        : `porthole: the ${files.length}-file inventory exceeds the model-output budget. No complete inventory is shown; inspect Git directly.`;
}

export async function changes(args = {}, _getSession = null, deps = {}) {
    try { return formatChanges(await collectChanges(args, deps)); }
    catch (error) {
        if (!(error instanceof EvidenceError)) throw error;
        return `porthole: ${error.message}${error.message.endsWith(".") ? "" : "."}`;
    }
}

export function tools(getSession = null) {
    return [{
        name: "porthole_changes",
        description:
            "Read change evidence before a walkthrough of a PR, branch or recent edits. " +
            "Small comparisons include candidate ranges; large ones return filenames and line " +
            "counts so you can read the repository yourself. Historical/index ranges belong " +
            "to that comparison, not necessarily current files. Read current saved code before " +
            "publishing a Tour. Inspect reported omissions, unknown counts and incomplete " +
            "collection; never equate an inventory with completed review. This is read-only " +
            "and does not open an editor, stage, fetch or check out code.",
        parameters: {
            type: "object",
            properties: {
                since: { type: "string", description: "Branch (merge-base), commit, a..b/a...b, staged, or uncommitted. Omit for automatic comparison selection." },
                pr: { type: "integer", description: "Positive GitHub PR number, using gh. Mutually exclusive with since. An unavailable local PR revision yields labelled inventory, not a forced checkout." },
                limit: { type: "integer", description: "Maximum small-comparison candidates; default 60, max 200. Does not hide inventory files." },
                includeAll: { type: "boolean", description: "Include generated/noise text candidate detail. All files remain accounted for; binaries remain metadata." },
                merge: { type: "boolean", description: "Merge nearby non-deletion hunks; default true." },
            },
        },
        handler: (args) => changes(args, getSession),
    }];
}
