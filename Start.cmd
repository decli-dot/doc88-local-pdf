@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 LTS from https://nodejs.org
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\playwright\package.json" (
  echo First run: open Setup.cmd to install application dependencies.
  pause
  exit /b 1
)
node "%~dp0launcher.cjs"
if errorlevel 1 pause
