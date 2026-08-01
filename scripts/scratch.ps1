<#
.SYNOPSIS
    Creates or opens a scratch note inside the current Copilot session folder.

.PARAMETER Name
    Note name. Defaults to 'scratch'. '.md' is added when missing.

.PARAMETER Content
    Optional initial content. Appended when the note already exists.

.PARAMETER Rendered
    Open the note rendered as a markdown preview instead of as source.

.PARAMETER SessionPath
    Current Copilot session folder. Falls back to the most recent one.

.PARAMETER Editor
    'auto' (default, prefers Insiders), 'insiders', or 'code'.

.PARAMETER DryRun
    Write the note but do not launch an editor.
#>
[CmdletBinding()]
param(
    [string]$Name = 'scratch',
    [string]$Content,
    [switch]$Rendered,
    [string]$SessionPath,
    [ValidateSet('auto', 'insiders', 'code')]
    [string]$Editor = 'auto',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

try {
    $sessionFolder = Resolve-SessionFolder -Explicit $SessionPath
    if (-not $sessionFolder) {
        throw "No Copilot session folder found. Pass -SessionPath explicitly."
    }

    $targetDir = Join-Path $sessionFolder 'files'
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    $leaf = ConvertTo-SafeName ($Name -replace '\.md$', '')
    if ($Rendered) { $notePath = Join-Path $targetDir "$leaf.diagram.md" }
    else { $notePath = Join-Path $targetDir "$leaf.md" }

    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

    if (-not (Test-Path -LiteralPath $notePath)) {
        $initial = "# $leaf`n`n<sub>Created by porthole - $stamp</sub>`n"
        if ($Content) { $initial += "`n$Content`n" }
        [IO.File]::WriteAllText($notePath, $initial, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Created: $notePath"
    }
    else {
        if ($Content) {
            Add-Content -LiteralPath $notePath -Value "`n## $stamp`n`n$Content`n"
            Write-Host "Appended to: $notePath"
        }
        else {
            Write-Host "Opening existing: $notePath"
        }
    }

    if ($DryRun) {
        Write-Host "-DryRun specified; editor not launched."
        exit 0
    }

    $t = Resolve-EditorTarget -Preference $Editor -ContextPath $targetDir
    if ($t.Connected) { Write-Host "IDE : reusing connected $($t.IdeName) window" }

    # Only spin up a preview workspace when nothing is already connected -
    # opening a different workspace would spawn a second window.
    if ($Rendered -and -not $t.Connected) {
        $wsDir = Get-PortholeTempDir -Leaf 'porthole-workspaces'
        $wsFile = Join-Path $wsDir ("scratch-{0}.code-workspace" -f (Get-ShortId (Split-Path -Leaf $sessionFolder)))
        $workspace = [ordered]@{
            folders  = @([ordered]@{ path = $targetDir; name = 'Session Files' })
            settings = [ordered]@{
                'workbench.editorAssociations' = [ordered]@{
                    '*.diagram.md' = 'vscode.markdown.preview.editor'
                }
            }
        }
        Write-JsonFile -Path $wsFile -Object $workspace
        Invoke-Editor -EditorCommand $t.Command -Arguments @($wsFile)
        Start-Sleep -Milliseconds 1200
    }

    Invoke-Editor -EditorCommand $t.Command -Arguments @('--reuse-window', $notePath)
    Write-Host "Opened scratch note in VS Code."
}
catch {
    Write-Host "porthole scratch: $($_.Exception.Message)"
    exit 1
}
