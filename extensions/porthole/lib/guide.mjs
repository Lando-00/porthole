// Finding your way around, and being shown.
//
// /porthole is the doctor: exactly what you want when something is broken, and
// no use at all when you have just installed this and are wondering what it
// does. These are the two things a new user actually needs - a list of what
// there is, and a demonstration.
//
// The demonstration is not a canned tour of porthole itself. It asks the agent
// to walk the user through *their own* project, because watching a tool explain
// code you already know is the fastest way to understand what it is for - and
// because a scripted demo teaches you the demo.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { findCompanions } from "./companion.mjs";
import { projectRoot } from "./git.mjs";

// ---------------------------------------------------------------------------
// /porthole <subcommand>
// ---------------------------------------------------------------------------

/**
 * Which of the three things /porthole was asked for.
 *
 * A function rather than a switch inline in the command handler, because the
 * handler cannot be reached without a live SDK session and this is the bit with
 * actual branching in it.
 *
 * Matches on the first word and rejects anything trailing it, rather than
 * comparing the whole string. `/porthole tours delete my-tour` - which the
 * README taught until recently - would otherwise fall through to the doctor:
 * a full diagnostic report, no error, and the tour still there. Falling back to
 * something plausible is how a mistyped destructive command looks like it
 * worked.
 */
export function subcommand(args) {
    const words = String(args || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const first = (words[0] || "").replace(/^-+/, "");
    const extra = words.length > 1;

    if (first === "help" || first === "?" || first === "h") return "help";
    if (first === "example" || first === "demo" || first === "show") return "example";
    if (first === "tours" || first === "tour" || first === "list") {
        return extra ? "unknown" : "tours";
    }
    if (!first || first === "doctor") return "doctor";
    return "unknown";
}

/** What to say when /porthole was given something it does not understand. */
export function unknownSubcommand(args) {
    const given = String(args || "").trim();
    return (
        `porthole: '${given}' is not something /porthole does.\n\n` +
        "  /porthole           diagnose everything\n" +
        "  /porthole help      every command, with examples\n" +
        "  /porthole example   see it on your own code\n" +
        "  /porthole tours     the walkthroughs that exist\n\n" +
        "Switching or deleting a tour is a click in the porthole sidebar."
    );
}

// ---------------------------------------------------------------------------
// /porthole help
// ---------------------------------------------------------------------------

const GROUPS = [
    {
        title: "Start here",
        rows: [
            ["/cops", "Open this project + the Copilot session folder in one workspace"],
            ["/porthole example", "Have Copilot demonstrate porthole on your own code"],
            ["/porthole help", "This list"],
            ["/porthole", "Diagnose everything, when something is not working"],
        ],
    },
    {
        title: "Being shown code",
        needsCompanion: true,
        rows: [
            ["/walkthrough <what>", '"how errors are handled" - a narrated, steppable tour of it'],
            ["/porthole tours", "What walkthroughs exist, and which have gone stale"],
            ["/tour-exit", "Stop walking the active tour (it stays in the library)"],
            ["/annotate <file:10-25> [note]", "Mark those lines with a note on hover"],
            ["/annotate-clear", "Remove every annotation"],
        ],
    },
    {
        title: "Getting somewhere",
        rows: [
            ["/goto <file:12>", "Jump to a line"],
            ["/goto <file:10-25>", "Select and highlight a range  (needs the companion)"],
            ["/goto <symbolName>", "Select a whole function or class by name  (needs the companion)"],
            ["/vsdiff", "Uncommitted changes; or a commit, a range, 'staged', or two files"],
        ],
    },
    {
        title: "Reading your editor",
        needsCompanion: true,
        rows: [
            ["/problems", "What VS Code is reporting right now: errors, warnings, type errors"],
            ["Ctrl+Alt+.", "In VS Code: send the selection back into this session as a question"],
        ],
    },
    {
        title: "Keeping things",
        rows: [
            ["/reviews", "Saved findings; /reviews load <name> to bring one back"],
            ["/diagram", "Describe it, Copilot writes the mermaid, it opens rendered"],
            ["/scratch", "A scratch note in the session folder"],
            ["/vsreview", "Open every file changed on a branch as diffs"],
        ],
    },
];

export function help() {
    const connected = findCompanions().length > 0;
    const lines = [
        "porthole - a window from this session into VS Code.",
        "",
    ];

    for (const group of GROUPS) {
        lines.push(`${group.title}`);
        for (const [command, what] of group.rows) {
            lines.push(`  ${command.padEnd(30)} ${what}`);
        }
        lines.push("");
    }

    lines.push(
        connected
            ? "The companion extension is connected, so all of the above works."
            : "The companion VS Code extension is NOT connected. Annotations, walkthroughs,\n" +
              "range selection, symbol lookup and the Problems panel need it:\n" +
              "  code --install-extension Lando-00.porthole-companion\n" +
              "Then open a NEW window - a reload keeps the old build. /porthole checks it.",
    );

    lines.push(
        "",
        "/walkthrough builds a tour of code you name, and opens an editor if none is up.",
        "/porthole example is the quicker look: Copilot picks a file and shows you.",
    );
    lines.push(
        "Switching between tours, and jumping to a step, is quicker in the porthole",
        "sidebar than by typing an id.",
    );
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /porthole example
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".py", ".go", ".rs", ".java", ".cs", ".rb", ".php",
    ".c", ".h", ".cpp", ".hpp", ".swift", ".kt", ".sh", ".ps1",
]);

