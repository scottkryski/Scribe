#!/bin/bash
echo ""
echo "================================="
echo "     Scribe Updater (Mac/Linux)"
echo "================================="
echo ""

# Wait for the main server to shut down (3 seconds)
echo "Waiting for the old server to close..."
sleep 3

echo ""
echo "--- Step 1: Pulling latest changes from GitHub ---"
if ! git pull; then
    echo "ERROR: 'git pull' failed. You may have local changes." >&2
    echo "Please resolve any conflicts manually and then run run.sh again." >&2
    exit 1
fi

echo ""
echo "--- Step 2: Updating Python packages ---"
# Activate venv from the script's location
source "$(dirname "$0")/backend/venv/bin/activate"
pip install -r "$(dirname "$0")/requirements.txt"

echo ""
echo "--- Step 3: Restarting the application ---"
echo "Update complete! Restarting Scribe..."
sleep 2

# Relaunch the main application using the original run script in the background
# The 'nohup' and '&' ensure it keeps running even after this terminal closes.
nohup "$(dirname "$0")/run.sh" > /dev/null 2>&1 &

exit 0