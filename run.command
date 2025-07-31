#!/bin/bash
# This script checks for updates, then intelligently installs packages and runs Scribe.

# --- Global Constants ---

# Get the absolute path of the directory where this script is located (the project root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
VENV_DIR="$SCRIPT_DIR/backend/venv"
REQUIREMENTS_FILE="$SCRIPT_DIR/requirements.txt"

# --- Function Definitions ---

# This function smartly installs/updates packages only if requirements.txt has changed.
install_requirements() {
    # Define the path for the hash file inside the venv directory
    local hash_file="$VENV_DIR/reqs.hash"
    
    # Activate the virtual environment using the absolute path
    source "$VENV_DIR/bin/activate"

    # Calculate the current hash of the requirements file
    if command -v shasum &> /dev/null; then
        local current_hash=$(shasum -a 256 "$REQUIREMENTS_FILE" | awk '{print $1}')
    else
        local current_hash=$(md5sum "$REQUIREMENTS_FILE" | awk '{print $1}')
    fi
    
    # Read the stored hash, if it exists
    local stored_hash=""
    if [ -f "$hash_file" ]; then
        stored_hash=$(cat "$hash_file")
    fi

    # Compare hashes. If they don't match, run pip install quietly.
    if [ "$current_hash" != "$stored_hash" ]; then
        echo "New or updated packages found. Installing..."
        pip install -q -r "$REQUIREMENTS_FILE"
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

# Trap Ctrl+C to run our cleanup function
trap cleanup INT

# Exit immediately if a command fails
set -e

# Change to the script's directory (the project root) to ensure git commands work.
cd "$SCRIPT_DIR"

# Check for git and offer to update if available
if command -v git &> /dev/null; then
    # Check if this is a git repository before proceeding
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Checking for updates..."
        # Fetch updates from remote. Use --quiet to prevent output on success.
        git fetch --quiet

        # Check for an upstream branch. If this command fails, it means none is configured.
        # The `|| true` prevents the script from exiting due to `set -e`.
        REMOTE_INFO=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null) || true

        # Only proceed if we have an upstream branch to compare against
        if [ -n "$REMOTE_INFO" ]; then
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
                    install_requirements
                    echo "--- Update Complete! Restarting... ---"
                    sleep 2
                    exec "$0" "$@"
                    exit
                else
                    echo "Skipping update. Starting current version."
                fi
            fi
        fi
    fi
fi


# --- Application Startup ---

# Create venv if it doesn't exist, using the absolute path.
if [ ! -d "$VENV_DIR" ]; then
    echo "Python virtual environment not found. Creating one..."
    python3 -m venv "$VENV_DIR"
fi

# Call our smart installer.
install_requirements

# Change to the backend directory for running the server
cd "$SCRIPT_DIR/backend"

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