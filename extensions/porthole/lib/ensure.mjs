// Opening a window when there is none, on the user's authority.
//
// Most porthole routes fail flat when no VS Code window is running: there is
// nothing to send the request to. Opening one automatically sounds like an
// obvious kindness and is not, because `porthole_open_session` is right that
// taking over someone's screen uninvited is hostile. A tour the model decided
// to build on its own must not be able to make a window appear.
//
// So the launch is opt-in, and the opt-in travels as data. `/walkthrough` sets
// it because the user typed the command; nothing else does. The authority comes
// from the user, not from a judgement made here.
//
// Lives in its own module because the alternative is a cycle: this needs
// `openSession`, and opensession.mjs already needs `callCompanion`.

import { findCompanions, isCompanionInstalled } from "./companion.mjs";
import { openSession, planOpenSession } from "./opensession.mjs";

// Long enough for a cold VS Code start plus extension-host activation, short
// enough that a window which is never coming does not hold the session. Polled
// rather than slept, so a fast window costs a fraction of it.
const WAIT_MS = 15_000;
const POLL_MS = 250;

/**
 * Waits for any companion window to publish its presence.
 *
 * Presence is the only evidence that means anything here. The launcher always
 * "succeeds", so a window that never came up is indistinguishable from one that
 * did until it reports in.
 */
async function waitForCompanion(timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : WAIT_MS);
    while (Date.now() < deadline) {
        if (findCompanions().length > 0) return true;
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return findCompanions().length > 0;
}

/**
 * Makes sure a companion window exists, opening one only when allowed to.
 *
 * Returns `{ opened, note }`. Nothing here reports failure: the caller is about
 * to make its real request, and that request's own result is the honest answer.
 * Guessing at success from a launch is exactly the mistake the ack protocol
 * exists to prevent - so on timeout this returns a note to append, not a claim.
 */
export async function ensureCompanion(getSession, options = {}) {
    if (options.openIfClosed !== true) return { opened: false, note: "" };
    if (findCompanions().length > 0) return { opened: false, note: "" };
    // Not installed is a different problem, and opening a window cannot fix it.
    // Launching anyway would cost the full wait and then give advice about the
    // wrong thing. `explain()` already says the right thing for this case.
    if (!isCompanionInstalled()) return { opened: false, note: "" };

    const session = typeof getSession === "function" ? getSession() : null;
    if (!session) return { opened: false, note: "" };

    // Plan before launching, because two of the three outcomes must not launch
    // at all and openSession reports both by *returning* a message rather than
    // throwing - so calling it blind would swallow the diagnosis, wait the full
    // fifteen seconds, and then blame the workspace-trust dialog.
    let plan;
    try {
        plan = planOpenSession(session, null, { revealPlan: false });
    } catch (err) {
        return { opened: false, note: `\n  could not work out how to open an editor - ${err?.message || err}` };
    }

    // No editor on PATH. Nothing to open, and the real advice is in plan.error.
    if (!plan.ok) return { opened: false, note: `\n  ${plan.error}` };

    // A window is already connected, so openSession would add a folder to it
    // rather than open anything - quietly turning the user's single-folder
    // window into a multi-root one, and still not producing a companion.
    //
    // A connected window with no companion presence is a different fault:
    // usually a window opened before the extension was installed, or a
    // workspace the user has not trusted. explainAbsent() already says exactly
    // that, so leave the diagnosis to it.
    if (plan.action === "reuse-window") return { opened: false, note: "" };

    // revealPlan would pull plan.md in front of the user, who asked to be shown
    // their own code. notifyIfSilent is this function's job, and doing it in
    // both places would stack two waits back to back.
    let outcome;
    try {
        outcome = await openSession(session, null, { revealPlan: false, notifyIfSilent: false });
    } catch (err) {
        return { opened: false, note: `\n  could not open an editor - ${err?.message || err}` };
    }

    // The remaining failure - an unwritable workspace file - is also returned
    // rather than thrown.
    if (typeof outcome === "string" && /could not/i.test(outcome)) {
        return { opened: false, note: `\n  ${outcome.replace(/^porthole:\s*/, "")}` };
    }

    if (await waitForCompanion(options.waitMs)) return { opened: true, note: "" };

    return {
        opened: true,
        note:
            "\n  an editor window was opened but has not reported in yet. If VS Code is asking" +
            "\n  whether you trust this workspace, it disables every extension until you say yes." +
            "\n  Once it is up, asking again will work.",
    };
}
