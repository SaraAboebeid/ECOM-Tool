#!/bin/bash
# Launch the SAM Street View Segmentation server from the sam3 repo

REPO_DIR="$(cd "$(dirname "$0")" && pwd)/../sam3"
VENV="$REPO_DIR/.venv/bin/activate"
PYTHON="$REPO_DIR/.venv/bin/python"
SERVER_SCRIPT="segment_streetview_server:app"

if [ ! -f "$PYTHON" ]; then
  echo "Python virtual environment not found at $PYTHON"
  exit 1
fi

cd "$REPO_DIR" || exit 1
source "$VENV"

exec $PYTHON -m uvicorn $SERVER_SCRIPT --host 0.0.0.0 --port 8000
