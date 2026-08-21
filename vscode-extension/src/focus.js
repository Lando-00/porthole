async function focus(vscode) {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");

    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await vscode.window.showTextDocument(editor.document, {
            viewColumn: editor.viewColumn,
            preserveFocus: false,
        });
    }

    const focused = Boolean(vscode.window.state?.focused);
    if (!focused) {
        void vscode.window.showInformationMessage("porthole: this is the requested session window.");
    }

    return {
        ok: true,
        focused,
        attentionRequested: !focused,
    };
}

module.exports = { focus };
