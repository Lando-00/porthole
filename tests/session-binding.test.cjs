const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSessionBinding } = require("../vscode-extension/src/binding");

function fixture(answer = "Clear binding") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-binding-test-"));
    const session = {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        dir: path.join(root, "session-state", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    };
    const tour = path.join(session.dir, "porthole", "tours", "auth-path.json");
    const review = path.join(session.dir, "porthole", "reviews", "auth-review.json");
    fs.mkdirSync(path.dirname(tour), { recursive: true });
    fs.mkdirSync(path.dirname(review), { recursive: true });
    fs.writeFileSync(tour, '{"tourId":"auth-path"}', "utf8");
    fs.writeFileSync(review, '{"slug":"auth-review"}', "utf8");

    const folders = [
        { uri: { fsPath: "C:\\repo" } },
        { uri: { fsPath: session.dir } },
    ];
    const presentation = { warnings: [], information: [] };
    const vscode = {
        workspace: {
            workspaceFolders: folders,
            updateWorkspaceFolders(start, remove) {
                folders.splice(start, remove);
                this.workspaceFolders = folders;
                return true;
            },
        },
        window: {
            async showWarningMessage(message, options, ...actions) {
                presentation.warnings.push({ message, options, actions });
                return answer;
            },
            showInformationMessage(message) {
                presentation.information.push(message);
            },
        },
    };

    return {
        root,
        session,
        tour,
        review,
        folders,
        presentation,
        controller: createSessionBinding({
            vscode,
            findWorkspaceSession: () => session,
            sessionLabel: () => "Checkout race",
        }),
    };
}

test("the user can clear this window's Session Binding without deleting artifacts", async () => {
    const setup = fixture();
    try {
        const result = await setup.controller.clear();

        assert.deepEqual(result, {
            ok: true,
            cleared: true,
            sessionId: setup.session.id,
        });
        assert.deepEqual(setup.presentation.warnings, [
            {
                message: 'Clear the Session Binding for "Checkout race"?',
                options: {
                    modal: true,
                    detail:
                        "This releases this VS Code window. The session's Tours and Saved Reviews remain on disk.",
                },
                actions: ["Clear binding"],
            },
        ]);
        assert.deepEqual(setup.folders.map((folder) => folder.uri.fsPath), ["C:\\repo"]);
        assert.equal(fs.existsSync(setup.tour), true);
        assert.equal(fs.existsSync(setup.review), true);
        assert.match(setup.presentation.information[0], /window is now unbound/);
    } finally {
        fs.rmSync(setup.root, { recursive: true, force: true });
    }
});

test("cancelling Clear Session Binding leaves the window and artifacts unchanged", async () => {
    const setup = fixture(null);
    try {
        const before = setup.folders.map((folder) => folder.uri.fsPath);
        const result = await setup.controller.clear();

        assert.deepEqual(result, {
            ok: true,
            cleared: false,
            cancelled: true,
            sessionId: setup.session.id,
        });
        assert.deepEqual(
            setup.folders.map((folder) => folder.uri.fsPath),
            before,
        );
        assert.equal(fs.existsSync(setup.tour), true);
        assert.equal(fs.existsSync(setup.review), true);
        assert.deepEqual(setup.presentation.information, []);
    } finally {
        fs.rmSync(setup.root, { recursive: true, force: true });
    }
});

test("clearing an Unbound Window is an acknowledged no-op", async () => {
    const information = [];
    const controller = createSessionBinding({
        vscode: {
            workspace: { workspaceFolders: [] },
            window: {
                showInformationMessage: (message) => information.push(message),
            },
        },
        findWorkspaceSession: () => null,
        sessionLabel: () => "unused",
    });

    assert.deepEqual(await controller.clear(), {
        ok: true,
        cleared: false,
        reason: "unbound",
    });
    assert.match(information[0], /already unbound/);
});
