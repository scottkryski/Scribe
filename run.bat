@echo off
REM This script sets up and runs the Annotator application and opens it in a browser.

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
echo Starting the Annotator server...
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