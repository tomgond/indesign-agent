#!/bin/bash
set -euo pipefail

DEBUG=0
RESTART_BRIDGE=0

usage() {
    echo "Usage: $0 [debug|--debug] [restart-bridge|--restart-bridge]" >&2
    echo "" >&2
    echo "Examples:" >&2
    echo "  $0" >&2
    echo "  $0 debug" >&2
    echo "  $0 debug --restart-bridge" >&2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        debug|--debug)
            DEBUG=1
            ;;
        restart-bridge|--restart-bridge)
            RESTART_BRIDGE=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage
            exit 2
            ;;
    esac
    shift
done

REPO_ZIP="https://github.com/tomgond/indesign-agent/archive/refs/heads/main.zip"
ZIP_FILE="indesign-agent-main.zip"

echo "[install] Downloading latest indesign-agent main branch"

rm -rf indesign-agent-main indesign-agent "$ZIP_FILE"

curl -L "$REPO_ZIP" -o "$ZIP_FILE"
unzip -q "$ZIP_FILE"
mv indesign-agent-main indesign-agent
rm "$ZIP_FILE"

cd indesign-agent

echo "[install] Installing MCP server dependencies"
npm install

echo "[install] Installing bridge dependencies"
cd bridge
npm install
cd ..

bridge_running() {
    curl -fsS http://127.0.0.1:3000/status >/dev/null 2>&1
}

bridge_pids() {
    {
        lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null || true
        lsof -ti tcp:3001 -sTCP:LISTEN 2>/dev/null || true
    } | sort -u
}

kill_bridge() {
    local pids
    pids="$(bridge_pids || true)"

    if [[ -z "$pids" ]]; then
        echo "[install] No bridge process found on ports 3000/3001."
        return 0
    fi

    echo "[install] Killing existing bridge process(es) on ports 3000/3001:"
    echo "$pids" | sed 's/^/[install]   pid /'

    echo "$pids" | xargs kill >/dev/null 2>&1 || true
    sleep 1

    local remaining
    remaining="$(bridge_pids || true)"
    if [[ -n "$remaining" ]]; then
        echo "[install] Bridge still running; force killing:"
        echo "$remaining" | sed 's/^/[install]   pid /'
        echo "$remaining" | xargs kill -9 >/dev/null 2>&1 || true
        sleep 0.5
    fi
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

if [[ "$RESTART_BRIDGE" -eq 1 ]]; then
    kill_bridge
fi

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
        echo "[install] Run with --restart-bridge if you need fresh bridge logs."
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
        if [[ -n "${BRIDGE_PID:-}" ]]; then
            echo "[install] Stopping bridge process $BRIDGE_PID"
            kill "$BRIDGE_PID" >/dev/null 2>&1 || true
        fi
    }
    trap cleanup EXIT INT TERM

    echo "[install] MCP HTTP endpoint: http://0.0.0.0:3333/mcp"
    echo "[install] MCP health:        http://127.0.0.1:3333/health"
    echo "[install] Bridge status:     http://127.0.0.1:3333/bridge-status"
    echo "[install] MCP logs:          $LOG_DIR/mcp.log"
    if [[ -n "$BRIDGE_PID" ]]; then
        echo "[install] Bridge logs:       $LOG_DIR/bridge.log"
    fi
    echo "[install] Keep UXP Developer Tool console open for plugin-side logs."

    run_mcp > "$LOG_DIR/mcp.log" 2>&1
else
    echo "[install] Starting MCP server"
    echo "[install] MCP HTTP endpoint: http://0.0.0.0:3333/mcp"
    run_mcp
fi
