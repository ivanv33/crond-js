# crond-js

Project-local cron daemon that reads a standard crontab file. Works on macOS and Linux, ships as an npm package with optional MCP integration for AI agent lifecycle management.

## Why

- **System cron** is global — one daemon per machine, can't scope to a project
- **npm cron packages** (`cron`, `node-cron`, `croner`) are libraries, not daemons
- **supercronic** does exactly the right thing but only ships Linux binaries

crond-js fills the gap: point it at a crontab file in your project directory and it runs.

## Install

```sh
npm install crond-js
```

Or run directly:

```sh
npx crond-js .cron/crontab
```

## Crontab format

Standard 5-field cron syntax. Put it in `.cron/crontab` (or wherever you like):

```crontab
# Check API health every 5 minutes
*/5 * * * *   ./scripts/check-health.sh

# Daily report at 9am weekdays
0 9 * * 1-5   ./scripts/daily-report.sh

# Clean tmp directory every hour
0 * * * *     rm -rf tmp/*
```

## CLI usage

```sh
# Foreground (logs to stdout + file)
crond-js .cron/crontab

# Background daemon
crond-js .cron/crontab -d
crond-js .cron/crontab --daemon

# Check status
crond-js .cron/crontab -s
crond-js .cron/crontab --status

# Stop daemon
crond-js .cron/crontab -k
crond-js .cron/crontab --stop

# Custom PID file location
crond-js .cron/crontab -d -p /tmp/my.pid
```

| Flag | Description |
|------|-------------|
| `-d`, `--daemon` | Run as background daemon |
| `-s`, `--status` | Check if daemon is running |
| `-k`, `--stop` | Stop the daemon |
| `-p`, `--pidfile` | Override PID file path (default: same dir as crontab) |

## MCP integration

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "cron": {
      "command": "npx",
      "args": ["-y", "crond-mcp", ".cron/crontab"]
    }
  }
}
```

The MCP server auto-starts the daemon if it's not running, and exposes a single `cron_status` tool:

```json
{
  "daemon_pid": 12345,
  "daemon_running": true,
  "jobs": [
    {
      "schedule": "*/5 * * * *",
      "command": "./scripts/check-health.sh",
      "last_run": "2026-03-15 14:05:01",
      "last_exit_code": "0",
      "next_run": "2026-03-15T18:10:00.000Z"
    }
  ]
}
```

Agents manage jobs by editing the crontab file directly — no custom MCP tools needed.

## How it works

- Re-reads the crontab file every 60 seconds (same as traditional crond)
- Commands run with `sh -c` in the crontab's directory
- Jobs still running when the next tick fires are skipped (no overlapping)
- Logs written to `.cron/log/YYYY-MM-DD.log` in crond format
- PID stored in `.cron/cron.pid`
- The daemon survives MCP session restarts — second sessions detect the existing daemon

### Log format

```
2026-03-15 01:05:01 crond-js[12345]: STARTUP (crond-js 1.0.0)
2026-03-15 01:05:01 crond-js[12345]: CMD (./scripts/check-health.sh)
2026-03-15 01:05:03 crond-js[12345]: CMDOUT (OK: 200)
2026-03-15 01:05:03 crond-js[12345]: CMDEND (./scripts/check-health.sh exit=0)
2026-03-15 01:10:01 crond-js[12345]: RELOAD (.cron/crontab)
```

### Project file layout

```
.cron/
  crontab       # the schedule (check into git)
  cron.pid      # daemon PID (gitignore)
  log/          # execution logs (gitignore)
```

## License

MIT
