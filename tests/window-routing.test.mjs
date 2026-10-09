import assert from "node:assert/strict";
import test from "node:test";

import { chooseCompanion } from "../extensions/porthole/lib/companion.mjs";
import {
    chooseWindowAction,
    workspaceLaunchArgs,
} from "../extensions/porthole/lib/opensession.mjs";

const SESSION_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PATH_A = `C:\\Users\\test\\.copilot\\session-state\\${SESSION_A}`;
const PATH_B = `C:\\Users\\test\\.copilot\\session-state\\${SESSION_B}`;

function companion(windowId, sessionId, sessionFolder, repo = "C:\\repo") {
    return {
        windowId,
        pid: Number.parseInt(windowId.slice(0, 4), 16) || 1,
        appName: "Visual Studio Code - Insiders",
        sessionId,
        sessionFolder,
        workspaceFolders: [repo, sessionFolder].filter(Boolean),
    };
}

test("auto opens a new window when only another session is open", () => {
    const result = chooseWindowAction({
        mode: "auto",
        sessionId: SESSION_B,
        sessionFolder: PATH_B,
        companions: [companion("1111111111111111", SESSION_A, PATH_A)],
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "new-workspace");
});

test("auto reuses the exact current-session window", () => {
    const result = chooseWindowAction({
        mode: "auto",
        sessionId: SESSION_A,
        sessionFolder: PATH_A,
        companions: [
            companion("1111111111111111", SESSION_A, PATH_A),
            companion("2222222222222222", SESSION_B, PATH_B),
        ],
    });
    assert.equal(result.action, "existing-window");
    assert.equal(result.companion.windowId, "1111111111111111");
});

test("ambiguous reuse refuses without changing a window", () => {
    const result = chooseWindowAction({
        mode: "reuse",
        sessionId: SESSION_B,
        sessionFolder: PATH_B,
        companions: [
            companion("1111111111111111", SESSION_A, PATH_A),
            companion("2222222222222222", null, null, "C:\\other"),
        ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, "refuse");
    assert.equal(result.candidates.length, 2);
});

test("explicit reuse targets only the selected window id", () => {
    const result = chooseWindowAction({
        mode: "reuse",
        windowId: "2222222222222222",
        sessionId: SESSION_B,
        sessionFolder: PATH_B,
        companions: [
            companion("1111111111111111", SESSION_A, PATH_A),
            companion("2222222222222222", SESSION_B, PATH_B),
        ],
    });
    assert.equal(result.action, "reuse-window");
    assert.equal(result.companion.windowId, "2222222222222222");
});

test("reuse refuses a window bound to another Copilot session", () => {
    const result = chooseWindowAction({
        mode: "reuse",
        windowId: "1111111111111111",
        sessionId: SESSION_B,
        sessionFolder: PATH_B,
        companions: [companion("1111111111111111", SESSION_A, PATH_A)],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /mix two sessions/);
});

test("new workspace launches always carry the hard new-window flag", () => {
    assert.deepEqual(workspaceLaunchArgs("C:\\x.code-workspace"), [
        "--new-window",
        "C:\\x.code-workspace",
    ]);
    assert.deepEqual(workspaceLaunchArgs("C:\\x.code-workspace", "C:\\plan.md"), [
        "--new-window",
        "C:\\x.code-workspace",
        "--goto",
        "C:\\plan.md:1",
    ]);
});

test("same-repository companions route by exact session", () => {
    const selected = chooseCompanion(
        [
            companion("1111111111111111", SESSION_A, PATH_A),
            companion("2222222222222222", SESSION_B, PATH_B),
        ],
        { contextPath: "C:\\repo", sessionPath: PATH_B },
    );
    assert.equal(selected.companion.windowId, "2222222222222222");
});

test("a different modern session is never a project fallback", () => {
    const selected = chooseCompanion(
        [companion("1111111111111111", SESSION_A, PATH_A)],
        { contextPath: "C:\\repo", sessionPath: PATH_B },
    );
    assert.equal(selected.companion, null);
    assert.equal(selected.reason, "session-missing");
});

test("a parent session-state folder is not an exact session match", () => {
    const selected = chooseCompanion(
        [
            {
                windowId: "1111111111111111",
                pid: 42,
                appName: "VS Code",
                workspaceFolders: ["C:\\Users\\test\\.copilot\\session-state"],
            },
        ],
        { sessionPath: PATH_B },
    );
    assert.equal(selected.companion, null);
    assert.equal(selected.reason, "session-missing");
});

test("a legacy companion without session evidence is not a project fallback", () => {
    const selected = chooseCompanion(
        [{ pid: 42, appName: "VS Code", workspaceFolders: ["C:\\repo"] }],
        { contextPath: "C:\\repo", sessionPath: PATH_B },
    );
    assert.equal(selected.companion, null);
    assert.equal(selected.reason, "session-missing");
});

test("an explicit window id cannot bypass session ownership", () => {
    const selected = chooseCompanion(
        [companion("1111111111111111", SESSION_A, PATH_A)],
        { windowId: "1111111111111111", sessionId: SESSION_B, sessionPath: PATH_B },
    );
    assert.equal(selected.companion, null);
});

test("declared foreign binding outranks a matching workspace folder for reuse", () => {
    const foreign = companion("1111111111111111", SESSION_A, PATH_A);
    foreign.workspaceFolders = ["C:\\repo", PATH_B];
    const selected = chooseWindowAction({
        mode: "reuse",
        windowId: foreign.windowId,
        sessionId: SESSION_B,
        sessionFolder: PATH_B,
        companions: [foreign],
    });
    assert.equal(selected.ok, false);
    assert.equal(selected.action, "refuse");
});

test("deliberate reuse of a genuinely unbound window remains available", () => {
    const selected = chooseWindowAction({
        mode: "reuse",
        windowId: "1111111111111111",
        sessionId: SESSION_B,
        sessionFolder: PATH_B,
        companions: [companion("1111111111111111", null, null)],
    });
    assert.equal(selected.ok, true);
    assert.equal(selected.action, "reuse-window");
});

test("an explicit reuse target is never silently ignored by another open mode", () => {
    for (const mode of ["auto", "new"]) {
        const selected = chooseWindowAction({
            mode,
            windowId: "1111111111111111",
            sessionId: SESSION_A,
            sessionFolder: PATH_A,
            companions: [companion("1111111111111111", SESSION_A, PATH_A)],
        });
        assert.equal(selected.ok, false);
        assert.match(selected.error, /windowId requires mode 'reuse'/);
    }
});

test("multiple legacy companions are refused", () => {
    const selected = chooseCompanion(
        [
            { pid: 42, appName: "VS Code", workspaceFolders: ["C:\\repo"] },
            { pid: 43, appName: "VS Code", workspaceFolders: ["C:\\repo"] },
        ],
        { contextPath: "C:\\repo", sessionPath: PATH_B },
    );
    assert.equal(selected.companion, null);
    assert.equal(selected.reason, "session-missing");
});

function agedCompanion(windowId, sessionId, sessionFolder, startedAt) {
    return { ...companion(windowId, sessionId, sessionFolder), startedAt };
}

test("a session may own several windows, and the oldest answers", () => {
    // Ownership is which session folder is open in a window, and a session is
    // allowed to hold more than one - usually because it deliberately asked for
    // a second. This used to refuse /cops outright.
    const result = chooseWindowAction({
        mode: "auto",
        sessionId: SESSION_A,
        sessionFolder: PATH_A,
        companions: [
            agedCompanion("2222222222222222", SESSION_A, PATH_A, "2026-01-01T10:05:00.000Z"),
            agedCompanion("1111111111111111", SESSION_A, PATH_A, "2026-01-01T10:00:00.000Z"),
        ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "existing-window");
    assert.equal(result.companion.windowId, "1111111111111111", "the first window is the primary");
});

test("closing the primary promotes the window that remains", () => {
    const result = chooseWindowAction({
        mode: "auto",
        sessionId: SESSION_A,
        sessionFolder: PATH_A,
        companions: [
            agedCompanion("2222222222222222", SESSION_A, PATH_A, "2026-01-01T10:05:00.000Z"),
        ],
    });
    assert.equal(result.action, "existing-window");
    assert.equal(result.companion.windowId, "2222222222222222");
});

test("forcing a new window is allowed even when the session already owns one", () => {
    const result = chooseWindowAction({
        mode: "new",
        sessionId: SESSION_A,
        sessionFolder: PATH_A,
        companions: [agedCompanion("1111111111111111", SESSION_A, PATH_A, "2026-01-01T10:00:00.000Z")],
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "new-workspace", "a forced window joins as a secondary, not a conflict");
});

test("a window owned by another session is still refused", () => {
    const result = chooseWindowAction({
        mode: "reuse",
        windowId: "2222222222222222",
        sessionId: SESSION_A,
        sessionFolder: PATH_A,
        companions: [agedCompanion("2222222222222222", SESSION_B, PATH_B, "2026-01-01T10:00:00.000Z")],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already bound to Copilot session/);
});

test("the selector returns the primary and the full owned set", () => {
    const owned = chooseCompanion(
        [
            agedCompanion("2222222222222222", SESSION_A, PATH_A, "2026-01-01T10:05:00.000Z"),
            agedCompanion("1111111111111111", SESSION_A, PATH_A, "2026-01-01T10:00:00.000Z"),
            agedCompanion("3333333333333333", SESSION_B, PATH_B, "2026-01-01T09:00:00.000Z"),
        ],
        { sessionId: SESSION_A, sessionPath: PATH_A },
    );
    assert.equal(owned.reason, null);
    assert.equal(owned.companion.windowId, "1111111111111111");
    assert.deepEqual(
        owned.owned.map((c) => c.windowId),
        ["1111111111111111", "2222222222222222"],
        "the other session's window is never part of the owned set",
    );
});

test("a vanished explicit target stays unknown-window even when every window closed", () => {
    const windowId = "1234567890abcdef";
    const result = chooseCompanion([], { sessionId: SESSION_A, sessionPath: PATH_A, windowId });
    assert.equal(result.companion, null);
    assert.equal(result.reason, "unknown-window");
    assert.equal(result.windowId, windowId);
});
