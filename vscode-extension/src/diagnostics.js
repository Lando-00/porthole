// The diagnostics bridge.
//
// Two directions, one API:
//
//   write - every porthole annotation is also published as a real VS Code
//           Diagnostic, so it appears in the Problems panel, is navigable with
//           F8, and can be filtered and sorted like any other finding. The
//           gutter decorations stay: they show where you are looking, the
//           Problems panel shows what there is to look at.
//
//   read  - the agent can ask what the language servers and linters are
//           actually reporting, instead of guessing at compile errors from the
//           source alone.
//
// The catch on the read side is that our own entries come back out of
// `getDiagnostics()` too, so they have to be filtered out by `source` or the
// agent reads its own annotations back as if they were findings.

const vscode = require("vscode");

const { diag } = require("./log");

/** Stamped on everything we publish, and filtered out on the way back in. */
const SOURCE = "porthole";

const TO_VSCODE = {
    error: vscode.DiagnosticSeverity.Error,
    warn: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
    note: vscode.DiagnosticSeverity.Hint,
};

const FROM_VSCODE = {
    [vscode.DiagnosticSeverity.Error]: "error",
    [vscode.DiagnosticSeverity.Warning]: "warning",
    [vscode.DiagnosticSeverity.Information]: "info",
    [vscode.DiagnosticSeverity.Hint]: "hint",
};

const DEFAULT_SEVERITIES = ["error", "warning"];
const DEFAULT_LIMIT = 100;
const HARD_LIMIT = 500;
const MAX_MESSAGE = 1000;

/** Sort key: worst first, so truncation drops the least important entries. */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, hint: 3 };

let collections = new Map();

/**
 * Annotations and each loaded tour are separate overlays that can be on screen
 * at the same time, so each gets its own collection. One shared collection
 * would mean starting a tour silently emptied the annotations out of the
 * Problems panel, and loading a second tour emptied the first.
 *
 * Per-tour collections are also what makes the Problems panel useful for a
 * whole review at once: each tour groups under its own title, so the panel
 * shows every thread of a change while only one is being walked.
 *
 * All still carry `source: "porthole"`, so the read side filters them out
 * together.
 */
function collectionFor(layer, label) {
    if (!collections.has(layer)) {
        const name = layer === "annotations" ? SOURCE : `${SOURCE} · ${label || layer}`;
        collections.set(layer, vscode.languages.createDiagnosticCollection(name));
    }
    return collections.get(layer);
}

// --- write ------------------------------------------------------------------

/**
 * Republishes a whole layer.
 *
 * Always a full replace rather than an incremental update: the annotation store
 * is small, and a stale entry left behind in the Problems panel is worse than
 * the cost of rebuilding it.
 */
function publish(layer, entries, label) {
    const collection = collectionFor(layer, label);
    collection.clear();

    const byFile = new Map();
    for (const entry of entries) {
        if (!entry || !entry.file) continue;
        if (!byFile.has(entry.file)) byFile.set(entry.file, []);
        byFile.get(entry.file).push(toDiagnostic(entry));
    }

    for (const [file, diagnostics] of byFile) {
        try {
            collection.set(vscode.Uri.file(file), diagnostics);
        } catch (err) {
            diag(`diagnostics publish failed for ${file}: ${err.message}`);
        }
    }
}

function toDiagnostic(entry) {
    // Diagnostics do not need an open document, so the range is built straight
    // from the stored line numbers rather than clamped against one. Annotations
    // are 1-based; the API is 0-based.
    const startLine = Math.max(0, (entry.startLine || 1) - 1);
    const endLine = Math.max(startLine, (entry.endLine || entry.startLine || 1) - 1);
    const startCol = Math.max(0, (entry.startCol || 1) - 1);
    const endCol = entry.endCol === null || entry.endCol === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, entry.endCol - 1);

    const range = new vscode.Range(startLine, startCol, endLine, endCol);
    const message = firstLine(entry.message) || entry.stepTitle || "porthole annotation";

    const diagnostic = new vscode.Diagnostic(
        range,
        message,
        TO_VSCODE[entry.severity] ?? vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = SOURCE;
    if (entry.stepTitle) diagnostic.code = entry.stepTitle;
    return diagnostic;
}

/**
 * The Problems panel shows one line per entry, so a long markdown explanation
 * is unreadable there. The full text stays on the decoration hover.
 */
