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
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Resolve-ProjectRoot {
    param([string]$Start)

    if (-not $Start) { $Start = (Get-Location).Path }
    if (-not (Test-Path -LiteralPath $Start)) {
        throw "Project path does not exist: $Start"
    }
    $Start = (Resolve-Path -LiteralPath $Start).Path

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $Start }

    # --show-toplevel from the cwd returns the *worktree* root, which is what we
    # want: linked worktrees resolve to themselves, not the main repository.
    # git writes to stderr outside a repo, which $ErrorActionPreference='Stop'
    # would otherwise promote to a terminating NativeCommandError.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $top = & git -C $Start rev-parse --show-toplevel 2>$null
        $ok = ($LASTEXITCODE -eq 0)
    }
    finally {
        $ErrorActionPreference = $prevEap
    }

    if ($ok -and $top) {
        return (Resolve-Path -LiteralPath ($top | Select-Object -First 1)).Path
    }
    return $Start
}

function Get-CopilotHome {
    if ($env:COPILOT_HOME -and (Test-Path -LiteralPath $env:COPILOT_HOME)) {
        return (Resolve-Path -LiteralPath $env:COPILOT_HOME).Path
    }
    return (Join-Path $HOME '.copilot')
}

function Resolve-SessionFolder {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            throw "Session path does not exist: $Explicit"
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $stateRoot = Join-Path (Get-CopilotHome) 'session-state'
    if (-not (Test-Path -LiteralPath $stateRoot)) { return $null }

    $latest = Get-ChildItem -LiteralPath $stateRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($latest) { return $latest.FullName }
    return $null
}

function Resolve-EditorCommand {
    param([string]$Preference)

    $insiders = Get-Command 'code-insiders' -ErrorAction SilentlyContinue
    $stable = Get-Command 'code' -ErrorAction SilentlyContinue

    switch ($Preference) {
        'insiders' {
            if ($insiders) { return $insiders.Source }
            throw "VS Code Insiders ('code-insiders') was not found on PATH."
        }
        'code' {
            if ($stable) { return $stable.Source }
            throw "VS Code ('code') was not found on PATH."
        }
        default {
            if ($insiders) { return $insiders.Source }
            if ($stable) { return $stable.Source }
            throw "Neither 'code-insiders' nor 'code' was found on PATH. Install VS Code or add its 'bin' directory to PATH."
        }
    }
}

try {

$projectRoot = Resolve-ProjectRoot -Start $ProjectPath
$projectName = Split-Path -Leaf $projectRoot
$sessionFolder = Resolve-SessionFolder -Explicit $SessionPath

$folders = @(
    [ordered]@{ path = $projectRoot; name = $projectName }
)

if ($sessionFolder) {
    $sessionId = Split-Path -Leaf $sessionFolder
    $shortId = if ($sessionId.Length -gt 8) { $sessionId.Substring(0, 8) } else { $sessionId }
    $folders += [ordered]@{ path = $sessionFolder; name = "Copilot Session ($shortId)" }
}
else {
    Write-Warning "No Copilot session folder found; opening the project folder only."
    $sessionId = 'no-session'
}

$workspace = [ordered]@{
    folders = $folders
}

# Written outside the project so it is never accidentally committed. The name is
# deterministic per project+session, so re-running reuses the same workspace file
# and VS Code focuses the existing window instead of opening duplicates.
$outDir = Join-Path ([IO.Path]::GetTempPath()) 'opensession-workspaces'
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$safeName = ($projectName -replace '[^\w.-]', '_')
$shortSession = if ($sessionId.Length -gt 8) { $sessionId.Substring(0, 8) } else { $sessionId }
$workspaceFile = Join-Path $outDir "$safeName-$shortSession.code-workspace"

# Write UTF-8 without a BOM; Set-Content -Encoding UTF8 emits a BOM on Windows
# PowerShell 5.1, which some JSON consumers reject.
$json = $workspace | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($workspaceFile, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Project  : $projectRoot"
if ($sessionFolder) { Write-Host "Session  : $sessionFolder" }
Write-Host "Workspace: $workspaceFile"

if ($DryRun) {
    Write-Host "-DryRun specified; editor not launched."
    exit 0
}

$editorCmd = Resolve-EditorCommand -Preference $Editor
Write-Host "Launching: $editorCmd"

# Start-Process (not the call operator) so the editor's .cmd shim does not hold
# this script open — the caller gets control back immediately.
Start-Process -FilePath $editorCmd -ArgumentList "`"$workspaceFile`"" -WindowStyle Hidden

Write-Host "Opened '$projectName' + Copilot session folder in one workspace."

}
catch {
    # Report a single clean line rather than a PowerShell stack trace, so the
    # calling agent can relay the problem verbatim.
    Write-Host "open-session: $($_.Exception.Message)"
    exit 1
}
