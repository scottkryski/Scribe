#!/bin/bash
# This script checks for updates, then intelligently installs packages and runs Scribe.

# --- Function Definitions ---

# This function smartly installs/updates packages only if requirements.txt has changed.
install_requirements() {
    # Define the path for the hash file inside the venv directory
    local hash_file="$(dirname "$0")/backend/venv/reqs.hash"
    
    # Activate the virtual environment
    source "$(dirname "$0")/backend/venv/bin/activate"

    # Calculate the current hash of the requirements file
    # Tries shasum (macOS) first, then md5sum (Linux)
    if command -v shasum &> /dev/null; then
        local current_hash=$(shasum -a 256 "$(dirname "$0")/requirements.txt" | awk '{print $1}')
    else
        local current_hash=$(md5sum "$(dirname "$0")/requirements.txt" | awk '{print $1}')
    fi
    
    # Read the stored hash, if it exists
    local stored_hash=""
    if [ -f "$hash_file" ]; then
        stored_hash=$(cat "$hash_file")
    fi

    # Compare hashes. If they don't match, run pip install quietly.
    if [ "$current_hash" != "$stored_hash" ]; then
        echo "New or updated packages found. Installing..."
        pip install -q -r "$(dirname "$0")/requirements.txt"
        # On success, update the hash file with the new hash
        echo "$current_hash" > "$hash_file"
        echo "Packages are up to date."
    fi
}

# This function cleans up the background server process when the script exits
cleanup() {
    echo ""
    echo "Shutting down the server..."
    if [ ! -z "$SERVER_PID" ]; then
      kill $SERVER_PID
    fi
    exit
}


# --- Main Script Logic ---

# Check for git and offer to update if available
if command -v git &> /dev/null && git fetch &> /dev/null; then
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse @{u})

    if [ "$LOCAL" != "$REMOTE" ]; then
        echo -e "\nA NEW VERSION OF SCRIBE IS AVAILABLE."
        echo "-----------------------------------------------------"
        echo "Recent Changes:"
        git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit HEAD..@{u}
        echo -e "\n-----------------------------------------------------"
        
        read -p "Do you want to update now? (y/n): " choice
        if [[ "$choice" =~ ^[Yy]$ ]]; then
            echo "--- Starting Update ---"
            git pull
            # After pulling, call our smart installer. It will detect changes.
            install_requirements
            echo "--- Update Complete! Restarting... ---"
            sleep 2
            exec "$0" "$@" # Restart the script
            exit
        else
            echo "Skipping update. Starting current version."
        fi
    fi
fi


# --- Application Startup ---

# Trap Ctrl+C to run our cleanup function
trap cleanup INT

# Exit immediately if a command fails
set -e

# Change to the backend directory
cd "$(dirname "$0")/backend"

# Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Python virtual environment not found. Creating one..."
    python3 -m venv venv
fi

# Call our smart installer. It will be fast and silent if no changes are needed.
install_requirements

echo "-----------------------------------------------------"
echo "Starting the Scribe server..."
echo "-----------------------------------------------------"

uvicorn main:app --host 127.0.0.1 --port 8000 &
SERVER_PID=$!
sleep 3

URL="http://127.0.0.1:8000"
echo "Opening application at $URL"

if [[ "$OSTYPE" == "linux-gnu"* ]]; then xdg-open "$URL"; elif [[ "$OSTYPE" == "darwin"* ]]; then open "$URL"; fi

echo -e "\nServer is running. Press Ctrl+C in this window to stop it."
wait $SERVER_PID