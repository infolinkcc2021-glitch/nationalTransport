$backend = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $backend "watchdog.log"
$bat = Join-Path $backend "start-backend.bat"
while ($true) {
  $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 8000 }
  if (-not $listening) {
    "restart at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - port 8000 was down" | Out-File -FilePath $log -Append -Encoding utf8
    Start-Process -FilePath "cmd.exe" -ArgumentList '/c', ('"' + $bat + '"') -WindowStyle Hidden
  }
  Start-Sleep -Seconds 45
}