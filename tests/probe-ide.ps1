#requires -Version 5.1
<#
.SYNOPSIS
    Diagnostic probe for porthole's editor routing.

    Prints which IDEs Copilot CLI currently reports as connected, which editor
    porthole would drive, and whether diagrams will render in any window.
#>
. "$PSScriptRoot\..\scripts\common.ps1"

$ides = @(Get-ConnectedIdes)
Write-Host "Connected IDEs: $($ides.Count)"
foreach ($i in $ides) {
    Write-Host "  $($i.IdeName)  pid=$($i.Pid)"
    foreach ($f in $i.WorkspaceFolders) { Write-Host "      workspace: $f" }
}

$t = Resolve-EditorTarget -ContextPath (Get-Location).Path
Write-Host ""
Write-Host "Routing for $((Get-Location).Path):"
Write-Host "  command          : $($t.Command)"
Write-Host "  connected        : $($t.Connected)"
Write-Host "  ideName          : $($t.IdeName)"
Write-Host "  matchedWorkspace : $($t.MatchedWorkspace)"
Write-Host ""
Write-Host "Diagram preview registered in user settings: $(Test-UserPreviewAssociation)"
