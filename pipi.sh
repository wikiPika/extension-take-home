#!/usr/bin/env bash

set -euo pipefail

# Run from repo root
cd "$(dirname "$0")"

echo "[pipi] Detecting Python..."
PY=${PYTHON:-}
if [[ -z "${PY}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PY=python3
  elif command -v python >/dev/null 2>&1; then
    PY=python
  else
    echo "[pipi] Error: python3/python not found in PATH" >&2
    exit 1
  fi
fi
echo "[pipi] Using Python: $($PY -c 'import sys; print(sys.executable)')"

VENV_DIR=.venv
VENV_PY="$VENV_DIR/bin/python"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "[pipi] Creating virtual environment at $VENV_DIR ..."
  "$PY" -m venv "$VENV_DIR"
fi

if [[ ! -x "$VENV_PY" ]]; then
  echo "[pipi] Error: virtualenv python not found at $VENV_PY" >&2
  exit 1
fi

echo "[pipi] Using venv Python: $($VENV_PY -c 'import sys; print(sys.executable)')"

echo "[pipi] Upgrading pip in venv..."
"$VENV_PY" -m pip install --upgrade pip

echo "[pipi] Installing Python requirements into venv..."
"$VENV_PY" -m pip install -r requirements.txt

echo "[pipi] Installing Playwright browsers (chromium)..."
"$VENV_PY" -m playwright install chromium

echo "[pipi] Done. Activate with: source $VENV_DIR/bin/activate"
echo "[pipi] Then run: python replay.py --file traces/sample.json (-v)"
echo "[pipi] -v enables verbose per-action output if you need that for some reason."


