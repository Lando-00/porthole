const crypto = require("node:crypto");
const path = require("node:path");

const OPERATION_VERSION = 1;
const DELIVERY_MODE = "guarded";
// Preview is the longest supported caller budget (30 minutes); the extra five
// seconds permits transport setup without allowing arbitrary cache pinning.
const MAX_OPERATION_LIFETIME_MS = 30 * 60 * 1000 + 5000;
const MAX_FUTURE_SKEW_MS = 5000;
const COMPLETED_GRACE_MS = 60 * 1000;
const MAX_OPERATION_RECORDS = 256;
const MAX_OPERATION_ATTEMPTS = 3;
const MAX_EXECUTIONS = 8;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const RESULT_BUDGET_BYTES = 16 * 1024 * 1024;
const RESULT_LIMIT = Object.freeze({
    ok: false,
    reason: "result-limit",
    error: "The completed result exceeded its retention limit.",
    mayHaveExecuted: true,
});
const RESULT_LIMIT_JSON = JSON.stringify(RESULT_LIMIT);
const RESULT_LIMIT_BYTES = Buffer.byteLength(RESULT_LIMIT_JSON, "utf8");

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOW_ID_RE = /^[a-f0-9]{16}$/;
const OPERATION_FIELDS = new Set([
    "version",
    "id",
    "createdAt",
    "expiresAt",
    "sessionId",
    "sessionFolder",
    "targetWindowId",
    "targetStartedAt",
    "admission",
]);

function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbsolutePath(value) {
    return (
        path.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        path.posix.isAbsolute(value)
    );
}

function folderName(value) {
    const text = String(value).replace(/[\\/]+$/, "");
    return text.split(/[\\/]/).pop() || "";
}

function normaliseComparablePath(value) {
    const rules = /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix;
    const normal = rules.normalize(value).replace(/[\\/]+$/, "");
    return rules === path.win32 ? normal.toLowerCase() : normal;
}

function parseTimestamp(value, name) {
    if (typeof value !== "string" || value.length === 0 || value.length > 64) {
        return { error: `${name} was missing or invalid` };
    }
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds)
        ? { value: milliseconds }
        : { error: `${name} was missing or invalid` };
}

function canonicalise(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("operation data contained a non-finite number");
        return value;
    }
    if (Array.isArray(value)) return value.map(canonicalise);
    if (!isObject(value)) throw new TypeError("operation data was not JSON-compatible");

    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) {
            throw new TypeError("operation data contained an undefined value");
        }
        result[key] = canonicalise(value[key]);
    }
    return result;
}

function fingerprint(request) {
    const immutable = {
        route: request.route,
        payload: request.payload,
        operation: request.operation,
    };
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(canonicalise(immutable)))
        .digest("hex");
}

function operationIncludesFolder(payload, expectedFolder) {
    if (!isObject(payload)) return false;
    const values = Array.isArray(payload.folders)
        ? payload.folders
        : ["folder", "path", "folderPath"]
              .filter((name) => Object.prototype.hasOwnProperty.call(payload, name))
              .map((name) => payload[name]);
    const expected = normaliseComparablePath(expectedFolder);
    return values.some(
        (value) =>
            typeof value === "string" &&
            normaliseComparablePath(value) === expected,
    );
}

