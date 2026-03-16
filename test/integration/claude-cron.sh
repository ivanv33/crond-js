#!/usr/bin/env bash
set -euo pipefail

# Integration test: Claude Code + crond-js MCP
# Starts Claude with the cron MCP server, asks it to schedule a job,
# waits for execution, and verifies the result.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$PROJECT_ROOT/tmp/integration-$(date +%s)"

cleanup() {
  echo "--- Cleaning up ---"
  # Kill daemon if running
  if [[ -f "$TEST_DIR/.cron/cron.pid" ]]; then
    local pid
    pid=$(cat "$TEST_DIR/.cron/cron.pid" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "=== crond-js Claude integration test ==="
echo "Test dir: $TEST_DIR"

# --- Setup ---
mkdir -p "$TEST_DIR/.cron"

# Empty crontab to start
touch "$TEST_DIR/.cron/crontab"

# .mcp.json pointing to our dev source
cat > "$TEST_DIR/.mcp.json" <<'MCPEOF'
{
  "mcpServers": {
    "cron": {
      "command": "npx",
      "args": ["tsx", "SRC_DIR/mcp.ts", ".cron/crontab"]
    }
  }
}
MCPEOF
sed -i '' "s|SRC_DIR|$PROJECT_ROOT/src|" "$TEST_DIR/.mcp.json"

# Marker file the cron job will create
MARKER="$TEST_DIR/.cron/marker.txt"

echo "--- Step 1: Ask Claude to schedule a cron job ---"

PROMPT="Edit the file .cron/crontab to add a cron job that runs every minute. \
The job should run: echo \"cron-integration-test-\$(date +%s)\" >> .cron/marker.txt \
Write only the crontab file, nothing else. Do not explain."

cd "$TEST_DIR"
claude -p "$PROMPT" --dangerously-skip-permissions 2>&1 | head -20

echo ""
echo "--- Crontab contents ---"
cat "$TEST_DIR/.cron/crontab"

# Verify crontab was written
if ! grep -q 'marker.txt' "$TEST_DIR/.cron/crontab"; then
  echo "FAIL: Claude did not write the crontab correctly"
  exit 1
fi
echo "OK: Crontab written"

echo ""
echo "--- Step 2: Ask Claude to check cron_status ---"

STATUS_PROMPT="Use the cron_status tool to check the daemon status. Print the raw JSON result."
STATUS_OUTPUT=$(cd "$TEST_DIR" && claude -p "$STATUS_PROMPT" --dangerously-skip-permissions 2>&1)
echo "$STATUS_OUTPUT" | head -30

# Check daemon started
if echo "$STATUS_OUTPUT" | grep -q '"daemon_running": true'; then
  echo "OK: Daemon is running"
elif echo "$STATUS_OUTPUT" | grep -q 'daemon_running.*true'; then
  echo "OK: Daemon is running"
else
  echo "WARN: Could not confirm daemon status from output (may still be starting)"
fi

echo ""
echo "--- Step 3: Wait for cron job to execute (~70s) ---"

WAITED=0
MAX_WAIT=90
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if [[ -f "$MARKER" ]]; then
    echo "Marker file appeared after ${WAITED}s"
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  echo "  waiting... ${WAITED}s"
done

echo ""
echo "--- Step 4: Verify results ---"

# Check marker file
if [[ ! -f "$MARKER" ]]; then
  echo "FAIL: Marker file was not created after ${MAX_WAIT}s"
  echo "--- Debug: PID file ---"
  cat "$TEST_DIR/.cron/cron.pid" 2>/dev/null || echo "(missing)"
  echo "--- Debug: Log files ---"
  ls -la "$TEST_DIR/.cron/log/" 2>/dev/null || echo "(no log dir)"
  cat "$TEST_DIR/.cron/log/"*.log 2>/dev/null || echo "(no logs)"
  exit 1
fi

MARKER_CONTENT=$(cat "$MARKER")
echo "Marker file contents:"
echo "$MARKER_CONTENT"

if echo "$MARKER_CONTENT" | grep -q 'cron-integration-test-'; then
  echo "OK: Cron job executed correctly"
else
  echo "FAIL: Marker file has unexpected contents"
  exit 1
fi

# Check logs
echo ""
echo "--- Log output ---"
LOG_DIR="$TEST_DIR/.cron/log"
if [[ -d "$LOG_DIR" ]]; then
  cat "$LOG_DIR"/*.log | head -20
  if grep -q 'CMD' "$LOG_DIR"/*.log; then
    echo "OK: Logs contain CMD entries"
  else
    echo "WARN: No CMD entries in logs"
  fi
  if grep -q 'STARTUP' "$LOG_DIR"/*.log; then
    echo "OK: Logs contain STARTUP"
  fi
else
  echo "WARN: No log directory found"
fi

echo ""
echo "=== PASS: Integration test succeeded ==="
