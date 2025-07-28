@echo off
REM This script checks for updates, then intelligently installs packages and runs Scribe.

REM --- Update Check Logic ---
where git >nul 2>nul
if %errorlevel% == 0 (
    git fetch >nul 2>nul
    if %errorlevel% == 0 (
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
                REM After pulling, we will let the main startup logic handle the smart install
                echo --- Update Complete! Restarting... ---
                timeout /t 2 /nobreak > nul
                call "%~f0"
                exit /b
            ) else (
                echo Skipping update. Starting current version...
            )
        )
    )
)

:start_server
REM --- Application Startup Logic ---

REM Change to the backend directory
cd /D "%~dp0\backend"

REM Create venv if it doesn't exist
if not exist "venv" (
    echo Python virtual environment not found. Creating one...
    py -3 -m venv venv
    if %errorlevel% neq 0 (
        echo ERROR: Failed to create venv. Is Python installed and in your PATH?
        pause
        exit /b 1
    )
)

REM Activate the virtual environment
call "venv\Scripts\activate.bat"

REM --- Smart Requirements Install ---
set "HASH_FILE=%~dp0\backend\venv\reqs.hash"
set "REQS_FILE=%~dp0\requirements.txt"
set "CURRENT_HASH="
set "STORED_HASH="

REM Calculate current hash of requirements.txt
for /f "delims=" %%H in ('certutil -hashfile "%REQS_FILE%" MD5 ^| findstr /v "MD5"') do (
    set "CURRENT_HASH=%%H"
)

REM Read stored hash if the file exists
if exist "%HASH_FILE%" (
    set /p STORED_HASH=<"%HASH_FILE%"
)

REM Compare hashes. If different, run pip install quietly.
if not "%CURRENT_HASH%" == "%STORED_HASH%" (
    echo New or updated packages found. Installing...
    pip install -q -r "%REQS_FILE%"
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install requirements.
        pause
        exit /b 1
    )
    REM On success, update the hash file
    echo | set /p="!CURRENT_HASH!" > "%HASH_FILE%"
    echo Packages are up to date.
)

echo -----------------------------------------------------
echo Starting the Scribe server...
echo -----------------------------------------------------

start /B uvicorn main:app --host 127.0.0.1 --port 8000

timeout /t 3 /nobreak > nul

echo Opening application at http://127.0.0.1:8000
start http://127.0.0.1:8000

echo.
echo Server is running. Press Ctrl+C in this window to stop it.