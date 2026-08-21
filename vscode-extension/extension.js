// porthole companion
//
// Gives the porthole Copilot CLI plugin the things the VS Code CLI cannot do:
// select a range, leave annotations on code, resolve a symbol, and answer
// "are you there?".
//
// Requests arrive either as a URI (including the manual/legacy form) or as an
// addressed JSON file in this window's inbox:
//
//   vscode-insiders://lando-00.porthole-companion/<route>?req=<requestId>
//   vscode-insiders://lando-00.porthole-companion/reveal?file=<abs>&start=10&end=20
//   ~/.copilot/porthole/inbox/<windowId>/<requestId>.json
//
// Both transports write the same ack shape - see src/transport.js and
// src/inbox.js for their contracts.
//
// Plain JavaScript against the stable VS Code API: no build step, no runtime
// dependencies.

const vscode = require("vscode");

const log = require("./src/log");
const transport = require("./src/transport");
const presence = require("./src/presence");
const inbox = require("./src/inbox");
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
const workspace = require("./src/workspace");
const identity = require("./src/identity");
const focus = require("./src/focus");
const preview = require("./src/preview");
const { createDispatcher } = require("./src/dispatcher");
const capabilities = require("./src/capabilities");
const { createSessionBinding } = require("./src/binding");
const sessionState = require("./src/session");

const VERSION = require("./package.json").version;
const sessionBinding = createSessionBinding({
    vscode,
    findWorkspaceSession: sessionState.findWorkspaceSession,
    sessionLabel: identity.sessionLabel,
});

/** Every route this build answers, so an unknown one is reported as such. */
const KNOWN = new Set(capabilities.ROUTES);
const PRESENCE_CONTRACT = capabilities.presenceContract(capabilities.ROUTES);

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
    "focus",
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
            return { ok: true, ...presence.describe(vscode, VERSION, PRESENCE_CONTRACT) };

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

        case "tour-discover":
            return tourstore.discover(payload);

        case "tour-import":
            return tourstore.importTour(payload);

        case "tour-archive":
            return tourstore.setArchived(payload);

        case "tour-legacy-cleanup":
            return tourstore.cleanupLegacy(payload);

        case "review-save":
            return reviews.save(payload);

        case "review-list":
            return reviews.list(payload);

        case "review-load":
            return reviews.load(payload);

        case "workspace-add":
            return workspace.add(vscode, payload);

        case "focus":
            return focus.focus(vscode);

        case "preview":
            return preview.preview(vscode, payload);

        default:
            if (PLANNED.has(route)) {
                return { ok: false, error: `route '${route}' is not implemented yet` };
            }
            return { ok: false, error: `unknown route '${route}'` };
    }
}

/**
 * URI and exact-window inbox transports enter the same dispatcher. The
 * dispatcher owns route validation, error normalization and acknowledgement;
 * this adapter adds the production presence and presentation effects.
 */
const executeRequest = createDispatcher({
    knownRoutes: KNOWN,
    optionalPayloadRoutes: PAYLOAD_OPTIONAL,
    dispatch,
    writeAck: transport.writeAck,
    diag: log.diag,
    warn: (error) => vscode.window.showWarningMessage(`porthole: ${error}`),
    onHandled: () => {
        // A working reply keeps this window's presence current. Readers sort
        // newest-first, so a live host outranks stale records.
        presence.write(vscode, VERSION, PRESENCE_CONTRACT);
        identity.refresh();
    },
});

async function handleUri(uri) {
    const route = (uri.path || "").replace(/^\/+/, "").toLowerCase();
    const query = transport.parseQuery(uri.query);
    const requestId = query.req || null;

    // Payload-file routes carry only `req`; legacy /reveal carries its
    // parameters inline. Falling back to the query keeps both working.
    const payload = requestId ? transport.readPayload(requestId) : query;
    return executeRequest(route, payload, requestId, "uri");
}

function handleInboxRequest(request) {
    return executeRequest(request.route, request.payload, request.requestId, "inbox");
}

function activate(context) {
    log.refreshFromSettings(vscode);
    log.diag(`activate pid=${process.pid} v${VERSION} scheme=${vscode.env.uriScheme}`);

    transport.ensureDirs();
    transport.sweep();

    const windowId = presence.start(vscode, context, VERSION, PRESENCE_CONTRACT);
    // Before annotations: publishing an annotation needs the collection to
    // exist already.
    diagnostics.activate(context);
    annotations.activate(context);
    tour.activate(context);
    tourstore.activate(context);
    reviews.activate(context);
    send.activate(context);
    views.activate(context);
    identity.activate(context);
    context_.activate(context);
    onboarding.activate(context);

    // Wired here rather than inside diagnostics.js, which must not depend on
    // the two modules that feed it.
    diagnostics.onRepublish(() => {
        annotations.republish();
        tour.republishAll();
    });

    // The inbox is the addressed path used by new CLI callers. Start it only
    // after route modules are ready; its initial scan handles requests written
    // while the extension host was activating.
    context.subscriptions.push(inbox.start(windowId, handleInboxRequest));

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("porthole.diagnostics")) log.refreshFromSettings(vscode);
        }),
    );

    context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));

    context.subscriptions.push(
        vscode.commands.registerCommand("porthole.clearHighlight", reveal.clearHighlight),
        vscode.commands.registerCommand(
            "porthole.clearSessionBinding",
            sessionBinding.clear,
        ),
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
    inbox.stop();
    presence.remove();
    reveal.dispose();
}

module.exports = {
    activate,
    deactivate,
    dispatch,
    executeRequest,
    handleUri,
    KNOWN,
    PAYLOAD_OPTIONAL,
};
