$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".git")) {
    throw "No .git folder found in $PSScriptRoot"
}
git fetch --prune
if ($LASTEXITCODE -ne 0) {
    throw "git fetch failed"
}
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
    throw "git pull failed"
}
Write-Host "Repository updated."