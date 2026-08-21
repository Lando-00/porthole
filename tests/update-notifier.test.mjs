import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    checkForUpdate,
    compareVersions,
    notifyIfUpdateAvailable,
    updateMessage,
} from "../extensions/porthole/lib/update.mjs";

function response(version) {
    return {
        ok: true,
        async json() {
            return { plugins: [{ name: "porthole", version }] };
        },
    };
}

test("semantic versions compare without string-order mistakes", () => {
    assert.equal(compareVersions("1.0.0", "0.9.0"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0"), -1);
    assert.equal(compareVersions("junk", "1.0.0"), null);
});

test("a newer Marketplace version produces the safe update notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "porthole-update-"));
    const logs = [];
    try {
        const update = await notifyIfUpdateAvailable(
            { log: async (...args) => logs.push(args) },
            "1.0.0",
            {
                cacheFile: join(root, "cache.json"),
                now: 1000,
                fetchImpl: async () => response("1.1.0"),
            },
        );
        assert.deepEqual(update, { currentVersion: "1.0.0", latestVersion: "1.1.0" });
        assert.equal(logs.length, 1);
        assert.match(logs[0][0], /Exit every Copilot CLI session/);
        assert.match(logs[0][0], /copilot plugin update porthole@porthole-marketplace/);
        assert.deepEqual(logs[0][1], { ephemeral: true, level: "warning" });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a fresh cache avoids a startup network request", async () => {
    const root = mkdtempSync(join(tmpdir(), "porthole-update-"));
    const file = join(root, "cache.json");
    let calls = 0;
    try {
        await checkForUpdate("1.0.0", {
            cacheFile: file,
            now: 1000,
            fetchImpl: async () => response("1.1.0"),
        });
        const update = await checkForUpdate("1.0.0", {
            cacheFile: file,
            now: 2000,
            fetchImpl: async () => {
                calls += 1;
                return response("9.9.9");
            },
        });
        assert.deepEqual(update, { currentVersion: "1.0.0", latestVersion: "1.1.0" });
        assert.equal(calls, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("equal or older Marketplace versions stay silent", async () => {
    const root = mkdtempSync(join(tmpdir(), "porthole-update-"));
    try {
        assert.equal(
            await checkForUpdate("1.0.0", {
                cacheFile: join(root, "equal.json"),
                fetchImpl: async () => response("1.0.0"),
            }),
            null,
        );
        assert.equal(
            await checkForUpdate("1.0.0", {
                cacheFile: join(root, "older.json"),
                fetchImpl: async () => response("0.9.0"),
            }),
            null,
        );
        assert.match(updateMessage({ currentVersion: "1.0.0", latestVersion: "1.1.0" }), /1\.1\.0/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
