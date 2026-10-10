# Gera o .zip para enviar à Chrome Web Store: dist/volume-individual-meet-<versão>.zip
#
#   powershell -ExecutionPolicy Bypass -File scripts/pack.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'extension'
$version = (Get-Content (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist "volume-individual-meet-$version.zip"

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Confirm:$false }

# O manifest.json precisa ficar na raiz do zip, não dentro de uma pasta.
Compress-Archive -Path (Join-Path $ext '*') -DestinationPath $zip
Write-Host "Gerado: $zip"
