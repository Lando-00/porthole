// Symbol resolution.
//
// "/goto handleGoto" should land on the whole function, not on a line someone
// guessed. Only the editor knows that: the language servers live here, so the
// CLI hands us a name and we do the resolving.
//
// Two provider calls are needed. The workspace symbol provider finds candidates
// but reports a narrow location; the document symbol provider gives the full
// range including the body, which is what makes the result worth selecting.

const vscode = require("vscode");
const fs = require("node:fs");

const { diag } = require("./log");

const PROVIDER_TIMEOUT_MS = 3000;

/** Directories never worth scanning in the text fallback. */
const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "out",
    "build",
    ".next",
    "vendor",
    "target",
    "__pycache__",
]);

const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_SCAN_FILES = 4000;

/** A cold language server must never hang the ack. */
function withTimeout(promise, ms, fallback) {
    return Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}

/**
 * Scores a candidate against the query. Lower is better; null means "no match".
 *
 * The ordering is deliberate: an exact name beats a case-insensitive match,
 * which beats a prefix, which beats a substring. Ties go to the shortest path,
 * so `src/foo.ts` wins over `dist/vendor/deep/foo.ts`.
 */
function score(symbol, query) {
    const name = bareName(symbol.name);
    if (name === query) return 0;
    if (name.toLowerCase() === query.toLowerCase()) return 1;
    if (name.toLowerCase().startsWith(query.toLowerCase())) return 2;
    if (name.toLowerCase().includes(query.toLowerCase())) return 3;
    return null;
}

function kindName(kind) {
    for (const [name, value] of Object.entries(vscode.SymbolKind)) {
        if (value === kind && Number.isInteger(value)) return name.toLowerCase();
    }
    return "symbol";
}

function relativePath(uri) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    return rel || uri.fsPath;
}

/**
 * Finds the symbol whose range covers `position`.
 *
 * Collects every containing node, then prefers one whose name matches the
 * query - so `handleGoto` selects the function, not the module block that also
 * contains it - and otherwise takes the innermost.
 */
function fullRangeAt(symbols, position, name) {
    const containing = [];

    const visit = (nodes) => {
        for (const node of nodes || []) {
            if (!node.range.contains(position)) continue;
            containing.push(node);
            visit(node.children);
        }
    };
    visit(symbols);

    if (containing.length === 0) return null;

    const named = containing.filter((n) => namesMatch(n.name, name));
    const pool = named.length > 0 ? named : containing;

    return pool.reduce((smallest, node) =>
        node.range.end.line - node.range.start.line <
        smallest.range.end.line - smallest.range.start.line
            ? node
            : smallest,
    );
}

async function resolveSymbol(payload) {
    const query = String(payload.query || "").trim();
    if (!query) return { ok: false, error: "missing the 'query' parameter" };

    const viaProvider = await fromWorkspaceSymbols(query, payload);
    if (viaProvider) return viaProvider;

    // The TypeScript server loads projects lazily, so a workspace symbol search
    // in a window where nothing has been opened yet legitimately returns
    // nothing. Falling back to a definition scan means the route works from a
    // cold window instead of only after the user has browsed around.
    return fromTextScan(query, payload);
}

/** Providers report function names as "name()", so compare on the bare name. */
function bareName(value) {
    return String(value || "").replace(/\(.*\)$/, "").trim();
}

function namesMatch(a, b) {
    return bareName(a) === bareName(b);
}

async function fromWorkspaceSymbols(query, payload) {
    const raw = await withTimeout(
        vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query),
        PROVIDER_TIMEOUT_MS,
        null,
    );

    if (!raw || raw.length === 0) return null;

    const scored = [];
    for (const symbol of raw) {
        const s = score(symbol, query);
        if (s === null) continue;
        if (payload.file && !symbol.location.uri.fsPath.endsWith(payload.file)) continue;
        if (payload.preferKind && kindName(symbol.kind) !== String(payload.preferKind).toLowerCase()) {
            continue;
        }
        scored.push({ symbol, score: s, path: relativePath(symbol.location.uri) });
    }

    if (scored.length === 0) return null;

    scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);

    const best = scored[0];
    const rivals = scored.filter(
        (c) =>
            c.score === best.score &&
            c.symbol.location.uri.fsPath !== best.symbol.location.uri.fsPath,
    );

    // Two equally good matches in different files is a question, not an answer;
    // jumping to an arbitrary one is worse than saying so.
    if (rivals.length > 0 && best.score > 0) {
        return {
            ok: false,
            error: `'${query}' is ambiguous`,
            candidates: scored.slice(0, 10).map(describe),
        };
    }

    const range = await expand(best.symbol.location.uri, best.symbol.location.range, best.symbol.name);

    return {
        ok: true,
        file: best.symbol.location.uri.fsPath,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        name: bareName(best.symbol.name),
        kind: kindName(best.symbol.kind),
        source: "language-server",
        container: best.symbol.containerName || undefined,
        candidates: scored.length > 1 ? scored.slice(1, 6).map(describe) : undefined,
    };
}

