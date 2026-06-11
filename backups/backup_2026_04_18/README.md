# VZ Bot

Autonomous AI agent for **Virtuozzo VHI 7.x**: accept commands, monitor infrastructure health, and perform actions via OpenStack-style APIs.

## Requirements

- **Node.js 22+**
- **VHI 7.x** endpoint (e.g. `https://172.16.218.7`) and Identity v3 credentials
- **Anthropic API key** (for Claude) – set `ANTHROPIC_API_KEY` in env

## Quick start

1. Copy env and set credentials (never commit `.env`):

   ```bash
   cp .env.example .env
   # Edit .env:
   #   VHI_USER=admin
   #   VHI_PASSWORD=your-vhi-password
   #   ANTHROPIC_API_KEY=your-claude-api-key
   #   LLM_PROVIDER=anthropic   (optional; default is anthropic)
   ```

2. Install and run:

   ```bash
   npm install
   npm start
   ```

3. Try the CLI (VHI only, no LLM):

   ```bash
   npm run cli:vhi list
   ```

4. Open the **web chat UI** in your browser:

   **http://localhost:18789**

   Or chat via HTTP:

   ```bash
   curl -X POST http://localhost:18789/api/chat -H "Content-Type: application/json" -d "{\"message\": \"List all VMs\"}"
   ```

## Environment

| Variable | Description |
|----------|-------------|
| `VHI_BASE_URL` | VHI base URL (e.g. `https://172.16.218.7`) |
| `VHI_USER` | Identity user (e.g. `admin`) |
| `VHI_PASSWORD` | Identity password (set in `.env` only; never commit) |
| `VHI_PROJECT_ID` | Project ID (default: `default`) |
| `LLM_PROVIDER` | `anthropic` (Claude) or `openai` when implemented |
| `LLM_MODEL` | Model name (e.g. `claude-sonnet-4-20250514`) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `PORT` | Gateway HTTP port (default: 18789) |
| `HEALTH_POLL_ENABLED` | Set to `0` to disable periodic health poll |
| `HEALTH_POLL_MINUTES` | Health poll interval (default: 5) |

## Project layout

- `src/vhi/` – VHI 7.x API client (identity, compute, block, network)
- `src/gateway/` – Router, conversation loop, memory, scheduler
- `src/llm/` – Claude provider, prompts, tool definitions
- `src/tools/` – Tools: list_vms, get_vm, reboot_vm, start_vm, stop_vm, run_health_check, list_volumes, list_networks
- `src/monitoring/` – Health poller, thresholds, alerts
- `src/skills/vhi-infra/skill.md` – Instructions for the LLM
- `memory/` – Persistent conversation storage (gitignored)

## Security

- Store all secrets in `.env` or a secrets manager; never in code or the plan.
- Destructive actions (e.g. delete server) require explicit confirmation in the flow.
- Run the bot in a restricted environment (e.g. container/VM) with minimal privileges.

## License

MIT