// The porthole sidebar: what the agent is working on, without leaving the
// editor.
//
// Two views. "Session" answers where am I - which session, which project,
// which branch, what has been checkpointed. "Tasks" mirrors the todo list the
// agent is working through, grouped by status.
//
// Refreshing is deliberately event-driven: on demand, when a view becomes
// visible, and when the window regains focus. No file watcher and no polling,
// so an idle window costs nothing.

const vscode = require("vscode");

const { findSession, describeSession, readTodos } = require("./session");

const STATUS_ORDER = ["in_progress", "pending", "blocked", "done"];

const STATUS_STYLE = {
    in_progress: { icon: "debug-start", color: "charts.blue", label: "in progress" },
    pending: { icon: "circle-outline", color: "charts.yellow", label: "pending" },
    blocked: { icon: "circle-slash", color: "charts.red", label: "blocked" },
    done: { icon: "pass-filled", color: "charts.green", label: "done" },
};

class Node extends vscode.TreeItem {
    constructor(label, collapsibleState, options = {}) {
        super(label, collapsibleState);
        Object.assign(this, options);
    }
}

function themed(icon, color) {
    return new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
}

function openFileCommand(path, title) {
    return {
        command: "vscode.open",
        title: title || "Open",
        arguments: [vscode.Uri.file(path)],
    };
}

// ---------------------------------------------------------------------------
// Session view
// ---------------------------------------------------------------------------

class SessionProvider {
    constructor() {
        this._changed = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._changed.event;
    }

    refresh() {
        this._changed.fire();
    }

    getTreeItem(item) {
        return item;
    }

    getChildren(parent) {
        if (parent) return [];

        const session = findSession();
        if (!session) return [];

        const info = describeSession(session);
        const items = [];

        items.push(
            new Node(`session ${info.id.slice(0, 8)}`, vscode.TreeItemCollapsibleState.None, {
                description: info.source === "workspace" ? "in this workspace" : "in use",
                tooltip: info.dir,
                iconPath: themed("circuit-board"),
                command: {
                    command: "revealFileInOS",
                    title: "Reveal the session folder",
                    arguments: [vscode.Uri.file(info.dir)],
                },
            }),
        );

        if (info.project) {
            items.push(
                new Node(basename(info.project), vscode.TreeItemCollapsibleState.None, {
                    description: info.branch ? `on ${info.branch}` : undefined,
                    tooltip: info.project,
                    iconPath: themed("repo"),
                }),
            );
        }

        items.push(
            new Node("plan.md", vscode.TreeItemCollapsibleState.None, {
                description: info.planPath ? undefined : "none yet",
                iconPath: themed("notebook"),
                command: info.planPath ? openFileCommand(info.planPath, "Open the plan") : undefined,
            }),
        );

        items.push(
            new Node(
                `checkpoints (${info.checkpoints.length})`,
                vscode.TreeItemCollapsibleState.None,
                {
                    description: info.latestCheckpoint ? "open the latest" : "none yet",
                    iconPath: themed("history"),
                    command: info.latestCheckpoint
                        ? openFileCommand(info.latestCheckpoint, "Open the latest checkpoint")
                        : undefined,
                },
            ),
        );

        return items;
    }
}

// ---------------------------------------------------------------------------
// Tasks view
// ---------------------------------------------------------------------------

