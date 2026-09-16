@echo off
cd /d "%~dp0"
if not exist "data\ntp.db" (
  echo First run - seeding database...
  python -m app.seed
)
echo Starting National Transport API
echo   Local:   http://127.0.0.1:8000
echo   Network: http://<THIS-PC-LAN-IP>:8000   (see ipconfig)
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
