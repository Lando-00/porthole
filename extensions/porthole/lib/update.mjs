import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { copilotHome } from "./config.mjs";

const MARKETPLACE_URL =
    "https://raw.githubusercontent.com/Lando-00/porthole/main/.github/plugin/marketplace.json";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2000;

export function cachePath() {
    return join(copilotHome(), "porthole", "plugin-update.json");
}

function parseVersion(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || "").trim());
    if (!match) return null;
    return {
        raw: String(value).replace(/^v/, ""),
        core: match.slice(1, 4).map(Number),
        prerelease: match[4] || null,
    };
}

export function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return null;

    for (let i = 0; i < 3; i += 1) {
        if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
    }
    if (a.prerelease === b.prerelease) return 0;
    if (a.prerelease === null) return 1;
    if (b.prerelease === null) return -1;
    return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function latestVersion(manifest) {
    const entry = manifest?.plugins?.find((plugin) => plugin?.name === "porthole");
    return parseVersion(entry?.version)?.raw || null;
}

function readCache(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (!parseVersion(parsed.latestVersion) || !Number.isFinite(parsed.checkedAt)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(file, value) {
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, file);
    } catch {
        // Update discovery is optional and must never break session startup.
    }
}

async function fetchLatest(fetchImpl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(MARKETPLACE_URL, {
            headers: { "user-agent": "porthole-update-check" },
            signal: controller.signal,
        });
        if (!response.ok) return null;
        return latestVersion(await response.json());
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function checkForUpdate(currentVersion, options = {}) {
    if (!parseVersion(currentVersion)) return null;

    const now = options.now ?? Date.now();
    const file = options.cacheFile || cachePath();
    const cache = readCache(file);
    let latest = null;

    if (cache && now - cache.checkedAt < (options.cacheMaxAgeMs ?? CACHE_MAX_AGE_MS)) {
        latest = cache.latestVersion;
    } else {
        latest = await fetchLatest(
            options.fetchImpl || globalThis.fetch,
            options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        );
        if (latest) writeCache(file, { checkedAt: now, latestVersion: latest });
        else latest = cache?.latestVersion || null;
    }

    return latest && compareVersions(latest, currentVersion) === 1
        ? { currentVersion, latestVersion: latest }
        : null;
}

export function updateMessage(update) {
    return (
        `porthole ${update.latestVersion} is available; you have ${update.currentVersion}.\n` +
        "Exit every Copilot CLI session, then run:\n" +
        "  copilot plugin update porthole@porthole-marketplace"
    );
}

export async function notifyIfUpdateAvailable(session, currentVersion, options = {}) {
    const update = await checkForUpdate(currentVersion, options);
    if (!update) return null;

    const message = updateMessage(update);
    await session.log(message, { ephemeral: true, level: "warning" });
    return update;
}
