#!/usr/bin/env bash
set -euo pipefail

# Integration test: Claude Code + crond-js MCP
#
# Gives Claude a real task that requires cron scheduling.
# Claude must figure out it has cron available, write the crontab,
# and the test verifies the scheduled job actually ran.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$PROJECT_ROOT/tmp/integration-$(date +%s)"

cleanup() {
  echo "--- Cleaning up ---"
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
touch "$TEST_DIR/.cron/crontab"

# .mcp.json pointing to our dev source
cat > "$TEST_DIR/.mcp.json" <<MCPEOF
{
  "mcpServers": {
    "cron": {
      "command": "npx",
      "args": ["tsx", "$PROJECT_ROOT/src/mcp.ts", ".cron/crontab"]
    }
  }
}
MCPEOF

# CLAUDE.md gives context about this project directory
cat > "$TEST_DIR/CLAUDE.md" <<'CLAUSEEOF'
This project has a cron daemon available via MCP. The crontab file is at .cron/crontab.
To schedule jobs, edit .cron/crontab using standard 5-field cron syntax.
Use cron_status to check the daemon. Jobs run with cwd set to this directory.
CLAUSEEOF

echo "--- Step 1: Give Claude a task that needs cron ---"

PROMPT="I need to monitor disk usage in this directory. Set up a scheduled job that \
runs every minute and appends the output of 'du -sh .' to a file called disk-usage.log \
in this directory. Verify the cron daemon is running after you set it up."

cd "$TEST_DIR"
echo "Prompt: $PROMPT"
echo ""
CLAUDE_OUTPUT=$(claude -p "$PROMPT" --dangerously-skip-permissions 2>&1)
echo "$CLAUDE_OUTPUT" | tail -30

echo ""
echo "--- Step 2: Inspect what Claude did ---"

echo "Crontab:"
cat "$TEST_DIR/.cron/crontab" 2>/dev/null || echo "(empty or missing)"
echo ""

# Verify Claude wrote something to the crontab
if [[ ! -s "$TEST_DIR/.cron/crontab" ]]; then
  echo "FAIL: Crontab is empty — Claude didn't schedule anything"
  exit 1
fi
echo "OK: Crontab has content"

# Verify it references disk-usage.log or du
if ! grep -qE 'du|disk.usage' "$TEST_DIR/.cron/crontab"; then
  echo "FAIL: Crontab doesn't contain the expected disk usage command"
  cat "$TEST_DIR/.cron/crontab"
  exit 1
fi
echo "OK: Crontab contains disk usage job"

# Check daemon is running
if [[ -f "$TEST_DIR/.cron/cron.pid" ]]; then
  DAEMON_PID=$(cat "$TEST_DIR/.cron/cron.pid")
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "OK: Daemon running (PID $DAEMON_PID)"
  else
    echo "FAIL: PID file exists but daemon is dead"
    exit 1
  fi
else
  echo "FAIL: No PID file — daemon never started"
  exit 1
fi

echo ""
echo "--- Step 3: Wait for the job to execute (~90s max) ---"

WAITED=0
MAX_WAIT=90
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if [[ -f "$TEST_DIR/disk-usage.log" ]]; then
    echo "Output file appeared after ${WAITED}s"
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  printf "  waiting... %ds\r" "$WAITED"
done
echo ""

echo ""
echo "--- Step 4: Verify results ---"

if [[ ! -f "$TEST_DIR/disk-usage.log" ]]; then
  echo "FAIL: disk-usage.log was not created after ${MAX_WAIT}s"
  echo ""
  echo "Debug — crontab:"
  cat "$TEST_DIR/.cron/crontab"
  echo ""
  echo "Debug — PID:"
  cat "$TEST_DIR/.cron/cron.pid" 2>/dev/null || echo "(missing)"
  echo ""
  echo "Debug — logs:"
  cat "$TEST_DIR/.cron/log/"*.log 2>/dev/null || echo "(no logs)"
  exit 1
fi

echo "disk-usage.log contents:"
cat "$TEST_DIR/disk-usage.log"
echo ""

# Verify it looks like du output (contains a size + path)
if grep -qE '[0-9]' "$TEST_DIR/disk-usage.log"; then
  echo "OK: Output contains disk usage data"
else
  echo "FAIL: Output doesn't look like du output"
  exit 1
fi

# Check daemon logs
echo ""
echo "--- Daemon logs ---"
LOG_DIR="$TEST_DIR/.cron/log"
if [[ -d "$LOG_DIR" ]]; then
  cat "$LOG_DIR"/*.log
  echo ""
  grep -c 'CMD' "$LOG_DIR"/*.log | while IFS=: read -r f c; do
    echo "OK: $c CMD entries in logs"
  done
  grep -q 'STARTUP' "$LOG_DIR"/*.log && echo "OK: STARTUP logged"
  grep -q 'CMDEND' "$LOG_DIR"/*.log && echo "OK: CMDEND logged"
else
  echo "WARN: No log directory"
fi

echo ""
echo "=== PASS: Integration test succeeded ==="
echo "Claude scheduled a disk usage monitor via cron. Job executed and produced output."
