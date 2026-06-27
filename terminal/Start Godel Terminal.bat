@echo off
setlocal enabledelayedexpansion
title Godel Terminal
cd /d "%~dp0"

set "PORT=3001"

echo ============================================
echo              GODEL TERMINAL
echo ============================================
echo.

REM --- Check that Node.js is available ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo.
  echo Please install Node.js 18 or newer from:
  echo.
  echo        https://nodejs.org/
  echo.
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo Using Node.js !NODEVER!
echo.

REM --- Install dependencies on first run only ---
if not exist "node_modules\" (
  echo First run detected - installing dependencies.
  echo This happens once and may take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] "npm install" failed. See the messages above.
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo Starting the server at http://localhost:%PORT%
echo Your browser will open automatically in a few seconds.
echo.
echo  - Keep this window open while you use the terminal.
echo  - Close it (or press Ctrl+C) to stop the server.
echo ============================================
echo.

REM --- Open the browser shortly after the server has time to boot ---
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"

REM --- Run the server in this window (this blocks until you close it) ---
call npm start

echo.
echo Server stopped.
pause
