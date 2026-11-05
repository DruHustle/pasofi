@echo off
setlocal
where py >nul 2>nul
if not errorlevel 1 goto python_launcher
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 is required. Install Python with its launcher, then retry.
  exit /b 1
)
python "%~dp0release-deploy.py" %*
exit /b %errorlevel%

:python_launcher
py -3 "%~dp0release-deploy.py" %*
exit /b %errorlevel%
