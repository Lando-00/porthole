import assert from "node:assert/strict";
import test from "node:test";

import { classifyOwnership, normalizedSessionPath, sessionIdentity } from "../extensions/porthole/lib/ownership.mjs";
import { companionOptions } from "../extensions/porthole/lib/target.mjs";
import { withDeliveryNotes } from "../extensions/porthole/lib/delivery-notes.mjs";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const folder = (id) => `C:\\Users\\test\\.copilot\\session-state\\${id}`;
const expected = { sessionId: A, sessionPath: folder(A) };
const owned = { sessionId: A, sessionFolder: folder(A), workspaceFolders: ["C:\\repo", folder(A)] };

test("declared binding fields must both agree with the expected session", () => {
    assert.equal(classifyOwnership(owned, expected), "owned");
    assert.equal(classifyOwnership({ ...owned, sessionFolder: folder(B) }, expected), "conflicted");
    assert.equal(classifyOwnership({ ...owned, sessionId: B }, expected), "conflicted");
    assert.equal(classifyOwnership({
        sessionId: A,
        sessionFolder: `D:\\session-state\\${A}`,
    }, expected), "foreign");
});

test("workspace membership never cancels a foreign binding", () => {
    assert.equal(classifyOwnership({
        sessionId: B,
        sessionFolder: folder(B),
        workspaceFolders: ["C:\\repo", folder(A)],
    }, expected), "foreign");
});

test("multiple exact session folders are conflicted even with a matching declaration", () => {
    assert.equal(classifyOwnership({ ...owned, workspaceFolders: [folder(A), folder(B)] }, expected), "conflicted");
});

test("modern absent binding is unbound rather than owned by contextual folders", () => {
    assert.equal(classifyOwnership({
        sessionId: null,
        sessionFolder: null,
        workspaceFolders: [folder(A)],
    }, expected), "unbound");
});

test("legacy folder evidence must name the exact session, never just the repository", () => {
    assert.equal(classifyOwnership({ workspaceFolders: ["C:\\repo", folder(A)] }, expected), "owned");
    assert.equal(classifyOwnership({ workspaceFolders: ["C:\\repo"] }, expected), "unbound");
    assert.equal(classifyOwnership({ workspaceFolders: [folder(B)] }, expected), "foreign");
    assert.equal(classifyOwnership({}, expected), "unknown");
});

test("incomplete or malformed identities do not become ownership", () => {
    assert.equal(classifyOwnership(owned, {}), "unknown");
    assert.equal(classifyOwnership(owned, { sessionId: B, sessionPath: folder(A) }), "conflicted");
    assert.equal(classifyOwnership(owned, { sessionId: 42 }), "conflicted");
    assert.equal(classifyOwnership({ sessionId: {} }, expected), "conflicted");
    assert.equal(classifyOwnership(null, expected), "unknown");
    assert.equal(classifyOwnership({ workspaceFolders: [{}] }, expected), "conflicted");
});

test("normalization handles Windows paths without substring authority", () => {
    assert.equal(normalizedSessionPath(folder(A).toUpperCase() + "\\"), normalizedSessionPath(folder(A)));
    assert.equal(classifyOwnership({
        workspaceFolders: [folder(A) + "-different"],
    }, expected), "unbound");
    assert.deepEqual(sessionIdentity({ sessionPath: folder(A) }), expected);
});

test("companion options carry both source identity fields and preserve explicit target", () => {
    const result = companionOptions("C:\\repo", () => ({ workspacePath: folder(A) }), { windowId: "123" });
    assert.equal(result.sessionId, A);
    assert.equal(result.sessionPath, folder(A));
    assert.equal(result.windowId, "123");
});

test("transport evidence survives success-shaped route formatting", () => {
    const text = withDeliveryNotes({
        ok: true,
        windowId: "primary",
        deliveryMode: "guarded",
        alsoShownIn: [{ windowId: "secondary", ok: false, reason: "unconfirmed", deliveryMode: "legacy-single-shot" }],
    }, "porthole: annotated two ranges.");
    assert.match(text, /annotated two ranges/);
    assert.match(text, /Target window: primary/);
    assert.match(text, /Legacy single-shot/);
    assert.match(text, /secondary: unconfirmed/);
});

test("uncertainty is not presented as proof of non-execution", () => {
    assert.match(withDeliveryNotes({ reason: "unconfirmed" }, "No acknowledgement."), /may already have executed/);
    assert.equal(withDeliveryNotes({}, "No window available."), "No window available.");
});
