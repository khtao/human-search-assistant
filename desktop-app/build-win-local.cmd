@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

echo [HSA] R4 Windows safe build: cache-first Electron, isolated dist output.
call npm run dist:win
if errorlevel 1 goto :failed
exit /b 0

:failed
echo [HSA] Build stopped. See error above; prior build directories remain unchanged.
exit /b 1
