@echo off
setlocal
rem Double-click launcher for the Airlock control console.
rem Arguments are passed through, e.g.:  airlock-ui.cmd --app web --port 7788
rem
rem The console is a local-only web app (127.0.0.1 + one-time token), generated
rem by the server itself -- there is no static HTML file to open. This script is
rem the entry point.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo Node.js was not found on PATH.
    echo Airlock needs Node.js 24 or newer: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

node "%~dp0bin\airlock-deploy-ui.mjs" %*
if errorlevel 1 (
    echo.
    echo The console exited with an error. See the message above.
    pause
)
endlocal