const PROTOCOL_LEVEL = 1;
const ADDRESSED_INBOX = "transport:addressed-inbox";
const SESSION_OWNED_OPERATIONS = "transport:session-owned-operations-v1";
const REQUIRED_CLI_CAPABILITIES = [ADDRESSED_INBOX];

const ROUTES = [
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
    "tour-discover",
    "tour-import",
    "tour-archive",
    "tour-legacy-cleanup",
    "review-save",
    "review-list",
    "review-load",
    "review-discover",
    "review-import",
    "review-delete",
    "workspace-add",
    "focus",
    "preview",
];

function routeCapability(route) {
    return `route:${route || "reveal"}`;
}

function presenceContract(routes = ROUTES) {
    return {
        protocolLevel: PROTOCOL_LEVEL,
        capabilities: [
            ADDRESSED_INBOX,
            SESSION_OWNED_OPERATIONS,
            ...new Set(routes.map(routeCapability)),
        ],
        requiredCliCapabilities: [...REQUIRED_CLI_CAPABILITIES],
    };
}

function missing(required, available) {
    return (required || []).filter((capability) => !available.includes(capability));
}

function connectionHealth({
    sessionId,
    endpoint,
    companionCapabilities = [],
    requiredCliCapabilities = [],
}) {
    if (!sessionId) return { state: "unbound" };
    if (!endpoint) return { state: "disconnected" };

    // Absence means an older CLI extension, not a modern endpoint advertising
    // no support. A modern companion still needs its core transport, so it can
    // identify the CLI plugin as the half that needs updating.
    if (!Array.isArray(endpoint.capabilities)) {
        if (requiredCliCapabilities.length > 0) {
            return {
                state: "incompatible",
                updateTarget: "plugin",
                missingCapabilities: [...requiredCliCapabilities],
            };
        }
        return { state: "connected", legacy: true };
    }

    const companionMissing = missing(
        endpoint.requiredCompanionCapabilities,
        companionCapabilities,
    );
    if (companionMissing.length > 0) {
        return {
            state: "incompatible",
            updateTarget: "companion",
            missingCapabilities: companionMissing,
        };
    }

    const pluginMissing = missing(requiredCliCapabilities, endpoint.capabilities);
    if (pluginMissing.length > 0) {
        return {
            state: "incompatible",
            updateTarget: "plugin",
            missingCapabilities: pluginMissing,
        };
    }

    return {
        state: "connected",
        legacy:
            !endpoint.capabilities.includes(SESSION_OWNED_OPERATIONS) ||
            !companionCapabilities.includes(SESSION_OWNED_OPERATIONS),
    };
}

module.exports = {
    PROTOCOL_LEVEL,
    ADDRESSED_INBOX,
    SESSION_OWNED_OPERATIONS,
    REQUIRED_CLI_CAPABILITIES,
    ROUTES,
    routeCapability,
    presenceContract,
    connectionHealth,
};
