#!/bin/bash
# GATE's CI image has no python3 and the tests spawn it, so CI fetches a standalone one with uv.
set -euo pipefail
if ! command -v python3 >/dev/null 2>&1 || [ "${CI_FORCE_PY:-}" = 1 ]; then
  BIN="$PWD/.ci/bin"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BIN" UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1
  "$BIN/uv" venv -q --python 3.12 .ci/py
  VIRTUAL_ENV="$PWD/.ci/py" "$BIN/uv" pip install -q tzdata
  export PATH="$PWD/.ci/py/bin:$PATH"
fi
python3 -I -c 'import sys, zoneinfo; zoneinfo.ZoneInfo("Europe/Stockholm"); print("python", sys.version.split()[0])'
exec bun test tests/
