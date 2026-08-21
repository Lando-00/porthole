const PROTOCOL_LEVEL = 1;
const ADDRESSED_INBOX = "transport:addressed-inbox";

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
        requiredCliCapabilities: [],
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
    // no support. Legacy endpoints retain their guaranteed baseline.
    if (!Array.isArray(endpoint.capabilities)) {
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
    ROUTES,
    routeCapability,
    presenceContract,
    connectionHealth,
};
