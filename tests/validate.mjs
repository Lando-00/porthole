// Validates the plugin without installing it.
//
// Everything here is a mistake that has actually shipped: a manifest version
// that drifted from the marketplace, a skill missing its frontmatter, a syntax
// error in a file no test imports. Run with `node tests/validate.mjs`.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const checks = [];

function check(name, fn) {
    try {
        const detail = fn();
        checks.push(`ok   ${name}${detail ? ` (${detail})` : ""}`);
    } catch (err) {
        checks.push(`FAIL ${name}: ${err.message}`);
        failures.push(name);
    }
}

function readJson(relPath) {
    const file = join(ROOT, relPath);
    if (!existsSync(file)) throw new Error(`${relPath} is missing`);
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
        throw new Error(`${relPath} is not valid JSON: ${err.message}`);
    }
}

/** Every .mjs and .js outside node_modules, so nothing escapes the syntax check. */
function sourceFiles(dir = ROOT, found = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, found);
        else if (/\.(mjs|js)$/.test(entry.name)) found.push(full);
    }
    return found;
}

// ---------------------------------------------------------------------------

check("every .mjs/.js parses", () => {
    const files = sourceFiles();
    const broken = [];
    for (const file of files) {
        try {
            execFileSync(process.execPath, ["--check", file], { stdio: "ignore" });
        } catch {
            broken.push(relative(ROOT, file));
        }
    }
    if (broken.length) throw new Error(`syntax errors in ${broken.join(", ")}`);
    return `${files.length} files`;
});

check("plugin.json is valid", () => {
    const manifest = readJson("plugin.json");
    for (const field of ["name", "version", "description", "license"]) {
        if (!manifest[field]) throw new Error(`missing '${field}'`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        throw new Error(`version '${manifest.version}' is not semver`);
    }
    return `v${manifest.version}`;
});

check("marketplace.json matches plugin.json", () => {
    const manifest = readJson("plugin.json");
    const marketplace = readJson(".github/plugin/marketplace.json");
    const entry = (marketplace.plugins || []).find((p) => p.name === manifest.name);
    if (!entry) throw new Error(`no '${manifest.name}' entry in the marketplace`);
    if (entry.version !== manifest.version) {
        throw new Error(
            `marketplace says ${entry.version}, plugin.json says ${manifest.version}`,
        );
    }
    return entry.version;
});

check("the companion manifest is valid", () => {
    const pkg = readJson("vscode-extension/package.json");
    for (const field of ["name", "publisher", "version", "main", "engines"]) {
        if (!pkg[field]) throw new Error(`missing '${field}'`);
    }
    if (!existsSync(join(ROOT, "vscode-extension", pkg.main))) {
        throw new Error(`main '${pkg.main}' does not exist`);
    }
    // onUri alone was unreliable; both events are required.
    const events = pkg.activationEvents || [];
    for (const required of ["onUri", "onStartupFinished"]) {
        if (!events.includes(required)) throw new Error(`activationEvents needs '${required}'`);
    }
    return `v${pkg.version}`;
});

check("contributed command ids are all implemented", () => {
    const pkg = readJson("vscode-extension/package.json");
    const declared = (pkg.contributes?.commands || []).map((c) => c.command);
    const sources = sourceFiles(join(ROOT, "vscode-extension"))
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
    const missing = declared.filter((id) => !sources.includes(`"${id}"`));
    if (missing.length) throw new Error(`declared but never registered: ${missing.join(", ")}`);
    return `${declared.length} commands`;
});

check("every skill has frontmatter", () => {
    const skillsDir = join(ROOT, "skills");
    if (!existsSync(skillsDir)) return "no skills";
    const names = readdirSync(skillsDir).filter((n) =>
        statSync(join(skillsDir, n)).isDirectory(),
    );
    for (const name of names) {
        const file = join(skillsDir, name, "SKILL.md");
        if (!existsSync(file)) throw new Error(`${name} has no SKILL.md`);
        const text = readFileSync(file, "utf8");
        if (!text.startsWith("---")) throw new Error(`${name}/SKILL.md has no frontmatter`);
        const end = text.indexOf("\n---", 3);
        if (end === -1) throw new Error(`${name}/SKILL.md frontmatter is not closed`);
        const front = text.slice(3, end);
        for (const key of ["name", "description"]) {
            if (!new RegExp(`^${key}:`, "m").test(front)) {
                throw new Error(`${name}/SKILL.md frontmatter has no '${key}'`);
            }
        }
    }
    return `${names.length} skills`;
});

check("the example config is accepted by the loader", () => {
    readJson("porthole.example.json");
    return "parses";
});

// --- protocol drift ---------------------------------------------------------
//
// The two halves ship separately and share nothing but the filesystem
// contract in docs/PROTOCOL.md. These checks catch the drift that a runtime
// test would only find once someone hit the route.

/** The route names the companion's dispatcher accepts. */
function companionRoutes() {
    const source = readFileSync(join(ROOT, "vscode-extension/extension.js"), "utf8");
    const match = source.match(/const KNOWN = new Set\(\[([^\]]*)\]\)/);
    if (!match) throw new Error("could not find the KNOWN route set in extension.js");
    return new Set([...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]));
}

