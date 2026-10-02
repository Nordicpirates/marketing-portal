#!/usr/bin/env bash
# Build the QR print files and push edge/qr to Cloudflare Pages project nordicpirates-qr.
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and a python with segno. docs/QR-LINKS.md
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${QR_PYTHON:-python3}"

rm -rf "$REPO/edge/qr/public/files"
"$PYTHON" "$REPO/scripts/qr_files.py" "$REPO/edge/qr/public/files"

cd "$REPO/edge/qr"
npx --yes wrangler@4 pages deploy public \
  --project-name nordicpirates-qr \
  --branch main \
  --commit-hash "$(git -C "$REPO" rev-parse HEAD)" \
  --commit-message "$(git -C "$REPO" log -1 --format=%s)" \
  --commit-dirty="$([ -n "$(git -C "$REPO" status --porcelain)" ] && echo true || echo false)"
