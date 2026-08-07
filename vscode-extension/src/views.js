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
const tour = require("./tour");

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

// ---------------------------------------------------------------------------
// Tour view
// ---------------------------------------------------------------------------

/**
 * The library, and the active tour's path within it.
 *
 * The CodeLens shows one step in context; this shows the shape of every
 * explanation currently loaded, which is what tells you a pull request has
 * three threads and which one you are half-way through.
 */
class TourProvider {
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

    getChildren(item) {
        if (item) return item.children || [];

        const { tours, activeTourId } = tour.getLibrary();
        if (tours.length === 0) {
            return [
                new Node("No tours loaded", vscode.TreeItemCollapsibleState.None, {
                    iconPath: themed("compass"),
                    description: "ask Copilot to walk you through some code",
                }),
            ];
        }

        // A single tour needs no folder to sit in - showing its steps directly
        // is what it did before there was a library, and it is still right.
        if (tours.length === 1) return this.tourNode(tours[0], activeTourId).children;

        return tours.map((t) => this.tourNode(t, activeTourId));
    }

    tourNode(entry, activeTourId) {
        const isActive = entry.tourId === activeTourId;
        const children = entry.steps.map((step) =>
            this.stepNode(step, isActive ? entry.current : -1, entry.steps.length, entry.tourId),
        );

        const drifted = entry.steps.filter(
            (s) => s.status === "changed" || s.status === "missing",
        ).length;
        const description = isActive
            ? `${entry.current + 1}/${entry.steps.length}`
            : `${entry.steps.length} steps`;

        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = false;
        tooltip.appendMarkdown(`**${entry.title}**\n\n`);
        tooltip.appendMarkdown(`\`${entry.tourId}\` · ${entry.steps.length} steps`);
        if (entry.branch) tooltip.appendMarkdown(` · ${entry.branch}`);
        if (drifted > 0) {
            tooltip.appendMarkdown(
                `\n\n⚠ ${drifted} step${drifted === 1 ? "" : "s"} no longer match the code they were written about.`,
            );
        }

        return new Node(entry.title, vscode.TreeItemCollapsibleState[isActive ? "Expanded" : "Collapsed"], {
            id: `tour-${entry.tourId}`,
            description: drifted > 0 ? `${description} · ${drifted} stale` : description,
            tooltip,
            iconPath: themed(
                isActive ? "play-circle" : drifted > 0 ? "warning" : "compass",
                isActive ? "charts.blue" : drifted > 0 ? "charts.yellow" : undefined,
            ),
            children,
            // Drives the context menu: only an inactive tour offers "activate",
            // only the active one offers "close".
            contextValue: isActive ? "tourActive" : "tourInactive",
            command: isActive
                ? undefined
                : {
                      command: "porthole.tour.activate",
                      title: "Walk this tour",
                      arguments: [entry.tourId],
                  },
        });
    }

    stepNode(step, current, total, tourId) {
        const state =
            current < 0
                ? "pending"
                : step.index === current
                  ? "current"
                  : step.index < current
                    ? "visited"
                    : "pending";
        const style = {
            current: { icon: "play", color: "charts.blue" },
            visited: { icon: "pass-filled", color: "charts.green" },
            pending: { icon: "circle-outline", color: undefined },
        }[state];

        // Drift outranks position: a step that no longer describes its code -
        // or whose file is not even here - is the most important thing to know
        // about it.
        const icon =
            step.status === "missing"
                ? "circle-slash"
                : step.status === "changed"
                  ? "warning"
                  : style.icon;
        const color =
            step.status === "missing"
                ? "charts.red"
                : step.status === "changed"
                  ? "charts.yellow"
                  : style.color;

        const node = new Node(
            `${step.index + 1}. ${step.stepTitle}`,
            vscode.TreeItemCollapsibleState.None,
            {
                id: `tour-${tourId}-step-${step.index}`,
                iconPath: themed(icon, color),
                description:
                    step.status === "missing"
                        ? `${basename(step.file)} — not in this checkout`
                        : `${basename(step.file)}:${step.startLine}`,
                command: {
                    command: "porthole.tour.jump",
                    title: "Go to step",
                    arguments: [tourId, step.index],
                },
                contextValue: "tourStep",
            },
        );

        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = false; // model-written text
        tooltip.appendMarkdown(`**Step ${step.index + 1}/${total}** · ${step.stepTitle}\n\n`);
        if (step.narration) tooltip.appendMarkdown(step.narration);
        if (step.status === "shifted") {
            tooltip.appendMarkdown("\n\n_(this code moved since the tour was saved)_");
        } else if (step.status === "changed") {
            tooltip.appendMarkdown(
                "\n\n_(the code here has changed since the tour was saved, so this step may no longer apply)_",
            );
        } else if (step.status === "missing") {
            tooltip.appendMarkdown(
                `\n\n_(${step.file} is not in this checkout - a different branch, perhaps)_`,
            );
        }
        node.tooltip = tooltip;

        return node;
    }
}

function activate(context) {
    const sessionProvider = new SessionProvider();
    const tasksProvider = new TasksProvider(context.extensionUri);
    const tourProvider = new TourProvider();

    const sessionView = vscode.window.createTreeView("porthole.session", {
        treeDataProvider: sessionProvider,
    });
    const tasksView = vscode.window.createTreeView("porthole.tasks", {
        treeDataProvider: tasksProvider,
    });
    const tourView = vscode.window.createTreeView("porthole.tour", {
        treeDataProvider: tourProvider,
    });

    const refresh = () => {
        sessionProvider.refresh();
        tasksProvider.refresh();
    };

    context.subscriptions.push(
        sessionView,
        tasksView,
        tourView,
        vscode.commands.registerCommand("porthole.refresh", refresh),
        // The tour drives this view, not the other way round, so it refreshes
        // from the tour's own state changes rather than on a timer.
        tour.onDidChangeState(() => tourProvider.refresh()),
        // Cheap, event-driven freshness instead of a watcher.
        sessionView.onDidChangeVisibility((e) => e.visible && sessionProvider.refresh()),
        tasksView.onDidChangeVisibility((e) => e.visible && tasksProvider.refresh()),
        vscode.window.onDidChangeWindowState((e) => e.focused && refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    );

    return { refresh };
}

module.exports = { activate };
