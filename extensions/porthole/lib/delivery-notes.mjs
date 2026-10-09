function legacy(mode) {
    return typeof mode === "string" && mode.startsWith("legacy");
}

/** Transport evidence must survive callers formatting the route's own result. */
export function withDeliveryNotes(result, message) {
    if (!result) return message;
    const lines = [message];
    if (
        (result.reason === "unconfirmed" || result.mayHaveExecuted) &&
        !/may have|may already/i.test(message)
    ) {
        lines.push("The action may already have executed. Confirm its outcome before issuing it as a new operation.");
    }
    if (result.windowId) lines.push(`Target window: ${result.windowId}.`);

    const secondary = Array.isArray(result.alsoShownIn) ? result.alsoShownIn : [];
    if (legacy(result.deliveryMode) || secondary.some((entry) => legacy(entry.deliveryMode))) {
        lines.push(
            "Legacy single-shot delivery: no automatic retry or receiver-side ownership guarantee " +
            "for legacy targets. Update both running halves for guarded delivery.",
        );
    }
    if (secondary.length) {
        lines.push("Other windows: " + secondary.map((entry) => {
            const outcome = entry.ok ? "acknowledged" : entry.error || entry.reason || "unconfirmed";
            return `${entry.windowId || "unknown"}: ${outcome}`;
        }).join("; ") + ".");
    }
    return lines.join("\n");
}
