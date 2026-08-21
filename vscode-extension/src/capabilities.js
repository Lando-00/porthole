const PROTOCOL_LEVEL = 1;
const ADDRESSED_INBOX = "transport:addressed-inbox";
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
    "review-save",
    "review-list",
    "review-load",
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

    return { state: "connected", legacy: false };
}

module.exports = {
    PROTOCOL_LEVEL,
    ADDRESSED_INBOX,
    REQUIRED_CLI_CAPABILITIES,
    ROUTES,
    routeCapability,
    presenceContract,
    connectionHealth,
};
