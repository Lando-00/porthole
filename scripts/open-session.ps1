<#
.SYNOPSIS
    Opens the current project/worktree and the current Copilot CLI session folder
    together in a single VS Code (or VS Code Insiders) workspace.

.PARAMETER SessionPath
    Absolute path to the current Copilot CLI session folder. When omitted, the
    most recently modified folder under the Copilot session-state directory is used.

.PARAMETER ProjectPath
    Project/worktree root. Defaults to the current directory, resolved to the git
    worktree root when inside a repository.

.PARAMETER Editor
    Which editor to launch: 'auto' (default, prefers Insiders), 'insiders', or 'code'.

.PARAMETER DryRun
    Build and report the workspace file without launching an editor.
#>
[CmdletBinding()]
param(
    [string]$SessionPath,
    [string]$ProjectPath,
    [ValidateSet('auto', 'insiders', 'code')]
    [string]$Editor = 'auto',
    [switch]$ForceWorkspace,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

try {
    $projectRoot = Resolve-ProjectRoot -Start $ProjectPath
    $projectName = Split-Path -Leaf $projectRoot
    $sessionFolder = Resolve-SessionFolder -Explicit $SessionPath

    $folders = @(
        [ordered]@{ path = $projectRoot; name = $projectName }
    )

    if ($sessionFolder) {
        $sessionId = Split-Path -Leaf $sessionFolder
        $folders += [ordered]@{
            path = $sessionFolder
            name = "Copilot Session ($(Get-ShortId $sessionId))"
        }
    }
    else {
        Write-Warning "No Copilot session folder found; opening the project folder only."
        $sessionId = 'no-session'
    }

    $workspace = [ordered]@{
        folders  = $folders
        settings = [ordered]@{
            # Makes diagrams written by /diagram open rendered rather than as source.
            'workbench.editorAssociations' = [ordered]@{
                '*.diagram.md' = 'vscode.markdown.preview.editor'
            }
        }
    }

    # Written outside the project so it is never accidentally committed. The name
    # is deterministic per project+session, so re-running reuses the same workspace
    # file and VS Code focuses the existing window instead of opening duplicates.
    $outDir = Get-PortholeTempDir -Leaf 'porthole-workspaces'
    $workspaceFile = Join-Path $outDir ("{0}-{1}.code-workspace" -f (ConvertTo-SafeName $projectName), (Get-ShortId $sessionId))

    Write-JsonFile -Path $workspaceFile -Object $workspace

    Write-Host "Project  : $projectRoot"
    if ($sessionFolder) { Write-Host "Session  : $sessionFolder" }
    Write-Host "Workspace: $workspaceFile"

    if ($DryRun) {
        Write-Host "-DryRun specified; editor not launched."
        exit 0
    }

    $t = Resolve-EditorTarget -Preference $Editor -ContextPath $projectRoot

    # If an IDE is already connected to this project, adding the session folder to
    # the existing window beats opening a second one on a generated workspace.
    if ($t.Connected -and -not $ForceWorkspace) {
        Write-Host "IDE      : reusing connected $($t.IdeName) window"
        if ($sessionFolder) {
            Invoke-Editor -EditorCommand $t.Command -Arguments @('--reuse-window', '--add', $sessionFolder)
            Write-Host "Added the session folder to the connected window."
        }
        else {
            Write-Host "No session folder to add."
        }
        exit 0
    }

    Write-Host "Launching: $($t.Command)"
    Invoke-Editor -EditorCommand $t.Command -Arguments @($workspaceFile)

    Write-Host "Opened '$projectName' + Copilot session folder in one workspace."
}
catch {
    Write-Host "porthole open-session: $($_.Exception.Message)"
    exit 1
}
