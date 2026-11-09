@echo off
setlocal
cd /d "%~dp0"
title TeamPulse - Team Workspace
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org/ and run start.bat again.
  pause
  exit /b 1
)
if not exist node_modules\express\package.json (
  echo Installing TeamPulse dependencies for the first run...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
start "TeamPulse browser" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm start
pause
