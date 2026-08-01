<#
.SYNOPSIS
    Opens every file changed on a branch (or PR range) as diffs in VS Code.

.DESCRIPTION
    Compares the current branch against a base branch using their merge-base, so
    you see only what this branch actually changed - not unrelated commits that
    landed on the base since you branched. Delegates the heavy lifting to
    vsdiff.ps1, which materialises both sides and launches the editor detached.

.PARAMETER Base
    Base branch to compare against. Defaults to the first of origin/main,
    origin/master, main, or master that exists.

.PARAMETER Head
    Branch/commit under review. Defaults to HEAD.

.PARAMETER MaxFiles
    Safety cap on how many diff tabs to open. Default 10.

.PARAMETER Path
    Optional path filter.

.PARAMETER ProjectPath
    Repository/worktree root.

.PARAMETER Editor
    'auto' (default, prefers Insiders), 'insiders', or 'code'.

.PARAMETER DryRun
    List what would open without launching an editor.
#>
[CmdletBinding()]
param(
    [string]$Base,
    [string]$Head = 'HEAD',
    [int]$MaxFiles = 10,
    [string]$Path,
    [string]$ProjectPath,
    [ValidateSet('auto', 'insiders', 'code')]
    [string]$Editor = 'auto',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

try {
    $repoRoot = Resolve-ProjectRoot -Start $ProjectPath
    Assert-GitRepo -RepoRoot $repoRoot

    if (-not $Base) {
        foreach ($candidate in @('origin/main', 'origin/master', 'main', 'master')) {
            $null = Invoke-Git -RepoRoot $repoRoot -GitArgs @('rev-parse', '--verify', '--quiet', $candidate)
            if ($script:GitExitCode -eq 0) { $Base = $candidate; break }
        }
    }
    if (-not $Base) {
        throw "Could not determine a base branch. Pass -Base <branch> explicitly."
    }

    $null = Invoke-Git -RepoRoot $repoRoot -GitArgs @('rev-parse', '--verify', '--quiet', $Base)
    if ($script:GitExitCode -ne 0) { throw "Base branch not found: $Base" }

    # merge-base keeps the review limited to this branch's own changes.
    $mergeBase = Invoke-Git -RepoRoot $repoRoot -GitArgs @('merge-base', $Base, $Head)
    if ($script:GitExitCode -ne 0 -or -not $mergeBase) {
        throw "Could not find a merge base between '$Base' and '$Head'."
    }
    $mergeBase = ($mergeBase | Select-Object -First 1).Trim()

    $headSha = (Invoke-Git -RepoRoot $repoRoot -GitArgs @('rev-parse', '--short', $Head) | Select-Object -First 1)
    Write-Host "Reviewing : $Head ($headSha)"
    Write-Host "Against   : $Base"
    Write-Host "Merge base: $(Get-ShortId $mergeBase 8)"

    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'vsdiff.ps1'),
        '-Ref', "$mergeBase..$Head",
        '-MaxFiles', $MaxFiles,
        '-ProjectPath', $repoRoot,
        '-Editor', $Editor
    )
    if ($Path) { $argList += @('-Path', $Path) }
    if ($DryRun) { $argList += '-DryRun' }

    & powershell @argList
    exit $LASTEXITCODE
}
catch {
    Write-Host "porthole review: $($_.Exception.Message)"
    exit 1
}
