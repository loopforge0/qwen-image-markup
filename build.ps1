# Builds dist\Markup.exe — a single file that needs no Python installed.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# The build tools go into a throwaway .venv-build so nothing lands in your global Python.
# The app itself has no dependencies; PyInstaller is only needed to make the .exe.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path .venv-build)) { python -m venv .venv-build }
$py = ".venv-build\Scripts\python.exe"
& $py -m pip install --quiet --upgrade pip pyinstaller
if ($LASTEXITCODE) { throw "pip install failed" }

& $py -m PyInstaller --noconfirm --clean --onefile `
    --name Markup `
    --icon docs\icon.ico `
    --add-data "index.html;." `
    --add-data "app.js;." `
    server.py
if ($LASTEXITCODE) { throw "PyInstaller failed" }

Write-Host "`nBuilt dist\Markup.exe"
