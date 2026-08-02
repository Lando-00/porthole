// Standalone session.db reader.
//
// Run by the extension when the host's own SQLite is unavailable:
//
//   node media/read-session-db.js <path to session.db>
//
// Prints one JSON object to stdout. Kept dependency-free and separate so it can
// be executed by whatever `node` is on PATH, which is not the same runtime as
// the extension host.

const { DatabaseSync } = require("node:sqlite");

function main() {
    const file = process.argv[2];
    if (!file) {
        process.stdout.write(JSON.stringify({ error: "missing database path" }));
        return;
    }

    // Read-only: the Copilot CLI owns the writer.
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        process.stdout.write(JSON.stringify(read(db)));
    } finally {
        db.close();
    }
}

function read(db) {
    const tables = new Set(
        db
            .prepare("select name from sqlite_master where type = 'table'")
            .all()
            .map((r) => r.name),
    );

    return {
        todos: tables.has("todos")
            ? db.prepare("select id, title, description, status, created_at, updated_at from todos").all()
            : [],
        deps: tables.has("todo_deps")
            ? db.prepare("select todo_id, depends_on from todo_deps").all()
            : [],
    };
}

try {
    main();
} catch (err) {
    process.stdout.write(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
}