function validateRequest(request, now, host) {
    if (!isObject(request)) return { error: "request was not a JSON object" };
    if (typeof request.requestId !== "string" || !IDENTIFIER_RE.test(request.requestId)) {
        return { error: "requestId was missing or invalid" };
    }
    if (typeof request.route !== "string") return { error: "route was missing or invalid" };
    if (!Object.prototype.hasOwnProperty.call(request, "payload")) {
        return { error: "payload was missing" };
    }

    const operation = request.operation;
    if (!isObject(operation)) return { error: "operation was missing or invalid" };
    const unexpected = Object.keys(operation).filter((key) => !OPERATION_FIELDS.has(key));
    if (unexpected.length > 0) {
        return { error: `operation contained unsupported field '${unexpected[0]}'` };
    }
    for (const field of OPERATION_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(operation, field)) {
            return { error: `operation.${field} was missing` };
        }
    }
    if (operation.version !== OPERATION_VERSION) {
        return { error: `unsupported operation version '${operation.version}'` };
    }
    if (typeof operation.id !== "string" || !IDENTIFIER_RE.test(operation.id)) {
        return { error: "operation.id was missing or invalid" };
    }
    if (typeof operation.sessionId !== "string" || !IDENTIFIER_RE.test(operation.sessionId)) {
        return { error: "operation.sessionId was missing or invalid" };
    }
    if (
        typeof operation.sessionFolder !== "string" ||
        operation.sessionFolder.length === 0 ||
        operation.sessionFolder.length > 4096 ||
        operation.sessionFolder.includes("\0") ||
        !isAbsolutePath(operation.sessionFolder)
    ) {
        return { error: "operation.sessionFolder was missing or invalid" };
    }
    if (
        folderName(operation.sessionFolder).toLowerCase() !==
        operation.sessionId.toLowerCase()
    ) {
        return { error: "operation session identity was conflicted" };
    }
    if (typeof operation.targetWindowId !== "string" || !WINDOW_ID_RE.test(operation.targetWindowId)) {
        return { error: "operation.targetWindowId was missing or invalid" };
    }
    if (!["owned", "adopt-unbound"].includes(operation.admission)) {
        return { error: "operation.admission was missing or invalid" };
    }

    const created = parseTimestamp(operation.createdAt, "operation.createdAt");
    if (created.error) return created;
    const expires = parseTimestamp(operation.expiresAt, "operation.expiresAt");
    if (expires.error) return expires;
    const targetStarted = parseTimestamp(
        operation.targetStartedAt,
        "operation.targetStartedAt",
    );
    if (targetStarted.error) return targetStarted;
    if (expires.value < created.value) {
        return { error: "operation.expiresAt preceded operation.createdAt" };
    }
    if (created.value > now + host.maxFutureSkewMs) {
        return { error: "operation.createdAt was too far in the future" };
    }
    if (expires.value - created.value > host.maxLifetimeMs) {
        return { error: "operation lifetime exceeded the receiver limit" };
    }
    let operationFingerprint;
    try {
        operationFingerprint = fingerprint(request);
    } catch (error) {
        return { error: error.message };
    }
    return {
        operation,
        createdAtMs: created.value,
        expiresAtMs: expires.value,
        fingerprint: operationFingerprint,
    };
}

function serialiseResult(result) {
    try {
        const json = JSON.stringify(result);
        if (json === undefined) return { error: "route returned an unserialisable result" };
        return { json, bytes: Buffer.byteLength(json, "utf8") };
    } catch (error) {
        return { error: `route returned an unserialisable result: ${error.message}` };
    }
}

function normaliseResult(value) {
    if (!isObject(value)) {
        return {
            ok: false,
            error: "route returned no result",
            mayHaveExecuted: true,
        };
    }
    return value;
}

function ownershipState(value) {
    if (typeof value === "string") return value;
    return isObject(value) && typeof value.state === "string" ? value.state : "unknown";
}

function ownershipError(state) {
    switch (state) {
        case "unbound":
            return "the target window is not bound to the expected Copilot session";
        case "foreign":
            return "the target window is bound to a different Copilot session";
        case "conflicted":
            return "the target window has conflicting Copilot session bindings";
        default:
            return "the target window's Copilot session ownership could not be established";
    }
}

/** One host-wide bound, shared by guarded executions and legacy deliveries. */
function createExecutionBudget(limit = MAX_EXECUTIONS) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("invalid execution limit");
    let active = 0;
    return {
        limit,
        get active() { return active; },
        acquire() {
            if (active >= limit) return null;
            active += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active -= 1;
            };
        },
    };
}

