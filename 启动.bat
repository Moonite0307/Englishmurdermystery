@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist "scripts\launch.cjs" if exist "Englishmurdermystery\scripts\launch.cjs" cd /d "Englishmurdermystery"
if not exist "scripts\launch.cjs" (
  echo Launcher not found. Please keep the project folder intact.
  pause
  exit /b 1
)
set "SCRIPT_KILL_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "SCRIPT_KILL_NODE=%ProgramFiles%\nodejs\node.exe"
  ) else if exist "D:\node.js\node.exe" (
    set "SCRIPT_KILL_NODE=D:\node.js\node.exe"
  ) else (
    echo Node.js 18 or newer is required: https://nodejs.org/
    pause
    exit /b 1
  )
)
"%SCRIPT_KILL_NODE%" "scripts\launch.cjs"
set "SCRIPT_KILL_EXIT=%errorlevel%"
if not "%SCRIPT_KILL_EXIT%"=="0" pause
exit /b %SCRIPT_KILL_EXIT%
