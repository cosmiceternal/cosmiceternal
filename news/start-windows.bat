@echo off
REM ============================================================
REM  News Wall launcher for Windows.
REM  Just double-click this file. It starts the local server and
REM  opens the News Wall in your browser. Keep the black window
REM  open while you read; close it (or press a key) to stop.
REM ============================================================

REM Run from the folder this .bat lives in (the "news" folder).
cd /d "%~dp0"

echo.
echo   Starting the News Wall...
echo   A browser tab will open at http://localhost:8787
echo   Keep THIS window open while you read the news.
echo.

REM Open the browser first; the server comes up a second later.
start "" "http://localhost:8787"

REM Start the server (this keeps running until you close the window).
node server.js

echo.
echo   The News Wall has stopped.
pause
