<#
.SYNOPSIS
    Opens a file in VS Code / VS Code Insiders at a specific line and column.

.PARAMETER Target
    file, file:line, or file:line:column. Relative paths resolve against the
    project root, then the current directory.

.PARAMETER Line
    Line number, when not supplied inside -Target.

.PARAMETER Column
    Column number, when not supplied inside -Target.

.PARAMETER NewWindow
    Open in a new window instead of reusing the current one.

.PARAMETER ProjectPath
    Project/worktree root used to resolve relative paths.

.PARAMETER Editor
    'auto' (default, prefers Insiders), 'insiders', or 'code'.

.PARAMETER DryRun
    Report the resolved target without launching an editor.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Target,
    [int]$Line,
    [int]$Column,
    [switch]$NewWindow,
    [string]$ProjectPath,
    [ValidateSet('auto', 'insiders', 'code')]
    [string]$Editor = 'auto',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

try {
    $filePart = $Target
    $parsedLine = 0
    $parsedCol = 0

    # Split trailing :line[:col], while leaving a Windows drive letter intact.
    if ($Target -match '^(?<f>.+?):(?<l>\d+)(?::(?<c>\d+))?$') {
        $candidate = $Matches['f']
        if ($candidate.Length -gt 1) {
            $filePart = $candidate
            $parsedLine = [int]$Matches['l']
            if ($Matches['c']) { $parsedCol = [int]$Matches['c'] }
        }
    }

    if ($Line -gt 0) { $parsedLine = $Line }
    if ($Column -gt 0) { $parsedCol = $Column }

    $resolved = $null
    if ([IO.Path]::IsPathRooted($filePart) -and (Test-Path -LiteralPath $filePart)) {
        $resolved = (Resolve-Path -LiteralPath $filePart).Path
    }
    else {
        $projectRoot = Resolve-ProjectRoot -Start $ProjectPath
        foreach ($base in @($projectRoot, (Get-Location).Path)) {
            $candidate = Join-Path $base $filePart
            if (Test-Path -LiteralPath $candidate) {
                $resolved = (Resolve-Path -LiteralPath $candidate).Path
                break
            }
        }
    }

    if (-not $resolved) { throw "File not found: $filePart" }

    $gotoArg = $resolved
    if ($parsedLine -gt 0) {
        $gotoArg = "${resolved}:${parsedLine}"
        if ($parsedCol -gt 0) { $gotoArg = "${gotoArg}:${parsedCol}" }
    }

    $where = if ($parsedLine -gt 0) { "line $parsedLine$(if ($parsedCol -gt 0) { ", column $parsedCol" })" } else { 'top of file' }
    Write-Host "File: $resolved"
    Write-Host "At  : $where"

    if ($DryRun) {
        Write-Host "-DryRun specified; editor not launched."
        exit 0
    }

    $t = Resolve-EditorTarget -Preference $Editor -ContextPath (Split-Path -Parent $resolved)
    if ($t.Connected -and -not $NewWindow) {
        Write-Host "IDE : reusing connected $($t.IdeName) window"
    }
    $windowArg = if ($NewWindow) { '--new-window' } else { '--reuse-window' }
    Invoke-Editor -EditorCommand $t.Command -Arguments @($windowArg, '--goto', $gotoArg)

    Write-Host "Opened in VS Code."
}
catch {
    Write-Host "porthole goto: $($_.Exception.Message)"
    exit 1
}
