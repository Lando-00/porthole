<#
.SYNOPSIS
    Opens diffs in VS Code / VS Code Insiders, without blocking the caller.

.DESCRIPTION
    `git difftool` cannot be used here: it holds the terminal until the editor is
    closed, because git deletes its temporary files as soon as the command returns.
    This script materialises both sides of each diff into a persistent temp
    directory and launches the editor detached instead.

.PARAMETER Ref
    What to diff. Omit for uncommitted working-tree changes. Otherwise:
      - a commit           e.g. HEAD, 9597b04        (that commit vs its parent)
      - a range            e.g. main..HEAD           (two endpoints)
      - 'staged'/'cached'  the staged changes

.PARAMETER Files
    Two arbitrary file paths to diff directly, bypassing git entirely.

.PARAMETER Path
    Optional path filter limiting which files are diffed.

.PARAMETER MaxFiles
    Safety cap on how many diff tabs to open. Default 10.

.PARAMETER ProjectPath
    Repository/worktree root. Defaults to the current directory.

.PARAMETER Editor
    'auto' (default, prefers Insiders), 'insiders', or 'code'.

.PARAMETER DryRun
    Report what would open without launching an editor.
#>
[CmdletBinding()]
param(
    [string]$Ref,
    [string[]]$Files,
    [string]$Path,
    [int]$MaxFiles = 10,
    [string]$ProjectPath,
    [ValidateSet('auto', 'insiders', 'code')]
    [string]$Editor = 'auto',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

try {
    # ---- Mode 1: two arbitrary files, no git involved ----------------------
    if ($Files) {
        if ($Files.Count -ne 2) {
            throw "-Files expects exactly two paths; got $($Files.Count)."
        }
        foreach ($f in $Files) {
            if (-not (Test-Path -LiteralPath $f)) { throw "File does not exist: $f" }
        }
        $left = (Resolve-Path -LiteralPath $Files[0]).Path
        $right = (Resolve-Path -LiteralPath $Files[1]).Path

        $t = Resolve-EditorTarget -Preference $Editor -ContextPath (Split-Path -Parent $left)
        Write-Host "Diff: $left <-> $right"
        if ($t.Connected) { Write-Host "IDE : reusing connected $($t.IdeName) window" }
        if ($DryRun) { Write-Host "-DryRun specified; editor not launched."; exit 0 }

        Invoke-Editor -EditorCommand $t.Command -Arguments @('--reuse-window', '--diff', $left, $right)
        Write-Host "Opened 1 diff in VS Code."
        exit 0
    }

    # ---- Mode 2: git ------------------------------------------------------
    $repoRoot = Resolve-ProjectRoot -Start $ProjectPath
    Assert-GitRepo -RepoRoot $repoRoot

    $leftRef = ''
    $rightRef = ''
    $description = ''

    if (-not $Ref) {
        # Uncommitted working-tree changes vs HEAD.
        $leftRef = 'HEAD'
        $rightRef = ''
        $description = 'uncommitted changes (HEAD vs working tree)'
        $nameArgs = @('diff', '--name-only', 'HEAD')
    }
    elseif ($Ref -in @('staged', 'cached', '--staged', '--cached')) {
        $leftRef = 'HEAD'
        $rightRef = ':staged'
        $description = 'staged changes (HEAD vs index)'
        $nameArgs = @('diff', '--name-only', '--cached')
    }
    elseif ($Ref -match '\.\.') {
        $parts = $Ref -split '\.\.\.?', 2
        $leftRef = $parts[0]
        $rightRef = $parts[1]
        if (-not $leftRef) { throw "Invalid range: $Ref" }
        if (-not $rightRef) { $rightRef = 'HEAD' }
        $description = "range $leftRef..$rightRef"
        $nameArgs = @('diff', '--name-only', "$leftRef..$rightRef")
    }
    else {
        # A single commit: compare against its first parent.
        $leftRef = "$Ref^"
        $rightRef = $Ref
        $description = "commit $Ref (vs parent)"
        $nameArgs = @('diff', '--name-only', "$Ref^", $Ref)
    }

    if ($Path) { $nameArgs += @('--', $Path) }

    $changed = Invoke-Git -RepoRoot $repoRoot -GitArgs $nameArgs
    if ($script:GitExitCode -ne 0) {
        throw "git could not resolve '$Ref'. Check the commit or range exists."
    }

    $changed = @($changed | Where-Object { $_ -and $_.Trim() })
    if ($changed.Count -eq 0) {
        Write-Host "No changes found for $description."
        exit 0
    }

    Write-Host "Diffing $description"
    Write-Host "Changed files: $($changed.Count)"

    $truncated = $false
    if ($changed.Count -gt $MaxFiles) {
        Write-Warning "Opening the first $MaxFiles of $($changed.Count) files. Pass -MaxFiles to raise the cap, or -Path to narrow."
        $changed = $changed[0..($MaxFiles - 1)]
        $truncated = $true
    }

    if ($DryRun) {
        $changed | ForEach-Object { Write-Host "  $_" }
        Write-Host "-DryRun specified; editor not launched."
        exit 0
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outDir = Join-Path (Get-PortholeTempDir -Leaf 'porthole-diffs') "$stamp-$(ConvertTo-SafeName (Split-Path -Leaf $repoRoot))"
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null

    $editorTarget = Resolve-EditorTarget -Preference $Editor -ContextPath $repoRoot
    $editorCmd = $editorTarget.Command
    if ($editorTarget.Connected) {
        Write-Host "IDE      : reusing connected $($editorTarget.IdeName) window"
    }

    $opened = 0
    foreach ($rel in $changed) {
        $fileDir = Join-Path $outDir (ConvertTo-SafeName ($rel -replace '[\\/]', '_'))
        New-Item -ItemType Directory -Path $fileDir -Force | Out-Null

        $leftPath = Export-GitFileVersion -RepoRoot $repoRoot -RelPath $rel -Ref $leftRef -OutDir $fileDir -Label 'BEFORE'
        if ($rightRef -eq ':staged') {
            # Staged content lives in the index, addressed as :file
            $stagedContent = Invoke-Git -RepoRoot $repoRoot -GitArgs @('show', ":$rel")
            if ($script:GitExitCode -eq 0) {
                $rightPath = Join-Path $fileDir ("AFTER." + (Split-Path -Leaf $rel))
                $txt = if ($null -eq $stagedContent) { '' } else { ($stagedContent -join "`n") }
                [IO.File]::WriteAllText($rightPath, $txt, (New-Object System.Text.UTF8Encoding($false)))
            }
            else { $rightPath = $null }
        }
        else {
            $rightPath = Export-GitFileVersion -RepoRoot $repoRoot -RelPath $rel -Ref $rightRef -OutDir $fileDir -Label 'AFTER'
        }

        # Added or deleted files only exist on one side; use an empty placeholder
        # so the diff still renders instead of failing.
        if (-not $leftPath) { $leftPath = New-EmptyPlaceholder -OutDir $fileDir -Label 'BEFORE' -RelPath $rel }
        if (-not $rightPath) { $rightPath = New-EmptyPlaceholder -OutDir $fileDir -Label 'AFTER' -RelPath $rel }

        Invoke-Editor -EditorCommand $editorCmd -Arguments @('--reuse-window', '--diff', $leftPath, $rightPath)
        Write-Host "  diff: $rel"
        $opened++
        Start-Sleep -Milliseconds 250
    }

    Write-Host "Opened $opened diff(s) in VS Code."
    Write-Host "Sides written to: $outDir"
    if ($truncated) { Write-Host "Note: output was capped at $MaxFiles files." }
}
catch {
    Write-Host "porthole diff: $($_.Exception.Message)"
    exit 1
}
