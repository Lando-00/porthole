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

test("one legacy companion remains a compatibility fallback", () => {
    const selected = chooseCompanion(
        [{ pid: 42, appName: "VS Code", workspaceFolders: ["C:\\repo"] }],
        { contextPath: "C:\\repo", sessionPath: PATH_B },
    );
    assert.equal(selected.companion.pid, 42);
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
