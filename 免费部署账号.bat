@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist "scripts\deploy-free-accounts.cjs" if exist "Englishmurdermystery\scripts\deploy-free-accounts.cjs" cd /d "Englishmurdermystery"
if not exist "scripts\deploy-free-accounts.cjs" (
  echo Deployment script not found. Please keep the project folder intact.
  pause
  exit /b 1
)
set "FREE_ACCOUNT_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "FREE_ACCOUNT_NODE=%ProgramFiles%\nodejs\node.exe"
  ) else if exist "D:\node.js\node.exe" (
    set "FREE_ACCOUNT_NODE=D:\node.js\node.exe"
  ) else (
    echo Node.js 22 or newer is required: https://nodejs.org/
    pause
    exit /b 1
  )
)
"%FREE_ACCOUNT_NODE%" "scripts\deploy-free-accounts.cjs"
set "FREE_ACCOUNT_EXIT=%errorlevel%"
pause
exit /b %FREE_ACCOUNT_EXIT%
