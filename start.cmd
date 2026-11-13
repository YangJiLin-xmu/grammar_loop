@echo off
setlocal
if not defined SystemRoot set "SystemRoot=C:\Windows"
if not defined WINDIR set "WINDIR=%SystemRoot%"
if not defined ComSpec set "ComSpec=%SystemRoot%\System32\cmd.exe"
pushd "%~dp0"
set "GL_EXIT="
set "GL_TASK=%~1"
if not defined GL_TASK set "GL_TASK=dev"
if /I not "%GL_TASK%"=="dev" goto run
if exist "node_modules\next\dist\bin\next" goto run
echo Installing project dependencies...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" install
if errorlevel 1 (
  set "GL_EXIT=1"
  goto failed
)
:run
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
set "GL_EXIT=%ERRORLEVEL%"
if not "%GL_EXIT%"=="0" goto failed
popd
exit /b 0
:failed
if not defined GL_EXIT set "GL_EXIT=1"
echo.
echo Grammar Loop did not start. Keep the error above for troubleshooting.
if "%~1"=="" pause
popd
exit /b %GL_EXIT%
