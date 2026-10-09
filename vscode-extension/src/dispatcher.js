function normaliseRoute(route) {
    if (typeof route !== "string") return null;
    return route.replace(/^\/+/, "").toLowerCase();
}

function createDispatcher({
    knownRoutes,
    optionalPayloadRoutes = new Set(),
    dispatch,
    onHandled = () => {},
    warn = () => {},
    diag = () => {},
}) {
    if (!(knownRoutes instanceof Set)) throw new TypeError("knownRoutes must be a Set");
    if (typeof dispatch !== "function") throw new TypeError("dispatch is required");

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
            if (!requestId) warn(result.error);
            return result;
        }

        if (requestId && payload === null && !optionalPayloadRoutes.has(normalised)) {
            return { ok: false, error: "payload file was missing or unreadable" };
        }

        let result;
        try {
            result = await dispatch(normalised, payload || {});
        } catch (error) {
            result = {
                ok: false,
                error: error?.message || String(error),
                mayHaveExecuted: true,
            };
        }
        if (!result || typeof result !== "object") {
            result = {
                ok: false,
                error: "route returned no result",
                mayHaveExecuted: true,
            };
        }
        diag(`route=${normalised} ok=${result.ok}${result.error ? ` error=${result.error}` : ""}`);
        try {
            await onHandled(result, { route: normalised, requestId, source });
        } catch (error) {
            const postDispatchError = error?.message || String(error);
            result = result.ok
                ? {
                      ...result,
                      ok: false,
                      error: `route completed but post-dispatch handling failed: ${postDispatchError}`,
                      mayHaveExecuted: true,
                  }
                : { ...result, postDispatchError };
        }
        diag(`route=${normalised} ok=${result.ok}${result.error ? ` error=${result.error}` : ""}`);

        if (!result.ok && !requestId) warn(result.error);
        return result;
    };
}

module.exports = { createDispatcher, normaliseRoute };