/** The route names the CLI actually calls. */
function cliRoutes() {
    const found = new Set();
    for (const file of sourceFiles(join(ROOT, "extensions"))) {
        const source = readFileSync(file, "utf8");
        for (const m of source.matchAll(/callCompanion\(\s*"([\w-]+)"/g)) found.add(m[1]);
    }
    return found;
}

check("every route the CLI calls exists in the companion", () => {
    const known = companionRoutes();
    const called = cliRoutes();
    const missing = [...called].filter((r) => !known.has(r));
    if (missing.length) {
        throw new Error(`the companion has no route for: ${missing.join(", ")}`);
    }
    return `${called.size} called / ${known.size} known`;
});

check("docs/PROTOCOL.md documents every companion route", () => {
    const spec = readFileSync(join(ROOT, "docs/PROTOCOL.md"), "utf8");
    const undocumented = [...companionRoutes()].filter(
        (route) => route && !spec.includes(`\`${route}\``),
    );
    if (undocumented.length) {
        throw new Error(`missing from the protocol spec: ${undocumented.join(", ")}`);
    }
    return "in sync";
});

check("both halves agree on the transport directories", () => {
    // Divergence here is invisible at runtime: each side would happily use its
    // own directory and simply never see the other.
    const files = {
        companion: "vscode-extension/src/transport.js",
        cli: "extensions/porthole/lib/companion.mjs",
    };
    for (const [half, relPath] of Object.entries(files)) {
        const source = readFileSync(join(ROOT, relPath), "utf8");
        for (const segment of ["porthole", "req", "ack"]) {
            if (!source.includes(`"${segment}"`)) {
                throw new Error(`${half} (${relPath}) does not use the '${segment}' directory`);
            }
        }
    }
    return "req/ack agree";
});

check("the tour storage path matches the spec", () => {
    // The spec is what both halves are written against, and a tour written to a
    // path the spec does not describe is a tour the CLI will never find.
    const spec = readFileSync(join(ROOT, "docs/PROTOCOL.md"), "utf8");
    if (!spec.includes("<sessionDir>/porthole/tours/<tourId>.json")) {
        throw new Error("docs/PROTOCOL.md no longer documents where tours are stored");
    }

    const store = readFileSync(join(ROOT, "vscode-extension/src/tourstore.js"), "utf8");
    if (!/join\(sessionDir,\s*"porthole",\s*"tours"\)/.test(store)) {
        throw new Error("tourstore.js does not write to <sessionDir>/porthole/tours");
    }
    return "sessionDir/porthole/tours";
});

check("a tour id means the same thing everywhere", () => {
    // The id is the registry key, the filename and the diagnostic layer name.
    // Three different notions of what is allowed would mean a tour that can be
    // created but never saved, or saved but never deleted.
    const sources = {
        "tour.js": "vscode-extension/src/tour.js",
        "tourstore.js": "vscode-extension/src/tourstore.js",
    };
    for (const [name, relPath] of Object.entries(sources)) {
        const source = readFileSync(join(ROOT, relPath), "utf8");
        if (!source.includes("[\\w-]{1,64}") && !source.includes("normaliseSlug")) {
            throw new Error(`${name} does not use the shared tour id rule`);
        }
    }

    const spec = readFileSync(join(ROOT, "docs/PROTOCOL.md"), "utf8");
    if (!spec.includes("^[\\w-]{1,64}$")) {
        throw new Error("docs/PROTOCOL.md does not state the tour id rule");
    }
    return "[\\w-]{1,64} everywhere";
});

check("closing a tour is not the same as deleting it", () => {
    // The distinction is the whole reason a library is safe to use: closing is
    // "I have finished with this for now". If tour-exit ever started removing
    // files, a user would lose work by tidying up.
    const source = readFileSync(join(ROOT, "vscode-extension/src/tour.js"), "utf8");
    const close = source.slice(source.indexOf("function close("), source.indexOf("function exit("));
    if (/rmSync|unlinkSync|fs\.rm/.test(close)) {
        throw new Error("tour.js close() touches the filesystem; closing must not delete");
    }
    return "close leaves the file alone";
});

// ---------------------------------------------------------------------------

console.log(checks.join("\n"));

if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
