@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org and open this file again.
  pause
  exit /b 1
)
pushd "%~dp0"
call npm.cmd ci
if errorlevel 1 (
  popd
  echo Installation failed. Check the message above and your internet connection.
  pause
  exit /b 1
)
popd
echo Ready. Open Start.cmd to launch Doc88 Local PDF.
pause
