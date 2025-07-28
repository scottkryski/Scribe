@echo off
echo.
echo =================================
echo      Scribe Updater (Windows)
echo =================================
echo.

REM Wait for the main server to shut down (3 seconds)
echo Waiting for the old server to close...
timeout /t 3 /nobreak > nul

echo.
echo --- Step 1: Pulling latest changes from GitHub ---
git pull
if %errorlevel% neq 0 (
    echo ERROR: 'git pull' failed. You may have local changes.
    echo Please resolve any conflicts manually and then run run.bat again.
    pause
    exit /b 1
)

echo.
echo --- Step 2: Updating Python packages ---
cd backend
call "venv\Scripts\activate.bat"
pip install -r "..\requirements.txt"
if %errorlevel% neq 0 (
    echo ERROR: Failed to update requirements.
    pause
    exit /b 1
)
cd ..

echo.
echo --- Step 3: Restarting the application ---
echo Update complete! Restarting Scribe...
timeout /t 2 /nobreak > nul

REM Relaunch the main application using the original run script
start /B "" "run.bat"

exit