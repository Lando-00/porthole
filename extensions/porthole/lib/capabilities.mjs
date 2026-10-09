const LEGACY_ROUTES = new Set([
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

export const CLI_PROTOCOL_LEVEL = 1;
export const SESSION_OWNED_OPERATIONS = "transport:session-owned-operations-v1";
export const CLI_CAPABILITIES = Object.freeze([
    "transport:addressed-inbox",
    SESSION_OWNED_OPERATIONS,
]);
export const REQUIRED_COMPANION_CAPABILITIES = Object.freeze([
    "transport:addressed-inbox",
]);

export function routeCapability(route) {
    return `route:${route || "reveal"}`;
}

export function companionSupportsRoute(companion, route) {
    const required = routeCapability(route);
    if (Array.isArray(companion.capabilities)) {
        if (companion.capabilities.includes(required)) {
            return { ok: true, required, legacy: false };
        }
        return {
            ok: false,
            required,
            legacy: false,
            error:
                `this operation requires companion capability '${required}', but ` +
                `porthole companion ${companion.version || "unknown"} does not advertise it. ` +
                "Update the porthole companion and open a new VS Code window.",
        };
    }

    if (LEGACY_ROUTES.has(route)) return { ok: true, required, legacy: true };
    return {
        ok: false,
        required,
        legacy: true,
        error:
            `this operation requires companion capability '${required}', but the running ` +
            "porthole companion predates capability negotiation. Update the porthole companion " +
            "and open a new VS Code window.",
    };
}

export function companionSupportsSessionOwnedOperations(companion) {
    return Array.isArray(companion?.capabilities) &&
        companion.capabilities.includes(SESSION_OWNED_OPERATIONS);
}

export const legacyRoutes = () => new Set(LEGACY_ROUTES);
