@echo off
REM National Transport backend launcher (auto-start at logon).
REM Uses pythonw from PATH; falls back to the current user's AppData pythonw.
cd /d "%~dp0"
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw run_backend.py
) else (
  start "" "%LocalAppData%\Python\pythoncore-3.14-64\pythonw.exe" run_backend.py
)