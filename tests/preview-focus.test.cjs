const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const focus = require("../vscode-extension/src/focus");
const preview = require("../vscode-extension/src/preview");

test("preview accepts complete content only inside a workspace folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-preview-"));
    try {
        const changes = preview.validate(
            { changes: [{ file: path.join(root, "src", "a.js"), content: "export const a = 1;\n" }] },
            [{ uri: { fsPath: root } }],
        );
        assert.equal(changes.length, 1);
        assert.equal(changes[0].file, path.join(root, "src", "a.js"));

        assert.throws(
            () =>
                preview.validate(
                    {
                        changes: [
                            { file: path.join(path.dirname(root), "outside.js"), content: "no\n" },
                        ],
                    },
                    [{ uri: { fsPath: root } }],
                ),
            /outside this window's workspace/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("preview stale check detects a file changed during review", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-preview-"));
    const file = path.join(root, "a.js");
    try {
        fs.writeFileSync(file, "before\n");
        const entry = { file, existed: true, beforeHash: preview.hash(Buffer.from("before\n")) };
        assert.equal(preview.unchanged(entry), true);
        fs.writeFileSync(file, "changed elsewhere\n");
        assert.equal(preview.unchanged(entry), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("approved preview applies the edited proposal through one workspace edit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "porthole-preview-"));
    const file = path.join(root, "a.js");
    const proposedFile = path.join(root, "PROPOSED-a.js");
    fs.writeFileSync(file, "before\n");
    fs.writeFileSync(proposedFile, "reviewed\n");

    class WorkspaceEdit {
        constructor() {
            this.operations = [];
        }
        replace(uri, range, content) {
            this.operations.push({ kind: "replace", uri, range, content });
        }
        createFile(uri) {
            this.operations.push({ kind: "create", uri });
        }
        insert(uri, position, content) {
            this.operations.push({ kind: "insert", uri, position, content });
        }
    }

    const vscode = {
        Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
        Position: class Position {
            constructor(line, character) {
                this.line = line;
                this.character = character;
            }
        },
        Range: class Range {
            constructor(start, end) {
                this.start = start;
                this.end = end;
            }
        },
        WorkspaceEdit,
        workspace: {
            textDocuments: [],
            fs: { async createDirectory() {} },
            async openTextDocument(uri) {
                const content = fs.readFileSync(uri.fsPath, "utf8");
                return {
                    uri,
                    isDirty: uri.fsPath === proposedFile,
                    getText: () => content,
                    positionAt: (offset) => ({ line: 0, character: offset }),
                    async save() {
                        return true;
                    },
                };
            },
            async applyEdit(edit) {
                for (const operation of edit.operations) {
                    if (operation.kind === "replace") {
                        fs.writeFileSync(operation.uri.fsPath, operation.content);
                    }
                }
                return true;
            },
        },
    };

    try {
        const result = await preview.apply(vscode, [
            {
                file,
                proposedFile,
                existed: true,
                beforeHash: preview.hash(Buffer.from("before\n")),
            },
        ]);
        assert.equal(result.ok, true);
        assert.equal(result.applied, true);
        assert.equal(fs.readFileSync(file, "utf8"), "reviewed\n");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("focus acts only inside the addressed companion and requests attention when backgrounded", async () => {
    const calls = [];
    const document = { uri: { fsPath: "C:\\repo\\a.js" } };
    const vscode = {
        commands: {
            async executeCommand(command) {
                calls.push(command);
            },
        },
        window: {
            state: { focused: false },
            activeTextEditor: { document, viewColumn: 2 },
            async showTextDocument(received, options) {
                assert.equal(received, document);
                assert.deepEqual(options, { viewColumn: 2, preserveFocus: false });
            },
            showInformationMessage(message) {
                calls.push(message);
            },
        },
    };

    const result = await focus.focus(vscode);
    assert.deepEqual(result, { ok: true, focused: false, attentionRequested: true });
    assert.equal(calls[0], "workbench.action.focusActiveEditorGroup");
    assert.match(calls[1], /requested session window/);
});
