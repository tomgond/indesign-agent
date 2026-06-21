#!/bin/bash
set -e

REPO_ZIP="https://github.com/tomgond/indesign-agent/archive/refs/heads/main.zip"
ZIP_FILE="indesign-agent-main.zip"

rm -rf indesign-agent-main indesign-agent "$ZIP_FILE"

curl -L "$REPO_ZIP" -o "$ZIP_FILE"
unzip "$ZIP_FILE"
mv indesign-agent-main indesign-agent
rm "$ZIP_FILE"

cd indesign-agent
npm install

cd bridge
npm install

cd ..

MCP_TRANSPORT=http \
MCP_HOST=0.0.0.0 \
MCP_PORT=3333 \
BRIDGE_URL=http://127.0.0.1:3000 \
node src/index.js