class TasksProvider {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this._changed = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._changed.event;
    }

    refresh() {
        this._changed.fire();
    }

    getTreeItem(item) {
        return item;
    }

    async getChildren(parent) {
        if (parent && parent.children) return parent.children;
        if (parent) return [];

        const session = findSession();
        if (!session) return [];

        const info = describeSession(session);
        if (!info.dbPath) {
            return [
                new Node("no task list in this session", vscode.TreeItemCollapsibleState.None, {
                    iconPath: themed("info"),
                }),
            ];
        }

        const data = await readTodos(info.dbPath, this.extensionUri);
        if (!data) {
            return [
                new Node("could not read session.db", vscode.TreeItemCollapsibleState.None, {
                    description: "needs Node 22+ on PATH",
                    tooltip:
                        "porthole reads the task list with node:sqlite, either in the editor's " +
                        "own runtime or via `node` on your PATH. Neither was available.",
                    iconPath: themed("warning", "charts.yellow"),
                }),
            ];
        }

        if (data.todos.length === 0) {
            return [
                new Node("no tasks yet", vscode.TreeItemCollapsibleState.None, {
                    iconPath: themed("info"),
                }),
            ];
        }

        const depsByTodo = new Map();
        for (const dep of data.deps) {
            if (!depsByTodo.has(dep.todo_id)) depsByTodo.set(dep.todo_id, []);
            depsByTodo.get(dep.todo_id).push(dep.depends_on);
        }

        const groups = [];
        for (const status of STATUS_ORDER) {
            const todos = data.todos.filter((t) => t.status === status);
            if (todos.length === 0) continue;

            const style = STATUS_STYLE[status];
            const children = todos.map((todo) => this.taskNode(todo, depsByTodo.get(todo.id)));

            groups.push(
                new Node(
                    `${style.label} (${todos.length})`,
                    // Everything except the finished work is worth seeing at a
                    // glance; done is history.
                    status === "done"
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.Expanded,
                    { iconPath: themed(style.icon, style.color), children, contextValue: "group" },
                ),
            );
        }

        // Any status the CLI invents later still shows up rather than vanishing.
        const known = new Set(STATUS_ORDER);
        const others = data.todos.filter((t) => !known.has(t.status));
        if (others.length > 0) {
            groups.push(
                new Node(`other (${others.length})`, vscode.TreeItemCollapsibleState.Collapsed, {
                    iconPath: themed("question"),
                    children: others.map((todo) => this.taskNode(todo, depsByTodo.get(todo.id))),
                }),
            );
        }

        return groups;
    }

    taskNode(todo, deps) {
        const style = STATUS_STYLE[todo.status] || { icon: "question", color: undefined };
        const children = (deps || []).map(
            (id) =>
                new Node(`depends on: ${id}`, vscode.TreeItemCollapsibleState.None, {
                    iconPath: themed("arrow-small-right"),
                }),
        );

        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = false;
        tooltip.appendMarkdown(`**${todo.title}**\n\n`);
        if (todo.description) tooltip.appendMarkdown(`${todo.description}\n\n`);
        tooltip.appendMarkdown(`\`${todo.id}\` · ${todo.status} · updated ${todo.updated_at}`);

        return new Node(
            todo.title,
            children.length
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            {
                id: `task-${todo.id}`,
                description: todo.id,
                tooltip,
                iconPath: themed(style.icon, style.color),
                children,
                contextValue: "task",
            },
        );
    }
}

function basename(p) {
    return String(p).split(/[\\/]/).filter(Boolean).pop();
}

function activate(context) {
    const sessionProvider = new SessionProvider();
    const tasksProvider = new TasksProvider(context.extensionUri);

    const sessionView = vscode.window.createTreeView("porthole.session", {
        treeDataProvider: sessionProvider,
    });
    const tasksView = vscode.window.createTreeView("porthole.tasks", {
        treeDataProvider: tasksProvider,
    });

    const refresh = () => {
        sessionProvider.refresh();
        tasksProvider.refresh();
    };

    context.subscriptions.push(
        sessionView,
        tasksView,
        vscode.commands.registerCommand("porthole.refresh", refresh),
        // Cheap, event-driven freshness instead of a watcher.
        sessionView.onDidChangeVisibility((e) => e.visible && sessionProvider.refresh()),
        tasksView.onDidChangeVisibility((e) => e.visible && tasksProvider.refresh()),
        vscode.window.onDidChangeWindowState((e) => e.focused && refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    );

    return { refresh };
}

module.exports = { activate };
