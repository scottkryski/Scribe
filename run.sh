#!/bin/bash
# This script sets up and runs the Annotator application and opens it in a browser.

# Function to clean up the background server process when the script exits
cleanup() {
    echo ""
    echo "Shutting down the server..."
    # Kills the background process whose PID we saved
    kill $SERVER_PID
    exit
}

# Trap the INT signal (Ctrl+C) and call the cleanup function
trap cleanup INT

# Exit immediately if a command exits with a non-zero status.
set -e

# Change to the backend directory, located in the same directory as this script.
cd "$(dirname "$0")/backend"

# Check if the virtual environment directory exists
if [ ! -d "venv" ]; then
    echo "Python virtual environment not found. Creating one..."
    python3 -m venv venv
fi

# Activate the virtual environment
source venv/bin/activate

echo "Installing/checking required packages..."
pip install -r ../requirements.txt

echo "-----------------------------------------------------"
echo "Starting the Annotator server..."
echo "-----------------------------------------------------"

# Run the FastAPI application in the background using '&'
uvicorn main:app --host 127.0.0.1 --port 8000 &

# Save the Process ID (PID) of the server so we can stop it later
SERVER_PID=$!

# Wait a few seconds for the server to initialize
sleep 3

URL="http://127.0.0.1:8000"
echo "Opening application at $URL"

# Use the correct command to open a URL based on the Operating System
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "$URL"
elif [[ "$OSTYPE" == "darwin"* ]]; then # macOS
    open "$URL"
else
    echo "Could not detect OS to open browser automatically. Please navigate to the URL above."
fi

echo ""
echo "Server is running. Press Ctrl+C in this window to stop it."

# 'wait' will pause the script here until the background server process is stopped.
# When you press Ctrl+C, the 'trap' will run cleanup, which kills the server,
# and then the 'wait' will complete, allowing the script to exit.
wait $SERVER_PID