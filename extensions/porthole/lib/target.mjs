/**
 * Resolves the current Copilot session lazily.
 *
 * Tool definitions are created before joinSession returns, so most callers hold
 * a getter rather than the session object itself.
 */
export function currentSession(source) {
    return typeof source === "function" ? source() : source || null;
}

export function sessionPath(source) {
    const session = currentSession(source);
    return typeof session?.workspacePath === "string" && session.workspacePath
        ? session.workspacePath
        : null;
}

export function companionOptions(contextPath, source, extra = {}) {
    return {
        contextPath,
        sessionPath: sessionPath(source),
        ...extra,
    };
}
