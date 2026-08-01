<#
.SYNOPSIS
    One-time porthole setup: makes *.diagram.md files open rendered in every
    VS Code window, not just in porthole-generated workspaces.

.DESCRIPTION
    There is no CLI flag that opens a markdown preview, so porthole relies on the
    `workbench.editorAssociations` setting. Inside a porthole-generated workspace
    that association is already present. When porthole reuses an IDE window you
    already had open, the association has to live in your user settings instead.

    This adds exactly one key:

        "workbench.editorAssociations": { "*.diagram.md": "vscode.markdown.preview.editor" }

    Only the `*.diagram.md` pattern is touched. Existing associations are kept,
    and a timestamped backup is written before any change. Use -Remove to undo.

.PARAMETER Flavour
    Which settings file to modify: 'insiders' (default) or 'code'. 'both' does both.

.PARAMETER Remove
    Remove the association instead of adding it.

.PARAMETER DryRun
    Show what would change without writing.
#>
[CmdletBinding()]
param(
    [switch]$RegisterDiagramPreview,
    [ValidateSet('insiders', 'code', 'both')]
    [string]$Flavour = 'insiders',
    [switch]$Remove,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

function Update-Settings {
    param([string]$Which)

    $path = Get-UserSettingsPath -Flavour $Which
    Write-Host "Settings: $path"

    if (-not (Test-Path -LiteralPath $path)) {
        if ($Remove) { Write-Host "  not present; nothing to remove."; return }
        $dir = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $dir)) {
            Write-Host "  VS Code ($Which) does not appear to be installed; skipping."
            return
        }
        if ($DryRun) { Write-Host "  would create settings.json with the association."; return }
        $obj = [ordered]@{ 'workbench.editorAssociations' = [ordered]@{ '*.diagram.md' = 'vscode.markdown.preview.editor' } }
        Write-JsonFile -Path $path -Object $obj
        Write-Host "  created with the diagram association."
        return
    }

    $raw = Get-Content -LiteralPath $path -Raw
    $stripped = [regex]::Replace($raw, '(?m)^\s*//.*$', '')
    try { $json = $stripped | ConvertFrom-Json }
    catch { throw "Could not parse $path. Edit it manually and re-run." }

    # Rebuild as an ordered hashtable so we can write it back cleanly.
    $table = [ordered]@{}
    foreach ($prop in $json.PSObject.Properties) { $table[$prop.Name] = $prop.Value }

    $assocTable = [ordered]@{}
    if ($table.Contains('workbench.editorAssociations') -and $table['workbench.editorAssociations']) {
        foreach ($p in $table['workbench.editorAssociations'].PSObject.Properties) {
            $assocTable[$p.Name] = $p.Value
        }
    }

    if ($Remove) {
        if (-not $assocTable.Contains('*.diagram.md')) {
            Write-Host "  association not present; nothing to do."
            return
        }
        $assocTable.Remove('*.diagram.md')
        Write-Host "  removing *.diagram.md association."
    }
    else {
        if ($assocTable['*.diagram.md'] -eq 'vscode.markdown.preview.editor') {
            Write-Host "  already configured; nothing to do."
            return
        }
        $assocTable['*.diagram.md'] = 'vscode.markdown.preview.editor'
        Write-Host "  adding *.diagram.md -> vscode.markdown.preview.editor"
    }

    if ($assocTable.Count -gt 0) { $table['workbench.editorAssociations'] = $assocTable }
    elseif ($table.Contains('workbench.editorAssociations')) { $table.Remove('workbench.editorAssociations') }

    if ($DryRun) { Write-Host "  -DryRun specified; not written."; return }

    if ($raw -match '(?m)^\s*//') {
        Write-Warning "  this settings.json contains comments, which will be dropped on rewrite."
    }

    $backup = "$path.porthole-bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $path -Destination $backup -Force
    Write-Host "  backup: $backup"

    Write-JsonFile -Path $path -Object $table
    Write-Host "  written."
}

try {
    if (-not $RegisterDiagramPreview -and -not $Remove) {
        Write-Host "porthole setup"
        Write-Host ""
        Write-Host "  -RegisterDiagramPreview   make *.diagram.md open rendered in every window"
        Write-Host "  -Remove                   undo that change"
        Write-Host "  -Flavour insiders|code|both"
        Write-Host "  -DryRun                   show changes without writing"
        Write-Host ""
        Write-Host "Currently registered: $(if (Test-UserPreviewAssociation) { 'yes' } else { 'no' })"
        exit 0
    }

    $targets = if ($Flavour -eq 'both') { @('insiders', 'code') } else { @($Flavour) }
    foreach ($t in $targets) { Update-Settings -Which $t }

    Write-Host ""
    Write-Host "Done. Reload the VS Code window for the change to take effect."
}
catch {
    Write-Host "porthole setup: $($_.Exception.Message)"
    exit 1
}
