$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path "data\ntp.db")) {
  Write-Host "First run - seeding database..."
  python -m app.seed
}

Write-Host "Starting National Transport API"
Write-Host "  Local:   http://127.0.0.1:8000   (docs: http://127.0.0.1:8000/docs)"
Write-Host "  Network: http://<THIS-PC-LAN-IP>:8000   (see ipconfig)"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