function createOperationHost(options = {}) {
    if (typeof options.execute !== "function") {
        throw new TypeError("operation executor is required");
    }
    if (typeof options.inspectOwnership !== "function") {
        throw new TypeError("operation ownership inspector is required");
    }
    if (!WINDOW_ID_RE.test(String(options.windowId || ""))) {
        throw new TypeError("operation host windowId is invalid");
    }
    if (parseTimestamp(options.startedAt, "operation host startedAt").error) {
        throw new TypeError("operation host startedAt is invalid");
    }

    const host = {
        execute: options.execute,
        inspectOwnership: options.inspectOwnership,
        windowId: options.windowId,
        startedAt: options.startedAt,
        now: options.now || Date.now,
        maxLifetimeMs: options.maxLifetimeMs ?? MAX_OPERATION_LIFETIME_MS,
        maxFutureSkewMs: options.maxFutureSkewMs ?? MAX_FUTURE_SKEW_MS,
        completedGraceMs: options.completedGraceMs ?? COMPLETED_GRACE_MS,
        maxRecords: options.maxRecords ?? MAX_OPERATION_RECORDS,
        maxAttempts: options.maxAttempts ?? MAX_OPERATION_ATTEMPTS,
        maxExecutions: options.maxExecutions ?? MAX_EXECUTIONS,
        maxResultBytes: options.maxResultBytes ?? MAX_RESULT_BYTES,
        resultBudgetBytes: options.resultBudgetBytes ?? RESULT_BUDGET_BYTES,
    };

    const records = new Map();
    const executionBudget = options.executionBudget || createExecutionBudget(host.maxExecutions);
    const resultReservationBytes = Math.max(host.maxResultBytes, RESULT_LIMIT_BYTES);
    let retainedResultBytes = 0;
    let reservedResultBytes = 0;
    let clockFloor = Number.NEGATIVE_INFINITY;

    function currentTime() {
        const observed = Number(host.now());
        if (!Number.isFinite(observed)) throw new TypeError("operation clock returned an invalid time");
        clockFloor = Math.max(clockFloor, observed);
        return clockFloor;
    }

    function cleanup(at = currentTime()) {
        let removed = 0;
        for (const [id, record] of records) {
            if (
                record.state === "completed" &&
                at > record.expiresAtMs + host.completedGraceMs
            ) {
                records.delete(id);
                retainedResultBytes -= record.resultBytes;
                removed += 1;
            }
        }
        return removed;
    }

    function decorate(result, request, operation, disposition) {
        return {
            ...JSON.parse(JSON.stringify(result)),
            requestId: request.requestId,
            operationId: operation?.id || null,
            windowId: host.windowId,
            targetStartedAt: host.startedAt,
            deliveryMode: DELIVERY_MODE,
            disposition,
        };
    }

    function reject(request, operation, reason, error, mayHaveExecuted = false) {
        const result = {
            ok: false,
            reason,
            error,
        };
        if (mayHaveExecuted) result.mayHaveExecuted = true;
        return decorate(result, request, operation, "rejected");
    }

    function inspect(operation) {
        try {
            return host.inspectOwnership({
                sessionId: operation.sessionId,
                sessionFolder: operation.sessionFolder,
            });
        } catch (error) {
            return { state: "unknown", error: error.message };
        }
    }

    function admissionError(request, operation, existing, ownership) {
        const state = ownershipState(ownership);
        if (["foreign", "conflicted", "unknown"].includes(state)) {
            return ownershipError(state);
        }
        if (operation.admission === "owned") {
            return state === "owned" ? null : ownershipError(state);
        }
        if (existing) {
            return state === "unbound" || state === "owned"
                ? null
                : ownershipError(state);
        }
        if (state !== "unbound") {
            return "adopt-unbound requires a currently unbound target window";
        }
        if (
            request.route !== "workspace-add" ||
            !operationIncludesFolder(request.payload, operation.sessionFolder)
        ) {
            return "adopt-unbound is restricted to workspace-add of the expected session folder";
        }
        return null;
    }

    async function submit(request) {
        const now = currentTime();
        cleanup(now);

        const valid = validateRequest(request, now, host);
        if (valid.error) {
            return reject(
                request || {},
                isObject(request?.operation) ? request.operation : null,
                "invalid-operation",
                valid.error,
            );
        }

        const operation = valid.operation;
        const existing = records.get(operation.id);
        if (existing && existing.fingerprint !== valid.fingerprint) {
            return reject(
                request,
                operation,
                "operation-conflict",
                "operation.id was reused with different immutable data",
                true,
            );
        }
        if (
            operation.targetWindowId !== host.windowId ||
            operation.targetStartedAt !== host.startedAt
        ) {
            return reject(
                request,
                operation,
                "invalid-operation",
                "operation targeted a different companion host incarnation",
            );
        }

        const ownership = inspect(operation);
        const refused = admissionError(request, operation, existing, ownership);
        if (refused) {
            return reject(
                request,
                operation,
                "ownership-refused",
                refused,
                Boolean(existing),
            );
        }

        if (existing) {
            if (
                !existing.attemptIds.has(request.requestId) &&
                existing.attemptIds.size >= host.maxAttempts
            ) {
                return reject(
                    request,
                    operation,
                    "too-many-attempts",
                    `operation already has ${host.maxAttempts} delivery attempts`,
                    true,
                );
            }
            existing.attemptIds.add(request.requestId);
            if (existing.state === "executing") {
                const result = await existing.promise;
                return decorate(result, request, operation, "joined");
            }
            return decorate(existing.result, request, operation, "replayed");
        }

        if (now > valid.expiresAtMs) {
            return reject(
                request,
                operation,
                "expired",
                "operation expired before receiver admission",
            );
        }
        if (records.size >= host.maxRecords) {
            return reject(
                request,
                operation,
                "busy",
                "the companion operation cache is full",
            );
        }
        if (executionBudget.active >= executionBudget.limit) {
            return reject(
                request,
                operation,
                "busy",
                `the companion already has ${executionBudget.limit} unique operations executing`,
            );
        }
        if (
            retainedResultBytes + reservedResultBytes + resultReservationBytes >
            host.resultBudgetBytes
        ) {
            return reject(
                request,
                operation,
                "busy",
                "the companion operation result cache is full",
            );
        }

        const releaseExecution = executionBudget.acquire();
        if (!releaseExecution) return reject(request, operation, "busy", "the companion execution budget is full");
        const record = {
            id: operation.id,
            fingerprint: valid.fingerprint,
            operation,
            state: "executing",
            expiresAtMs: valid.expiresAtMs,
            attemptIds: new Set([request.requestId]),
            result: null,
            resultBytes: 0,
            reservedBytes: resultReservationBytes,
            promise: null,
        };
        records.set(operation.id, record);
        reservedResultBytes += record.reservedBytes;
        const releaseReservation = () => {
            reservedResultBytes -= record.reservedBytes;
            record.reservedBytes = 0;
        };

        record.promise = Promise.resolve()
            .then(() => host.execute(request))
            .then(normaliseResult, (error) => ({
                ok: false,
                error: error?.message || String(error),
                mayHaveExecuted: true,
            }))
            .then((rawResult) => {
                // Transfer this reservation to retained bytes in one turn.
                // Deferring the release to finally double-counted completions.
                releaseReservation();
                let encoded = serialiseResult(rawResult);
                if (
                    encoded.error ||
                    encoded.bytes > host.maxResultBytes ||
                    retainedResultBytes + reservedResultBytes + encoded.bytes > host.resultBudgetBytes
                ) {
                    encoded = { json: RESULT_LIMIT_JSON, bytes: RESULT_LIMIT_BYTES };
                }
                if (retainedResultBytes + reservedResultBytes + encoded.bytes > host.resultBudgetBytes) {
                    throw new Error("operation result reservation invariant violated");
                }

                const retained = JSON.parse(encoded.json);
                record.state = "completed";
                record.result = retained;
                record.resultBytes = encoded.bytes;
                retainedResultBytes += encoded.bytes;
                return retained;
            })
            .finally(() => {
                releaseExecution();
                releaseReservation();
                record.promise = null;
                cleanup(currentTime());
            });

        const result = await record.promise;
        return decorate(result, request, operation, "executed");
    }

    function stats() {
        return {
            records: records.size,
            activeExecutions: executionBudget.active,
            retainedResultBytes,
            reservedResultBytes,
            operations: [...records.values()].map((record) => ({
                id: record.id,
                state: record.state,
                attempts: record.attemptIds.size,
                expiresAtMs: record.expiresAtMs,
                resultBytes: record.resultBytes,
            })),
        };
    }

    return {
        submit,
        maintain: cleanup,
        stats,
        executionBudget,
    };
}

module.exports = {
    OPERATION_VERSION,
    DELIVERY_MODE,
    MAX_OPERATION_LIFETIME_MS,
    MAX_FUTURE_SKEW_MS,
    COMPLETED_GRACE_MS,
    MAX_OPERATION_RECORDS,
    MAX_OPERATION_ATTEMPTS,
    MAX_EXECUTIONS,
    MAX_RESULT_BYTES,
    RESULT_BUDGET_BYTES,
    createExecutionBudget,
    createOperationHost,
};
