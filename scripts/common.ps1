<#
.SYNOPSIS
    Shared helpers for the porthole plugin. Dot-source this from command scripts:
        . "$PSScriptRoot\common.ps1"
#>

function Resolve-ProjectRoot {
    param([string]$Start)

    if (-not $Start) { $Start = (Get-Location).Path }
    if (-not (Test-Path -LiteralPath $Start)) {
        throw "Project path does not exist: $Start"
    }
    $Start = (Resolve-Path -LiteralPath $Start).Path

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $Start }

    # --show-toplevel from the cwd returns the *worktree* root, so linked
    # worktrees resolve to themselves rather than the main repository.
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
    param([string]$Preference = 'auto')

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
            # Insiders is the preferred default.
            if ($insiders) { return $insiders.Source }
            if ($stable) { return $stable.Source }
            throw "Neither 'code-insiders' nor 'code' was found on PATH. Install VS Code or add its 'bin' directory to PATH."
        }
    }
}

function Get-ConnectedIdes {
    <#
        Reads the Copilot CLI's IDE lock files.

        The CLI writes one *.lock JSON file per connected IDE window into
        <copilot home>/ide/, containing ideName, pid, workspaceFolders,
        socketPath and isTrusted. It treats a lock as live only when the PID is
        still running, so we apply the same check.

        Returns objects: IdeName, Pid, WorkspaceFolders, LockFile.
    #>
    $ideDir = Join-Path (Get-CopilotHome) 'ide'
    if (-not (Test-Path -LiteralPath $ideDir)) { return @() }

    $result = @()
    foreach ($lock in (Get-ChildItem -LiteralPath $ideDir -Filter '*.lock' -File -ErrorAction SilentlyContinue)) {
        try {
            $info = Get-Content -LiteralPath $lock.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
        }
        catch { continue }

        if (-not $info.pid) { continue }
        if (-not (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) { continue }

        $folders = @()
        if ($info.workspaceFolders) { $folders = @($info.workspaceFolders) }

        $result += [pscustomobject]@{
            IdeName          = [string]$info.ideName
            Pid              = [int]$info.pid
            WorkspaceFolders = $folders
            LockFile         = $lock.FullName
        }
    }
    return $result
}

function Get-IdeEditorCommand {
    <#
        Maps a Copilot ideName to a launcher on PATH. Returns $null when the IDE
        has no usable CLI, so callers can fall back.
    #>
    param([Parameter(Mandatory)][string]$IdeName)

    $map = @{
        'vscode-insiders' = @('code-insiders')
        'vscode'          = @('code')
        'cursor'          = @('cursor')
        'windsurf'        = @('windsurf')
    }

    $candidates = $map[$IdeName.ToLower()]
    if (-not $candidates) { return $null }

    foreach ($c in $candidates) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

function Get-UserSettingsPath {
    <#
        Locates the VS Code user settings.json for the given flavour.
    #>
    param([ValidateSet('insiders', 'code')][string]$Flavour = 'insiders')

    $dirName = if ($Flavour -eq 'insiders') { 'Code - Insiders' } else { 'Code' }

    if ($IsMacOS) { $base = Join-Path $HOME "Library/Application Support/$dirName/User" }
    elseif ($IsLinux) { $base = Join-Path $HOME ".config/$dirName/User" }
    else { $base = Join-Path $env:APPDATA "$dirName\User" }

    return (Join-Path $base 'settings.json')
}

function Test-UserPreviewAssociation {
    <#
        True when the user's VS Code settings already map *.diagram.md to the
        markdown preview editor, meaning diagrams render in any window.
    #>
    foreach ($flavour in @('insiders', 'code')) {
        $path = Get-UserSettingsPath -Flavour $flavour
        if (-not (Test-Path -LiteralPath $path)) { continue }
        try {
            $raw = Get-Content -LiteralPath $path -Raw
            # settings.json is JSONC; strip line comments before parsing.
            $stripped = [regex]::Replace($raw, '(?m)^\s*//.*$', '')
            $json = $stripped | ConvertFrom-Json
            $assoc = $json.'workbench.editorAssociations'
            if ($assoc -and $assoc.'*.diagram.md') { return $true }
        }
        catch { continue }
    }
    return $false
}

function Resolve-EditorTarget {
    <#
        Decides which editor to drive and whether a window already exists.

        When Copilot CLI is connected to an IDE, commands must reuse that window
        rather than launching another instance. An explicit -Editor preference
        always wins.

        Returns: Command, ReuseWindow, IdeName, Connected, MatchedWorkspace.
    #>
    param(
        [string]$Preference = 'auto',
        [string]$ContextPath
    )

    if ($Preference -ne 'auto') {
        return [pscustomobject]@{
            Command          = Resolve-EditorCommand -Preference $Preference
            ReuseWindow      = $true
            IdeName          = $null
            Connected        = $false
            MatchedWorkspace = $null
        }
    }

    $ides = @(Get-ConnectedIdes)
    if ($ides.Count -gt 0) {
        $chosen = $null
        $matched = $null

        if ($ContextPath -and (Test-Path -LiteralPath $ContextPath)) {
            $ctx = (Resolve-Path -LiteralPath $ContextPath).Path.TrimEnd('\', '/')
            foreach ($ide in $ides) {
                foreach ($wf in $ide.WorkspaceFolders) {
                    if (-not $wf) { continue }
                    $norm = ([string]$wf).TrimEnd('\', '/')
                    # Match the workspace root itself or any ancestor of it.
                    if ($ctx -eq $norm -or $ctx.StartsWith($norm + [IO.Path]::DirectorySeparatorChar, 'OrdinalIgnoreCase') -or $norm.StartsWith($ctx + [IO.Path]::DirectorySeparatorChar, 'OrdinalIgnoreCase')) {
                        $chosen = $ide; $matched = $norm; break
                    }
                }
                if ($chosen) { break }
            }
        }

        if (-not $chosen) { $chosen = $ides[0] }

        $cmd = Get-IdeEditorCommand -IdeName $chosen.IdeName
        if ($cmd) {
            return [pscustomobject]@{
                Command          = $cmd
                ReuseWindow      = $true
                IdeName          = $chosen.IdeName
                Connected        = $true
                MatchedWorkspace = $matched
            }
        }
    }

    return [pscustomobject]@{
        Command          = Resolve-EditorCommand -Preference 'auto'
        ReuseWindow      = $true
        IdeName          = $null
        Connected        = $false
        MatchedWorkspace = $null
    }
}

function Invoke-Editor {
    <#
        Launches the editor detached. Never use the call operator here: a .cmd
        shim holds the script open until the editor exits, which hangs the
        calling agent.
    #>
    param(
        [Parameter(Mandatory)][string]$EditorCommand,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $quoted = $Arguments | ForEach-Object { '"{0}"' -f $_ }
    Start-Process -FilePath $EditorCommand -ArgumentList $quoted -WindowStyle Hidden
}

function Get-PortholeTempDir {
    param([string]$Leaf = 'porthole')

    $dir = Join-Path ([IO.Path]::GetTempPath()) $Leaf
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Write-JsonFile {
    <#
        Writes UTF-8 without a BOM. Set-Content -Encoding UTF8 emits a BOM on
        Windows PowerShell 5.1, which some JSON consumers reject.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Object
    )

    $json = $Object | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function ConvertTo-SafeName {
    param([Parameter(Mandatory)][string]$Value)
    return ($Value -replace '[^\w.-]', '_')
}

function Get-ShortId {
    param([string]$Value, [int]$Length = 8)
    if (-not $Value) { return 'none' }
    if ($Value.Length -gt $Length) { return $Value.Substring(0, $Length) }
    return $Value
}

function Invoke-Git {
    <#
        Runs git and returns its stdout lines, suppressing the stderr-to-terminating-error
        promotion. Sets $script:GitExitCode.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string[]]$GitArgs
    )

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $out = & git -C $RepoRoot @GitArgs 2>$null
        $script:GitExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
    return $out
}

function Assert-GitRepo {
    param([Parameter(Mandatory)][string]$RepoRoot)

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git was not found on PATH."
    }
    $null = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('rev-parse', '--git-dir')
    if ($script:GitExitCode -ne 0) {
        throw "Not a git repository: $RepoRoot"
    }
}

function Export-GitFileVersion {
    <#
        Materialises one side of a diff to a real file on disk.

        This is deliberate: `git difftool` blocks until the editor closes, because
        git deletes its temp files as soon as the command returns. Writing the
        sides ourselves lets the editor launch detached.

        $Ref of '' (empty) means the working tree. Returns the written path, or
        $null when the file does not exist at that ref (added/deleted files).
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$RelPath,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Ref,
        [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][string]$Label
    )

    $leaf = Split-Path -Leaf $RelPath
    $target = Join-Path $OutDir ("{0}.{1}" -f $Label, $leaf)

    if ($Ref -eq '') {
        $src = Join-Path $RepoRoot $RelPath
        if (-not (Test-Path -LiteralPath $src)) { return $null }
        Copy-Item -LiteralPath $src -Destination $target -Force
        return $target
    }

    $content = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('show', "${Ref}:${RelPath}")
    if ($script:GitExitCode -ne 0) { return $null }

    $text = if ($null -eq $content) { '' } else { ($content -join "`n") }
    [IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($false)))
    return $target
}

function New-EmptyPlaceholder {
    param(
        [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$RelPath
    )

    $leaf = Split-Path -Leaf $RelPath
    $target = Join-Path $OutDir ("{0}.{1}" -f $Label, $leaf)
    [IO.File]::WriteAllText($target, '', (New-Object System.Text.UTF8Encoding($false)))
    return $target
}
