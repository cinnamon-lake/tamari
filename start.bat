@echo off
rem tamari startup script (Windows equivalent of start.sh)
rem Builds client + server from source, then starts the server.

setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo npm could not be found in PATH. Please install Node.js from https://nodejs.org/
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo node could not be found in PATH. Please install Node.js from https://nodejs.org/
    exit /b 1
)

echo Installing Node Modules...
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress
if errorlevel 1 exit /b 1

echo Building tamari...
call npm run build
if errorlevel 1 exit /b 1

echo Starting server...
node server\dist\main.js %*
