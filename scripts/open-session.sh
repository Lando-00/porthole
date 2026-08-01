#!/usr/bin/env bash
# Opens the current project/worktree and the current Copilot CLI session folder
# together in a single VS Code (or VS Code Insiders) workspace.
#
# Usage: open-session.sh [--session PATH] [--project PATH] [--editor auto|insiders|code] [--dry-run]

set -euo pipefail

SESSION_PATH=""
PROJECT_PATH=""
EDITOR_PREF="auto"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION_PATH="${2:-}"; shift 2 ;;
    --project) PROJECT_PATH="${2:-}"; shift 2 ;;
    --editor)  EDITOR_PREF="${2:-auto}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- project root -----------------------------------------------------------
if [ -z "$PROJECT_PATH" ]; then PROJECT_PATH="$PWD"; fi
if [ ! -d "$PROJECT_PATH" ]; then
  echo "Project path does not exist: $PROJECT_PATH" >&2
  exit 1
fi
PROJECT_ROOT="$(cd "$PROJECT_PATH" && pwd)"

# --show-toplevel resolves to the *worktree* root, so linked worktrees open
# themselves rather than the main repository.
if command -v git >/dev/null 2>&1; then
  if top="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null)"; then
    [ -n "$top" ] && PROJECT_ROOT="$top"
  fi
fi
PROJECT_NAME="$(basename "$PROJECT_ROOT")"

# --- session folder ---------------------------------------------------------
COPILOT_DIR="${COPILOT_HOME:-$HOME/.copilot}"

if [ -n "$SESSION_PATH" ]; then
  if [ ! -d "$SESSION_PATH" ]; then
    echo "Session path does not exist: $SESSION_PATH" >&2
    exit 1
  fi
  SESSION_FOLDER="$(cd "$SESSION_PATH" && pwd)"
else
  STATE_ROOT="$COPILOT_DIR/session-state"
  SESSION_FOLDER=""
  if [ -d "$STATE_ROOT" ]; then
    SESSION_FOLDER="$(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -type d -exec stat -f '%m %N' {} + 2>/dev/null \
      | sort -rn | head -1 | cut -d' ' -f2- || true)"
    if [ -z "$SESSION_FOLDER" ]; then
      SESSION_FOLDER="$(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2- || true)"
    fi
  fi
fi

# --- build workspace --------------------------------------------------------
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if [ -n "$SESSION_FOLDER" ]; then
  SESSION_ID="$(basename "$SESSION_FOLDER")"
else
  echo "Warning: no Copilot session folder found; opening the project folder only." >&2
  SESSION_ID="no-session"
fi
SHORT_ID="$(printf '%s' "$SESSION_ID" | cut -c1-8)"

OUT_DIR="${TMPDIR:-/tmp}/opensession-workspaces"
mkdir -p "$OUT_DIR"
SAFE_NAME="$(printf '%s' "$PROJECT_NAME" | tr -c '[:alnum:]._-' '_')"
WORKSPACE_FILE="$OUT_DIR/$SAFE_NAME-$SHORT_ID.code-workspace"

{
  printf '{\n  "folders": [\n'
  printf '    { "path": "%s", "name": "%s" }' "$(json_escape "$PROJECT_ROOT")" "$(json_escape "$PROJECT_NAME")"
  if [ -n "$SESSION_FOLDER" ]; then
    printf ',\n    { "path": "%s", "name": "Copilot Session (%s)" }' \
      "$(json_escape "$SESSION_FOLDER")" "$(json_escape "$SHORT_ID")"
  fi
  printf '\n  ]\n}\n'
} > "$WORKSPACE_FILE"

echo "Project  : $PROJECT_ROOT"
[ -n "$SESSION_FOLDER" ] && echo "Session  : $SESSION_FOLDER"
echo "Workspace: $WORKSPACE_FILE"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run specified; editor not launched."
  exit 0
fi

# --- launch editor ----------------------------------------------------------
case "$EDITOR_PREF" in
  insiders)
    command -v code-insiders >/dev/null 2>&1 || { echo "VS Code Insiders ('code-insiders') was not found on PATH." >&2; exit 1; }
    EDITOR_CMD="code-insiders" ;;
  code)
    command -v code >/dev/null 2>&1 || { echo "VS Code ('code') was not found on PATH." >&2; exit 1; }
    EDITOR_CMD="code" ;;
  *)
    if command -v code-insiders >/dev/null 2>&1; then EDITOR_CMD="code-insiders"
    elif command -v code >/dev/null 2>&1; then EDITOR_CMD="code"
    else
      echo "Neither 'code-insiders' nor 'code' was found on PATH. Install VS Code or add its 'bin' directory to PATH." >&2
      exit 1
    fi ;;
esac

echo "Launching: $EDITOR_CMD"
# Detach so the editor does not hold this script open.
nohup "$EDITOR_CMD" "$WORKSPACE_FILE" >/dev/null 2>&1 &
echo "Opened '$PROJECT_NAME' + Copilot session folder in one workspace."
