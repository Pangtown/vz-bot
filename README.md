# VZ Bot – Infrastructure System (V/IS) console

Web console and AI assistant for **Virtuozzo Hybrid Infrastructure (VHI) 7.x**. It manages VMs, volumes, networks, projects, migrations from VMware, cross-cluster disaster recovery, scheduled jobs, and billing across one or more clusters, through the same OpenStack-style APIs the VHI panel uses.

## Requirements

- **Node.js 22+**
- One or more **VHI 7.x** clusters (e.g. `https://172.16.218.7`) and Identity v3 credentials
- Optional: an LLM API key (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY`) for the AI Assistant

## Quick start

1. Copy the example environment file and fill it in (never commit `.env`):

   ```bash
   cp .env.example .env
   ```

   Two values are required:

   - `WEB_PASSWORD` – the console password. The dashboard, chat, and SSH routes refuse requests until it is set.
   - `CLUSTER_SECRET_KEY` – any long random string. It encrypts saved cluster passwords in `data/clusters.json`. Changing it makes saved passwords unreadable, so clusters would need their passwords re-entered.

2. Install and run:

   ```bash
   npm install
   npm start
   ```

3. Open **http://localhost:18789** (or the `PORT` you set) and sign in with a cluster's address, user, and password plus the console password. You stay signed in for that browser tab until you click **Disconnect** or are idle for 30 minutes.

4. Open **Clusters** to add more clusters. Their passwords are stored encrypted on the server, never in the browser.

## Environment

| Variable | Description |
|----------|-------------|
| `WEB_PASSWORD` | Required console password |
| `CLUSTER_SECRET_KEY` | Required key that encrypts saved cluster passwords |
| `PORT` | HTTP port (default: 18789) |
| `VHI_BASE_URL`, `VHI_USER`, `VHI_PASSWORD` | Optional default cluster, used by background health and billing polls when no cluster has been saved yet |
| `VHI_PROJECT_NAME`, `VHI_PROJECT_ID`, `VHI_DOMAIN_NAME` | Scope for that default cluster |
| `VHI_SSH_HOST`, `VHI_SSH_USER`, `VHI_SSH_PASSWORD` | Optional SSH access for `vinfra` commands (alerts, audit log, node details) |
| `LLM_PROVIDER`, `LLM_MODEL` | AI Assistant provider (`anthropic`, `gemini`, `openai`) and model |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | Key for the chosen provider |
| `HEALTH_POLL_ENABLED` | Set to `0` to disable the periodic health poll |
| `HEALTH_POLL_MINUTES` | Health poll interval (default: 5) |

Background health, billing, and node-inventory polls run against saved clusters (the first saved cluster for health and billing). Scheduled jobs, migrations, and DR plans store the credentials they were created with.

## Tests

```bash
npm test
```

## Project layout

- `public/` – Web console pages; shared session and sidebar code in `public/js/vhi-common.js`, dashboard panels in `public/js/vhi-dashboard.js` and `public/js/vhi-networks.js`
- `src/gateway/` – HTTP API (`vhi-api/`), console sessions, saved-cluster store, scheduler, jobs
- `src/vhi/` – VHI API clients (identity, compute, block, network, image), DR engine
- `src/vmware/` – VMware/ESXi migration engine
- `src/llm/` – AI Assistant providers, prompts, tool calling
- `src/tools/` – Tools the assistant can call
- `src/monitoring/` – Health, billing, audit, and alert pollers
- `scripts/` – One-off diagnostic scripts (run from the repo root, e.g. `node scripts/test_vhi.js`); not part of the app
- `data/` – Runtime state (gitignored)

## SSL & Certificates

The project includes tools for managing SSL certificates via Cloudflare and Let's Encrypt. See the following documentation in the `ssl/` directory:

- [Cloudflare SSL Guide](ssl/CLOUDFLARE-SSL-README.md) – Get certificates from Cloudflare.
- [Let's Encrypt SSL Guide](ssl/LETSENCRYPT-README.md) – Generate free certificates using Certbot.
- [Python Installation Fix](ssl/PYTHON-INSTALLATION-FIX.md) – Troubleshooting for Let's Encrypt prerequisites.

## Security

- Store all secrets in `.env` or a secrets manager; never in code.
- Cluster passwords saved through the console are encrypted with `CLUSTER_SECRET_KEY`. Scheduled jobs, migrations, and DR plans still keep their own credentials in `data/` unencrypted, so protect that folder.
- Destructive actions (e.g. delete server) require explicit confirmation in the flow.
- Run the bot in a restricted environment (e.g. container/VM) with minimal privileges.

## License

MIT