/** Definition forms, most specific first, across the languages in play here. */
function definitionPatterns(name) {
    const n = escapeRegExp(name);
    return [
        new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+\\*?${n}\\b`),
        new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`),
        new RegExp(`\\b(?:export\\s+)?(?:interface|enum|type|struct|trait)\\s+${n}\\b`),
        new RegExp(`\\b(?:def|func|fn|sub)\\s+${n}\\b`),
        new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*[:=]`),
        new RegExp(`^\\s*${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|<)`),
        new RegExp(`^\\s*(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`),
    ];
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fromTextScan(query, payload) {
    const hits = [];

    for (const folder of vscode.workspace.workspaceFolders || []) {
        scanDir(folder.uri.fsPath, query, hits, { count: 0 });
    }

    const filtered = payload.file ? hits.filter((h) => h.file.endsWith(payload.file)) : hits;

    if (filtered.length === 0) {
        return { ok: false, error: `no symbol matching '${query}'`, candidates: [] };
    }

    filtered.sort((a, b) => a.rank - b.rank || a.file.length - b.file.length);

    const best = filtered[0];
    const rivals = filtered.filter((h) => h.rank === best.rank && h.file !== best.file);
    if (rivals.length > 0) {
        return {
            ok: false,
            error: `'${query}' is ambiguous`,
            candidates: filtered.slice(0, 10).map((h) => ({
                name: query,
                kind: "definition",
                file: h.file,
                startLine: h.line,
            })),
        };
    }

    const uri = vscode.Uri.file(best.file);
    const position = new vscode.Position(best.line - 1, 0);
    // Opening the document is what wakes the language service for its project,
    // so the document symbol provider usually answers even when the workspace
    // one did not.
    const range = await expand(uri, new vscode.Range(position, position), query);

    return {
        ok: true,
        file: best.file,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        name: query,
        kind: "definition",
        source: "text-scan",
        candidates: filtered.length > 1
            ? filtered.slice(1, 6).map((h) => ({
                  name: query,
                  kind: "definition",
                  file: h.file,
                  startLine: h.line,
              }))
            : undefined,
    };
}

function scanDir(dir, query, hits, budget) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (budget.count >= MAX_SCAN_FILES) return;
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;

        const full = `${dir}${process.platform === "win32" ? "\\" : "/"}${entry.name}`;

        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            scanDir(full, query, hits, budget);
            continue;
        }
        if (!entry.isFile()) continue;

        let stat;
        try {
            stat = fs.statSync(full);
        } catch {
            continue;
        }
        if (stat.size > MAX_SCAN_BYTES) continue;

        budget.count += 1;

        let text;
        try {
            text = fs.readFileSync(full, "utf8");
        } catch {
            continue;
        }
        if (text.includes("\u0000")) continue; // binary
        if (!text.includes(query)) continue;

        const patterns = definitionPatterns(query);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
            for (let p = 0; p < patterns.length; p += 1) {
                if (patterns[p].test(lines[i])) {
                    hits.push({ file: full, line: i + 1, rank: p });
                    break;
                }
            }
        }
    }
}

function describe(candidate) {
    return {
        name: bareName(candidate.symbol.name),
        kind: kindName(candidate.symbol.kind),
        file: candidate.symbol.location.uri.fsPath,
        startLine: candidate.symbol.location.range.start.line + 1,
    };
}

/** Widens a narrow location to the symbol's full body range. */
async function expand(uri, narrow, name) {
    try {
        // Opening the document is what makes a lazy language service load the
        // project it belongs to.
        await vscode.workspace.openTextDocument(uri);
    } catch {
        return narrow;
    }

    let documentSymbols = await documentSymbolsFor(uri);
    if (!documentSymbols) {
        // The project may only just have started loading because of the open
        // above; one retry is the difference between a whole function and a
        // single line.
        await delay(700);
        documentSymbols = await documentSymbolsFor(uri);
    }
    if (!documentSymbols) return narrow;

    // Older providers return SymbolInformation[] (flat, with .location); newer
    // ones return DocumentSymbol[] (a tree, with .range and .children).
    if (documentSymbols[0].location) {
        const match = documentSymbols.find(
            (s) => namesMatch(s.name, name) && s.location.range.contains(narrow.start),
        );
        return match ? match.location.range : narrow;
    }

    const node = fullRangeAt(documentSymbols, narrow.start, name);
    return node ? node.range : narrow;
}

async function documentSymbolsFor(uri) {
    const result = await withTimeout(
        vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri),
        PROVIDER_TIMEOUT_MS,
        null,
    );
    return result && result.length > 0 ? result : null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves a symbol and reveals it.
 *
 * The reveal goes through the annotation path when a message is supplied, so a
 * symbol jump and the explanation of that symbol are a single action.
 */
async function symbol(payload, deps) {
    const result = await resolveSymbol(payload);
    if (!result.ok) return result;

    diag(`symbol '${payload.query}' -> ${result.file}:${result.startLine}-${result.endLine}`);

    if (payload.message) {
        await deps.annotate({
            title: payload.title || `porthole: ${result.name}`,
            clearExisting: payload.clearExisting !== false,
            annotations: [
                {
                    file: result.file,
                    startLine: result.startLine,
                    endLine: result.endLine,
                    severity: payload.severity || "info",
                    message: payload.message,
                },
            ],
        });
    } else {
        const revealed = await deps.reveal({
            file: result.file,
            start: result.startLine,
            end: result.endLine,
        });
        if (!revealed.ok) return revealed;
    }

    return result;
}

module.exports = { symbol, resolveSymbol };
