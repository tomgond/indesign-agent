#!/bin/bash
set -euo pipefail

MODE="${1:-}"
if [[ -n "$MODE" && "$MODE" != "debug" && "$MODE" != "--debug" ]]; then
    echo "Usage: $0 [debug|--debug]" >&2
    exit 2
fi

DEBUG=0
if [[ "$MODE" == "debug" || "$MODE" == "--debug" ]]; then
    DEBUG=1
fi

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

bridge_running() {
    curl -fsS http://127.0.0.1:3000/status >/dev/null 2>&1
}

wait_for_bridge() {
    for _ in {1..50}; do
        if bridge_running; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

run_mcp() {
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3333 \
    BRIDGE_URL=http://127.0.0.1:3000 \
    node src/index.js
}

if [[ "$DEBUG" -eq 1 ]]; then
    LOG_ROOT="${INDESIGN_AGENT_LOG_DIR:-$HOME/indesign-agent-logs}"
    LOG_DIR="$LOG_ROOT/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$LOG_DIR"

    echo "[install] Debug mode enabled"
    echo "[install] Logs: $LOG_DIR"

    BRIDGE_PID=""
    if bridge_running; then
        echo "[install] Bridge already running on 127.0.0.1:3000; using existing bridge."
        echo "[install] Existing bridge logs are not captured by this run."
        echo "[install] Stop the old bridge first if you need fresh bridge logs."
    else
        echo "[install] Starting bridge with logs: $LOG_DIR/bridge.log"
        (cd bridge && node server.js > "$LOG_DIR/bridge.log" 2>&1) &
        BRIDGE_PID="$!"

        if ! wait_for_bridge; then
            echo "[install] Bridge did not become healthy. Last bridge log lines:" >&2
            tail -40 "$LOG_DIR/bridge.log" >&2 || true
            exit 1
        fi
    fi

    cleanup() {
        if [[ -n "$BRIDGE_PID" ]]; then
            kill "$BRIDGE_PID" >/dev/null 2>&1 || true
        fi
    }
    trap cleanup EXIT INT TERM

    echo "[install] MCP HTTP endpoint: http://0.0.0.0:3333/mcp"
    echo "[install] MCP health:        http://127.0.0.1:3333/health"
    echo "[install] Bridge status:     http://127.0.0.1:3333/bridge-status"
    echo "[install] MCP logs:          $LOG_DIR/mcp.log"
    echo "[install] Bridge logs:       $LOG_DIR/bridge.log"
    echo "[install] Keep UXP Developer Tool console open for plugin-side logs."

    run_mcp > "$LOG_DIR/mcp.log" 2>&1
else
    run_mcp
fi
