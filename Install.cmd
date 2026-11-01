@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
set "patch_result=%errorlevel%"
echo.
pause
exit /b %patch_result%
