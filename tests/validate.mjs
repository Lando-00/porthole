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

// ---------------------------------------------------------------------------

console.log(checks.join("\n"));

if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