const SKIP_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "out", "vendor", "target",
    ".venv", "venv", "__pycache__", ".next", ".nuxt", "coverage", ".idea", ".vscode",
]);

/**
 * Tests are still offered, but last.
 *
 * A test file is perfectly good code and a poor first impression: the point of
 * the demonstration is "here is how your program works", not "here is how your
 * program is checked".
 */
function looksLikeTest(relPath) {
    const p = relPath.toLowerCase().replace(/\\/g, "/");
    return (
        /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(p) ||
        /(\.|_|\/)(test|spec)\.[^./]+$/.test(p) ||
        /(^|\/)test_[^/]+$/.test(p)
    );
}

/**
 * A handful of real source files from the project.
 *
 * Supplied so the agent does not have to go hunting, and - more importantly -
 * so the demonstration lands on something worth looking at. A first impression
 * built around a lock file is worse than no first impression.
 *
 * Biggest first: size is a crude proxy for "has something to explain", and far
 * better than alphabetical, which reliably picks the least interesting file in
 * the repository.
 */
export function candidateFiles(root, limit = 12) {
    const found = [];

    const walk = (dir, depth) => {
        if (depth > 4 || found.length > 600) return;
        let entries = [];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
                walk(full, depth + 1);
                continue;
            }
            const dot = entry.name.lastIndexOf(".");
            if (dot < 0) continue;
            if (!SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
            try {
                const { size } = statSync(full);
                // Big enough to have structure, small enough to read.
                if (size < 700 || size > 120_000) continue;
                const rel = relative(root, full);
                found.push({ path: rel, size, test: looksLikeTest(rel) });
            } catch {
                /* unreadable, skip */
            }
        }
    };

    walk(root, 0);
    found.sort((a, b) => Number(a.test) - Number(b.test) || b.size - a.size);
    return found.slice(0, limit);
}

/**
 * The prompt behind /porthole example.
 *
 * Written as instructions to the agent rather than as a question from the user,
 * and explicit about the shape of a good demonstration, because "show them what
 * you can do" reliably produces either a wall of prose or a tour of the
 * lockfile.
 */
export function examplePrompt(root, files, connected) {
    const list = files.length
        ? files.map((f) => `  ${f.path}`).join("\n")
        : "  (none found - look for a source file yourself)";

    return [
        "The user ran /porthole example. They want to be SHOWN what porthole can do,",
        "on their own code, rather than told about it. Do this now, without asking",
        "any clarifying questions first.",
        "",
        `Project root: ${root}`,
        connected
            ? "The porthole companion is connected, so tours and annotations will work."
            : "WARNING: the porthole companion extension is not connected. Say so, tell them" +
              "\nto install it with `code --install-extension Lando-00.porthole-companion` and" +
              "\nopen a NEW window, and stop there.",
        "",
        "Some real source files in this project, largest first:",
        list,
        "",
        "Do this:",
        "",
        "1. Pick ONE of those files that looks like it has some actual logic - a",
        "   module with a few distinct responsibilities is ideal. Read it properly",
        "   before saying anything about it. Do not guess at line numbers.",
        "",
        "2. Call porthole_tour to build a 3-4 step walkthrough of how that file",
        "   works. Give it a title. Each step needs a real range, a short stepTitle,",
        "   and narration that says something a reader would not get from the code",
        "   alone - why it is like that, what it protects against, what would break.",
        "   This is the thing being demonstrated, so make the narration good.",
        "",
        "3. Then call porthole_annotate on one or two lines elsewhere in the same",
        "   file - something worth flagging, like a subtlety or an assumption - so",
        "   they can see that annotations and tours are different tools.",
        "",
        "4. In your reply, keep it SHORT. Tell them:",
        "     - what you picked and why",
        "     - that the narration is in the CodeLens above the code, and Alt+] and",
        "       Alt+[ step through it",
        "     - that the porthole sidebar lists every tour, and the Problems panel",
        "       shows all their steps at once",
        "     - that they can ask for several tours at once for a pull request, one",
        "       per thread",
        "     - that /porthole help lists everything else",
        "",
        "Do not paste the code back at them - the whole point is that it is already",
        "on screen, marked up. Do not create more than one tour.",
    ].join("\n");
}

/**
 * Injects the demonstration prompt.
 *
 * Enqueued rather than sent immediately, for the same reason the reverse
 * channel enqueues: a slash command should never cut across a turn that is
 * already running.
 */
export async function example(session) {
    const root = projectRoot(process.cwd());
    if (!root || !existsSync(root)) {
        return "porthole: could not work out which project this is.";
    }

    const connected = findCompanions().length > 0;
    const files = candidateFiles(root);

    try {
        await session.send({ prompt: examplePrompt(root, files, connected), mode: "enqueue" });
    } catch (err) {
        return `porthole: could not ask Copilot to demonstrate - ${err?.message || err}`;
    }

    return connected
        ? "porthole: asking Copilot to walk you through some of this project..."
        : "porthole: the companion extension is not connected - Copilot will explain what to do.";
}
