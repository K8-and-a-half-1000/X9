$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".git")) {
    throw "No .git folder found in $PSScriptRoot"
}

git add --all
if ($LASTEXITCODE -ne 0) {
    throw "git add failed"
}

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "No changes to commit."
    exit 0
}

git commit -m "commit"
if ($LASTEXITCODE -ne 0) {
    throw "git commit failed"
}

git push
if ($LASTEXITCODE -ne 0) {
    throw "git push failed"
}

Write-Host "Remote repository updated."