const assert = require("node:assert/strict");
const test = require("node:test");

const { connectionHealth } = require("../vscode-extension/src/capabilities");

test("window health distinguishes binding, connection, and both incompatibility directions", () => {
    assert.deepEqual(
        connectionHealth({ sessionId: null, endpoint: null }),
        { state: "unbound" },
    );
    assert.deepEqual(
        connectionHealth({ sessionId: "session-a", endpoint: null }),
        { state: "disconnected" },
    );
    assert.deepEqual(
        connectionHealth({
            sessionId: "session-a",
            endpoint: { capabilities: ["transport:addressed-inbox"] },
            companionCapabilities: ["route:ping"],
        }),
        { state: "connected", legacy: true },
    );
    assert.deepEqual(
        connectionHealth({
            sessionId: "session-a",
            endpoint: {
                capabilities: [
                    "transport:addressed-inbox",
                    "transport:session-owned-operations-v1",
                ],
            },
            companionCapabilities: [
                "transport:session-owned-operations-v1",
                "route:ping",
            ],
        }),
        { state: "connected", legacy: false },
    );
    assert.deepEqual(
        connectionHealth({
            sessionId: "session-a",
            endpoint: {
                capabilities: ["transport:addressed-inbox"],
                requiredCompanionCapabilities: ["route:focus"],
            },
            companionCapabilities: ["route:ping"],
        }),
        {
            state: "incompatible",
            updateTarget: "companion",
            missingCapabilities: ["route:focus"],
        },
    );
    assert.deepEqual(
        connectionHealth({
            sessionId: "session-a",
            endpoint: { capabilities: ["transport:legacy-uri"] },
            companionCapabilities: ["route:ping"],
            requiredCliCapabilities: ["transport:addressed-inbox"],
        }),
        {
            state: "incompatible",
            updateTarget: "plugin",
            missingCapabilities: ["transport:addressed-inbox"],
        },
    );
});

test("a CLI endpoint without the required handshake is incompatible with a modern companion", () => {
    assert.deepEqual(
        connectionHealth({
            sessionId: "session-a",
            endpoint: { pid: 42 },
            companionCapabilities: ["route:ping"],
            requiredCliCapabilities: ["transport:addressed-inbox"],
        }),
        {
            state: "incompatible",
            updateTarget: "plugin",
            missingCapabilities: ["transport:addressed-inbox"],
        },
    );
});

test("the guarded operation capability is optional in both handshake directions", () => {
    const capabilities = require("../vscode-extension/src/capabilities");
    const contract = capabilities.presenceContract(["ping"]);

    assert.equal(
        contract.capabilities.includes("transport:session-owned-operations-v1"),
        true,
    );
    assert.deepEqual(contract.requiredCliCapabilities, ["transport:addressed-inbox"]);
});

test("the CLI advertises guarded operations without globally requiring them", async () => {
    const capabilities = await import("../extensions/porthole/lib/capabilities.mjs");

    assert.equal(
        capabilities.CLI_CAPABILITIES.includes(
            "transport:session-owned-operations-v1",
        ),
        true,
    );
    assert.deepEqual(capabilities.REQUIRED_COMPANION_CAPABILITIES, [
        "transport:addressed-inbox",
    ]);
});
