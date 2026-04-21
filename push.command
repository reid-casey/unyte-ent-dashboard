#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "───────────────────────────────────────────"
echo "  Unyte Pipeline Dashboard → GitHub"
echo "───────────────────────────────────────────"

# Load token from gitignored config file
if [ ! -f ".push-config" ]; then
  echo "❌  Missing .push-config — cannot push without credentials."
  exit 1
fi
source .push-config

# Check if remote already has commits (subsequent pushes)
REMOTE_HAS_COMMITS=$(git ls-remote --heads origin main 2>/dev/null | wc -l | tr -d ' ')

if [ "$REMOTE_HAS_COMMITS" = "0" ]; then
  echo "First push — creating clean git history..."
  # Wipe any existing git history and start fresh
  rm -rf .git
  git init
  git config user.email "reid.j.casey@gmail.com"
  git config user.name "Reid Casey"
  git branch -m main
  git remote add origin "$REMOTE_URL"
else
  # Subsequent push — just ensure remote URL is current
  git remote set-url origin "$REMOTE_URL" 2>/dev/null || true
fi

TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
git add -A
git commit -m "Deploy: $TIMESTAMP"
git push -u origin main

echo ""
echo "✅  Done — Railway will auto-deploy from GitHub."
