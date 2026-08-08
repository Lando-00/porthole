// porthole companion
//
// Gives the porthole Copilot CLI plugin the things the VS Code CLI cannot do:
// select a range, leave annotations on code, resolve a symbol, and answer
// "are you there?".
//
// Everything arrives as a URI:
//
//   vscode-insiders://lando-00.porthole-companion/<route>?req=<requestId>
//   vscode-insiders://lando-00.porthole-companion/reveal?file=<abs>&start=10&end=20
//
// Routes taking more than a couple of numbers read their payload from a file
// and write an ack back - see src/transport.js for the contract.
//
// Plain JavaScript against the stable VS Code API: no build step, no runtime
// dependencies.

const vscode = require("vscode");

const log = require("./src/log");
const transport = require("./src/transport");
const presence = require("./src/presence");
const reveal = require("./src/reveal");
const annotations = require("./src/annotations");
const diagnostics = require("./src/diagnostics");
const tour = require("./src/tour");
const tourstore = require("./src/tourstore");
const reviews = require("./src/reviews");
const context_ = require("./src/context");
const onboarding = require("./src/onboarding");
const send = require("./src/send");
const symbols = require("./src/symbols");
const views = require("./src/views");

const VERSION = require("./package.json").version;

/** Every route this build answers, so an unknown one is reported as such. */
const KNOWN = new Set([
    "",
    "reveal",
    "clear",
    "ping",
    "annotate",
    "annotate-clear",
    "symbol",
    "diagnostics",
    "tour",
    "tour-exit",
    "tour-list",
    "tour-activate",
    "tour-delete",
    "review-save",
    "review-list",
    "review-load",
]);

/** Routes that are implemented elsewhere and land later in the plan. */
const PLANNED = new Set();

/** Routes that carry no payload, so a missing payload file is not an error. */
const PAYLOAD_OPTIONAL = new Set([
    "ping",
    "clear",
    "annotate-clear",
    "diagnostics",
    "tour-exit",
    "tour-list",
    "review-save",
    "review-list",
]);

async function dispatch(route, payload) {
    switch (route) {
        case "":
        case "reveal":
            return reveal.reveal(payload);

        case "clear":
            reveal.clearHighlight();
            return { ok: true };

        case "ping":
            return { ok: true, ...presence.describe(vscode, VERSION) };

        case "annotate":
            return annotations.annotate(payload);

        case "annotate-clear":
            return annotations.clear();

        case "symbol":
            return symbols.symbol(payload, {
                annotate: annotations.annotate,
                reveal: reveal.reveal,
            });

        case "diagnostics":
            return diagnostics.read(payload);

        case "tour":
            return tour.upsert(payload);

        case "tour-exit":
            return payload && payload.tourId ? tour.close(payload.tourId) : tour.exit();

        case "tour-list":
            return tourstore.list(payload);

        case "tour-activate":
            return tourstore.activateTour(payload);

        case "tour-delete":
            return tourstore.remove(payload);

        case "review-save":
            return reviews.save(payload);

        case "review-list":
            return reviews.list(payload);

        case "review-load":
            return reviews.load(payload);

        default:
            if (PLANNED.has(route)) {
                return { ok: false, error: `route '${route}' is not implemented yet` };
            }
            return { ok: false, error: `unknown route '${route}'` };
    }
}

async function handleUri(uri) {
    const route = (uri.path || "").replace(/^\/+/, "").toLowerCase();
    const query = transport.parseQuery(uri.query);
    const requestId = query.req || null;

    // Payload-file routes carry only `req`; legacy /reveal carries its
    // parameters inline. Falling back to the query keeps both working.
    const payload = requestId ? transport.readPayload(requestId) : query;

    log.diag(`handleUri route=${route} req=${requestId || "-"} query=${uri.query || ""}`);

    // Route validity first: an unknown route with no payload should say so,
    // rather than blaming the payload.
    if (!KNOWN.has(route)) {
        transport.writeAck(requestId, { ok: false, error: `unknown route '${route}'` });
        if (!requestId) vscode.window.showWarningMessage(`porthole: unknown route '${route}'.`);
        return;
    }

    if (requestId && payload === null && !PAYLOAD_OPTIONAL.has(route)) {
        transport.writeAck(requestId, {
            ok: false,
            error: "payload file was missing or unreadable",
        });
        return;
    }

    let result;
    try {
        result = await dispatch(route, payload || {});
    } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : String(err) };
    }

    log.diag(`route=${route} ok=${result.ok}${result.error ? ` error=${result.error}` : ""}`);
    transport.writeAck(requestId, result);

    // Republish presence on the way out. Not self-healing - a record that fails
    // to answer is never deleted - but it keeps `updatedAt` fresh on a window
    // that is actually in use, and readers sort newest-first. That is what puts
    // a working window ahead of one left over from a previous boot.
    presence.write(vscode, VERSION);

    // Only surface a problem when nobody is waiting on an ack; otherwise the
    // CLI reports it, and a modal-ish toast on top of that is just noise.
    if (!result.ok && !requestId) {
        vscode.window.showWarningMessage(`porthole: ${result.error}`);
    }
}

function activate(context) {
    log.refreshFromSettings(vscode);
    log.diag(`activate pid=${process.pid} v${VERSION} scheme=${vscode.env.uriScheme}`);

    transport.ensureDirs();
    transport.sweep();

    presence.start(vscode, context, VERSION);
    // Before annotations: publishing an annotation needs the collection to
    // exist already.
    diagnostics.activate(context);
    annotations.activate(context);
    tour.activate(context);
    tourstore.activate(context);
    reviews.activate(context);
    send.activate(context);
    views.activate(context);
    context_.activate(context);
    onboarding.activate(context);

    // Wired here rather than inside diagnostics.js, which must not depend on
    // the two modules that feed it.
    diagnostics.onRepublish(() => {
        annotations.republish();
        tour.republishAll();
    });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("porthole.diagnostics")) log.refreshFromSettings(vscode);
        }),
    );

    context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));

    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.clearHighlight", reveal.clearHighlight),
    );

    // Makes the URI format discoverable without reading the source.
    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.showUriExample", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage(
                    "porthole: open a file and select a range first.",
                );
                return;
            }
            const sel = editor.selection;
            const uri =
                `${vscode.env.uriScheme}://lando-00.porthole-companion/reveal` +
                `?file=${encodeURIComponent(editor.document.uri.fsPath)}` +
                `&start=${sel.start.line + 1}&end=${sel.end.line + 1}`;
            await vscode.env.clipboard.writeText(uri);
            vscode.window.showInformationMessage("porthole: reveal URI copied to the clipboard.");
        }),
    );

    context.subscriptions.push({ dispose: reveal.dispose });
}

function deactivate() {
    presence.remove();
    reveal.dispose();
}

module.exports = { activate, deactivate };
