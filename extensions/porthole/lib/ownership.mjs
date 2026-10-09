import { posix, win32 } from "node:path";

function pathRules(value) {
    return process.platform === "win32" || /^[a-z]:[\\/]|^\\\\/i.test(value) ? win32 : posix;
}

export function normalizedSessionPath(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const rules = pathRules(value);
    const absolute = rules.resolve(value);
    const normalized = absolute === rules.parse(absolute).root
        ? absolute
        : absolute.replace(/[\\/]+$/, "");
    return rules === win32 ? normalized.toLowerCase() : normalized;
}

function folderId(folder) {
    return typeof folder === "string"
        ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
        : null;
}

export function sessionIdentity({ sessionId, sessionPath, sessionFolder } = {}) {
    const folder = sessionPath || sessionFolder || null;
    return {
        sessionId: sessionId || folderId(folder) || null,
        sessionPath: folder,
    };
}

/**
 * Explicit binding evidence wins over contextual workspace folders. Window
 * selection, ensure, and deliberate adoption must use the same interpretation.
 */
export function classifyOwnership(companion, expected = {}) {
    if (!companion || typeof companion !== "object" || Array.isArray(companion)) return "unknown";
    const wanted = sessionIdentity(expected);
    if (wanted.sessionPath && typeof wanted.sessionPath !== "string") return "conflicted";
    const wantedPath = normalizedSessionPath(wanted.sessionPath);
    if (wanted.sessionId && typeof wanted.sessionId !== "string") return "conflicted";
    if (wanted.sessionId && wantedPath && folderId(wantedPath).toLowerCase() !== wanted.sessionId.toLowerCase()) {
        return "conflicted";
    }

    const hasId = Object.hasOwn(companion, "sessionId") && companion.sessionId !== undefined;
    const hasFolder = Object.hasOwn(companion, "sessionFolder") && companion.sessionFolder !== undefined;
    if (
        (hasId && companion.sessionId !== null && typeof companion.sessionId !== "string") ||
        (hasFolder && companion.sessionFolder !== null && typeof companion.sessionFolder !== "string")
    ) return "conflicted";

    const id = companion.sessionId || null;
    const folder = normalizedSessionPath(companion.sessionFolder);
    if (id && folder && folderId(folder).toLowerCase() !== id.toLowerCase()) return "conflicted";

    const folders = Array.isArray(companion.workspaceFolders) ? companion.workspaceFolders : null;
    if (folders?.some((value) => typeof value !== "string" || !value)) return "conflicted";
    const sessionFolders = [...new Set((folders || [])
        .filter((value) => typeof value === "string" && /[\\/]session-state[\\/][a-f0-9-]{36}[\\/]?$/i.test(value))
        .map(normalizedSessionPath))];
    if (sessionFolders.length > 1) return "conflicted";

    if (hasId || hasFolder) {
        if (!id && !folder) return "unbound";
        if (!wanted.sessionId && !wantedPath) return "unknown";
        if (id && wanted.sessionId && id.toLowerCase() !== wanted.sessionId.toLowerCase()) return "foreign";
        if (folder && wantedPath && folder !== wantedPath) return "foreign";
        if (folder && wanted.sessionId && folderId(folder).toLowerCase() !== wanted.sessionId.toLowerCase()) return "foreign";
        return "owned";
    }

    if (wantedPath && folders?.some((value) => normalizedSessionPath(value) === wantedPath)) {
        return "owned";
    }
    if (sessionFolders.length) return "foreign";
    return folders ? "unbound" : "unknown";
}
