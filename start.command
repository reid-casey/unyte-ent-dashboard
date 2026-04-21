#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "───────────────────────────────────────────"
echo "  Unyte Pipeline Dashboard"
echo "───────────────────────────────────────────"

# Create .env from example if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  No .env file found — created one from .env.example."
  echo "    Add your HUBSPOT_TOKEN before data will load."
  echo ""
fi

echo "Installing dependencies..."
npm install --silent

echo "Starting server..."
echo ""
echo "  Dashboard → http://localhost:3000"
echo ""

# Open browser after a short delay to let the server start
sleep 2 && open http://localhost:3000 &

node server.js
