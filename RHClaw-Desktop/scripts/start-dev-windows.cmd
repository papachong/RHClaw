@echo off
setlocal

set "ROOT_DIR=%~dp0.."
pushd "%ROOT_DIR%" >nul

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed. Please install Node.js with npm first.
  popd >nul
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules not found. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    popd >nul
    exit /b 1
  )
)

echo [INFO] Starting RHOpenClaw-Desktop in development mode (tauri:dev)...
call npm run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"

popd >nul
exit /b %EXIT_CODE%