function firstLine(message) {
    const text = String(message || "").trim();
    if (!text) return "";
    const line = text.split(/\r?\n/)[0].replace(/[*_`]/g, "");
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function clear(layer) {
    const collection = collections.get(layer);
    if (collection) collection.clear();
}

/**
 * Throws a layer away entirely.
 *
 * `clear` empties a collection but keeps it, which is right for a layer that
 * will be republished. A deleted tour never comes back, and a collection per
 * deleted tour is a leak that grows for as long as the window is open.
 */
function dispose(layer) {
    const collection = collections.get(layer);
    if (!collection) return false;
    collection.dispose();
    collections.delete(layer);
    return true;
}

/** Every layer currently held, for the doctor and for tests. */
function layers() {
    return [...collections.keys()];
}

// --- read -------------------------------------------------------------------

/**
 * What the language servers and linters are currently reporting.
 *
 * Shaped by docs/PROTOCOL.md: severity-ordered, capped, and explicit about
 * having truncated, so a broken build cannot return a payload the size of the
 * repository.
 */
function read(payload = {}) {
    const scope = ["open", "workspace", "file"].includes(payload.scope) ? payload.scope : "open";
    const wanted = new Set(
        Array.isArray(payload.severities) && payload.severities.length
            ? payload.severities.filter((s) => s in SEVERITY_RANK)
            : DEFAULT_SEVERITIES,
    );
    if (wanted.size === 0) for (const s of DEFAULT_SEVERITIES) wanted.add(s);

    const limit = Math.min(
        HARD_LIMIT,
        Math.max(1, Number.parseInt(payload.limit, 10) || DEFAULT_LIMIT),
    );

    let sources;
    try {
        sources = collect(scope, payload.file);
    } catch (err) {
        return { ok: false, error: err.message };
    }

    const flat = [];
    let ownEntries = 0;
    for (const [uri, diagnostics] of sources) {
        for (const d of diagnostics) {
            // Our own annotations are not findings. Without this the agent
            // reads its own explanation back as if the compiler had said it.
            if (d.source === SOURCE) {
                ownEntries += 1;
                continue;
            }
            const severity = FROM_VSCODE[d.severity] || "info";
            if (!wanted.has(severity)) continue;
            flat.push({ file: uri.fsPath, severity, diagnostic: d });
        }
    }

    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const item of flat) counts[item.severity] += 1;

    flat.sort(
        (a, b) =>
            SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
            a.file.localeCompare(b.file) ||
            a.diagnostic.range.start.line - b.diagnostic.range.start.line,
    );

    const truncated = flat.length > limit;
    const kept = flat.slice(0, limit);

    const files = [];
    const index = new Map();
    for (const item of kept) {
        if (!index.has(item.file)) {
            const bucket = { file: item.file, diagnostics: [] };
            index.set(item.file, bucket);
            files.push(bucket);
        }
        index.get(item.file).diagnostics.push(describe(item.diagnostic, item.severity));
    }

    diag(`diagnostics read scope=${scope} kept=${kept.length}/${flat.length}`);

    return {
        ok: true,
        result: {
            files,
            counts,
            truncated,
            scanned: sources.length,
            // porthole's own annotations, excluded from `files` above. Reported
            // so a caller can tell "no problems" apart from "no diagnostics at
            // all", and so the agent knows how many annotations are on screen.
            annotations: ownEntries,
        },
    };
}

/** The (uri, diagnostics) pairs in scope. */
function collect(scope, file) {
    if (scope === "file") {
        if (!file) throw new Error("scope 'file' needs a 'file'");
        const uri = vscode.Uri.file(file);
        return [[uri, vscode.languages.getDiagnostics(uri)]];
    }

    const all = vscode.languages.getDiagnostics();
    if (scope === "workspace") return all;

    // "open" is the useful default: the language server has definitely looked
    // at what is on screen, whereas a cold workspace may not have been indexed
    // at all - the same lazy-loading that bites symbol resolution.
    const visible = new Set(
        vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()),
    );
    return all.filter(([uri]) => visible.has(uri.toString()));
}

function describe(d, severity) {
    const out = {
        severity,
        startLine: d.range.start.line + 1,
        endLine: d.range.end.line + 1,
        startCol: d.range.start.character + 1,
        message: String(d.message || "").slice(0, MAX_MESSAGE),
    };
    if (d.source) out.source = d.source;
    if (d.code !== undefined && d.code !== null) {
        out.code = typeof d.code === "object" ? String(d.code.value) : String(d.code);
    }
    return out;
}

// --- lifecycle --------------------------------------------------------------

function activate(context) {
    context.subscriptions.push({
        dispose() {
            for (const collection of collections.values()) collection.dispose();
            collections = new Map();
        },
    });
}

module.exports = { activate, publish, clear, dispose, layers, read, SOURCE };
