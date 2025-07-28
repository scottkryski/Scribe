@echo off
REM This script checks for updates, then sets up and runs the Scribe application.

REM --- Update Check Logic ---
REM This block runs before we start the server.

REM Check if git is installed. If not, skip the update check.
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo Git not found. Skipping update check.
    goto :start_server
)

echo --- Checking for updates ---

REM Attempt to fetch the latest info from the remote repository.
git fetch
if %errorlevel% neq 0 (
    echo Could not connect to GitHub. Skipping update check.
    goto :start_server
)

REM Capture local and remote commit hashes into variables
for /f "delims=" %%i in ('git rev-parse HEAD') do set "LOCAL=%%i"
for /f "delims=" %%i in ('git rev-parse @{u}') do set "REMOTE=%%i"

if not "%LOCAL%" == "%REMOTE%" (
    echo.
    echo A NEW VERSION OF SCRIBE IS AVAILABLE.
    echo -----------------------------------------------------
    echo Recent Changes:
    git log --oneline -n 10 HEAD..@{u}
    echo.
    echo -----------------------------------------------------
    
    set /p choice="Do you want to update now? (y/n): "
    if /i "%choice%"=="y" (
        echo --- Starting Update ---
        git pull
        if %errorlevel% neq 0 (
            echo ERROR: 'git pull' failed. You may have local changes.
            echo Please resolve any conflicts manually and try again.
            pause
            exit /b 1
        )
        
        echo Updating Python packages...
        call "%~dp0\backend\venv\Scripts\activate.bat"
        pip install -r "%~dp0\requirements.txt"
        
        echo --- Update Complete! ---
        echo The application will now restart with the new version.
        timeout /t 2 /nobreak > nul
        
        REM Relaunch this same script and exit the current one
        call "%~f0"
        exit /b
    ) else (
        echo Skipping update. Starting the current version...
        echo.
    )
) else (
    echo Scribe is up to date.
)

:start_server
REM --- End of Update Check Logic ---


REM --- Application Startup Logic ---
REM This part is the original script logic.

REM Change to the backend directory from the script's location.
cd /D "%~dp0\backend"

REM Check if the virtual environment directory exists
if not exist "venv" (
    echo Python virtual environment not found. Creating one...
    py -3 -m venv venv
    if %errorlevel% neq 0 (
        echo ERROR: Failed to create virtual environment. Please ensure Python 3 is in your PATH.
        pause
        exit /b 1
    )
)

REM Activate the virtual environment
call "venv\Scripts\activate.bat"

echo Installing/checking required packages...
pip install -r "..\requirements.txt"
if %errorlevel% neq 0 (
    echo ERROR: Failed to install requirements from ..\requirements.txt.
    pause
    exit /b 1
)

echo -----------------------------------------------------
echo Starting the Scribe server...
echo -----------------------------------------------------

REM Run the FastAPI application IN THE BACKGROUND of this SAME window.
start /B uvicorn main:app --host 127.0.0.1 --port 8000

REM Wait a few seconds for the server to initialize
timeout /t 3 /nobreak > nul

REM Now that the server is running, open the browser.
echo Opening application at http://127.0.0.1:8000
start http://127.0.0.1:8000

echo.
echo Server is running. Press Ctrl+C in this window to stop it.
REM The window will now wait for the uvicorn process to end.