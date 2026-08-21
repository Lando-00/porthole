function normaliseRoute(route) {
    if (typeof route !== "string") return null;
    return route.replace(/^\/+/, "").toLowerCase();
}

function createDispatcher({
    knownRoutes,
    optionalPayloadRoutes = new Set(),
    dispatch,
    writeAck,
    onHandled = () => {},
    warn = () => {},
    diag = () => {},
}) {
    if (!(knownRoutes instanceof Set)) throw new TypeError("knownRoutes must be a Set");
    if (typeof dispatch !== "function") throw new TypeError("dispatch is required");
    if (typeof writeAck !== "function") throw new TypeError("writeAck is required");

    return async function executeRequest(route, payload, requestId = null, source = "uri") {
        const normalised = normaliseRoute(route);
        diag(`handle ${source} route=${normalised ?? "-"} req=${requestId || "-"}`);

        if (normalised === null || !knownRoutes.has(normalised)) {
            const result = {
                ok: false,
                error:
                    normalised === null
                        ? "route was missing or invalid"
                        : `unknown route '${normalised}'`,
            };
            writeAck(requestId, result);
            if (!requestId) warn(result.error);
            return result;
        }

        if (requestId && payload === null && !optionalPayloadRoutes.has(normalised)) {
            const result = { ok: false, error: "payload file was missing or unreadable" };
            writeAck(requestId, result);
            return result;
        }

        let result;
        try {
            result = await dispatch(normalised, payload || {});
        } catch (error) {
            result = { ok: false, error: error?.message || String(error) };
        }
        if (!result || typeof result !== "object") {
            result = { ok: false, error: "route returned no result" };
        }

        diag(`route=${normalised} ok=${result.ok}${result.error ? ` error=${result.error}` : ""}`);
        writeAck(requestId, result);
        await onHandled(result, { route: normalised, requestId, source });

        if (!result.ok && !requestId) warn(result.error);
        return result;
    };
}

module.exports = { createDispatcher, normaliseRoute };
