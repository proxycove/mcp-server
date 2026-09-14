# ProxyCove MCP Server

**Let an AI agent buy and manage real proxies — no signup, no dashboard, no card details in the chat.**

[ProxyCove](https://proxycove.com) sells residential, mobile and datacenter proxies prepaid per GB across 170+ countries. This MCP server exposes that as 14 tools, so an agent can create its own account, hand the human a payment link, buy a proxy and get working connection credentials — all inside one conversation.

```
https://mcp.proxycove.com/mcp     ← remote endpoint (streamable HTTP)
```

> **Status: private beta.** The service is live and in daily use, but the public
> endpoint above opens with the public launch. Watch this repository — the URL
> and the setup snippets below are final and will work as written on day one.

**Who it's for:** developers building scraping / automation / testing agents, anyone whose agent needs an exit IP in a specific country, and MCP clients that want a proxy provider they can call directly instead of wrapping a REST API by hand.

**What an agent can do end to end**

1. `create_account` → gets an API key (`pc_live_...`). No registration form, no email required.
2. `create_topup` → gets a `payment_url`. The **human** pays in the browser (SBP, bank card, crypto).
3. `buy_proxy` → gets `http://login:password@go.proxycove.com:824` and starts using it.

Prices: **residential $2.7/GB · mobile $3.8/GB · datacenter $1.5/GB.** Traffic is prepaid and does not expire while the account is active.

---

## Quick start

The server is remote — nothing to install. Add the endpoint to your client and (once you have a key) send it as a bearer token.

You can add the connector **without a key**: `get_pricing`, `list_locations` and `create_account` work unauthenticated. Run `create_account`, save the returned `pc_live_...` key, put it in the header, reconnect.

### Claude Code

```bash
claude mcp add --transport http proxycove https://mcp.proxycove.com/mcp \
  --header "Authorization: Bearer pc_live_YOUR_KEY"
```

Without a key yet (to call `create_account` first):

```bash
claude mcp add --transport http proxycove https://mcp.proxycove.com/mcp
```

### Claude Desktop / Claude.ai (Connectors)

Settings → **Connectors** → **Add custom connector**

| Field | Value |
| --- | --- |
| Name | `ProxyCove` |
| Remote MCP server URL | `https://mcp.proxycove.com/mcp` |

Until OAuth ships, Claude Desktop can also reach the server through the stdio bridge, which is where the header lives:

```json
{
  "mcpServers": {
    "proxycove": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp.proxycove.com/mcp",
        "--header", "Authorization: Bearer pc_live_YOUR_KEY"
      ]
    }
  }
}
```

### ChatGPT (developer mode)

Settings → **Connectors** → **Advanced** → enable **Developer mode**, then **Create**:

| Field | Value |
| --- | --- |
| Name | `ProxyCove` |
| MCP server URL | `https://mcp.proxycove.com/mcp` |
| Authentication | Access token / API key → paste `pc_live_YOUR_KEY` |

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "proxycove": {
      "url": "https://mcp.proxycove.com/mcp",
      "headers": {
        "Authorization": "Bearer pc_live_YOUR_KEY"
      }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.proxycove]
url = "https://mcp.proxycove.com/mcp"
bearer_token_env_var = "PROXYCOVE_API_KEY"
```

```bash
export PROXYCOVE_API_KEY=pc_live_YOUR_KEY
```

### Any other MCP client

```json
{
  "mcpServers": {
    "proxycove": {
      "type": "http",
      "url": "https://mcp.proxycove.com/mcp",
      "headers": {
        "Authorization": "Bearer pc_live_YOUR_KEY"
      }
    }
  }
}
```

Transport is **streamable HTTP, stateless** — `POST` only, one JSON-RPC request per call, no SSE stream and no session id. `GET`/`DELETE` on the endpoint return `405`.

---

## Tools

| Tool | What it does | API key |
| --- | --- | --- |
| `get_pricing` | Price per GB (USD) for residential / mobile / datacenter | no |
| `list_locations` | Countries available for a given proxy type | no |
| `create_account` | Creates an account with no signup form, returns a `pc_live_...` key | no |
| `get_account` | Balance (USD), attached email, number of active proxies | yes |
| `create_topup` | Creates an invoice, returns `payment_url` for the human | yes |
| `get_payment_status` | Invoice status: `pending` / `paid` / `cancelled` | yes |
| `buy_proxy` | Buys a proxy from the balance, returns connection credentials | yes |
| `list_proxies` | All proxies with remaining traffic and credentials | yes |
| `get_credentials` | Connection string for one proxy | yes |
| `extend_proxy` | Adds prepaid GB to an existing proxy (credentials unchanged) | yes |
| `get_usage` | Live used / remaining traffic for one proxy | yes |
| `set_rotation` | Rotate every request ↔ sticky IP for 1–120 minutes | yes |
| `link_telegram` | Returns a code to link the account to the Telegram bot (second way back in if the key is lost) | yes |
| `attach_recovery` | Attaches an email so the human can log in on the website | yes |

Read-only tools carry `readOnlyHint`. **No tool deletes anything** — there is no destructive operation in this server, and no tool can move money out of the account.

### Connection model

Every proxy is reachable at `go.proxycove.com`:

| Port | Behaviour |
| --- | --- |
| `824` | New IP on every request |
| `10000` | Sticky IP, held for the configured 1–120 minutes |

`set_rotation` switches a proxy between the two modes; the login and password stay the same.

> After `buy_proxy`, wait ~5 seconds before the first request. The country filter takes a moment to propagate upstream, and an immediate first request may exit from another country.

---

## Authentication

* The account API key looks like `pc_live_...` and is sent as `Authorization: Bearer pc_live_...`.
* `create_account` issues one. The three no-auth tools exist precisely so an agent can bootstrap: check prices, check countries, create the account — then the human stores the key in the connector config.
* The MCP server holds no state of its own. It forwards your `Authorization` header to the ProxyCove REST API and returns the JSON response.
* Calling an authenticated tool without a key returns a structured `no_api_key` error explaining what to do — not a crash.
* **OAuth 2.1 + PKCE is coming next**, which will remove the manual header step for clients that support it. The bearer key will keep working.

---

## Payments: the agent never touches card data

This is a hard boundary, enforced by the tool design:

* `create_topup` returns a **`payment_url`**. That is all the agent gets.
* The agent gives the URL to the human, who opens it in their own browser and pays there.
* Methods: `sbp` (Russian instant bank transfer), `card_ru`, `card_international`, `crypto`, `crypto_cryptomus`. Minimum top-up **$1.50**.
* No tool accepts a card number, CVV, or any payment credential. There is no field for one anywhere in the schema.
* The agent then polls `get_payment_status` until `paid` and continues.

Purchases (`buy_proxy`, `extend_proxy`) spend the **prepaid balance only**. An agent cannot spend money that the human has not already deposited.

---

## Self-hosting / running locally

The server is a thin, stateless wrapper over the public ProxyCove REST API — roughly 200 lines of Node with no database, no cache and no persistence. Self-host it if you want to audit the traffic, pin a version, or run it inside your own network.

**Requirements:** Node 20+ (or Docker).

```bash
git clone https://github.com/proxycove/mcp-server.git
cd mcp-server
npm install

export BACKEND_BASE_URL=https://proxycove.com
export MCP_PORT=4010
export MCP_SECRET_PATH=/mcp

npm start
# → http://localhost:4010/mcp
```

Docker:

```bash
docker build -t proxycove-mcp .
docker run -d --name proxycove-mcp \
  -p 4010:4010 \
  -e BACKEND_BASE_URL=https://proxycove.com \
  -e MCP_PORT=4010 \
  -e MCP_SECRET_PATH=/mcp \
  proxycove-mcp
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_PORT` | `4010` | Port the HTTP server listens on |
| `MCP_SECRET_PATH` | `/mcp` | Path the MCP endpoint is mounted at |
| `BACKEND_BASE_URL` | `http://backend:5000` | Base URL of the ProxyCove API; use `https://proxycove.com` when self-hosting |
| `PUBLIC_API_INVITE_CODE` | *(empty)* | Optional invite code forwarded by `create_account` |

Configuration is entirely from env — there is no config file and no secret baked into the image.

`GET /healthz` returns `{ "ok": true, "service": "proxycove-mcp" }`.

Point your client at your own instance the same way:

```json
{
  "mcpServers": {
    "proxycove": {
      "type": "http",
      "url": "http://localhost:4010/mcp",
      "headers": { "Authorization": "Bearer pc_live_YOUR_KEY" }
    }
  }
}
```

---

## REST API (non-MCP integrations)

Everything the MCP server does is available directly over HTTP — same endpoints, same key:

* Base URL: **`https://proxycove.com/api/v1`**
* OpenAPI spec: **`https://proxycove.com/api/v1/openapi.json`**

```bash
curl https://proxycove.com/api/v1/pricing

curl https://proxycove.com/api/v1/account \
  -H "Authorization: Bearer pc_live_YOUR_KEY"
```

Use this if you are writing a normal client, a LangChain/LlamaIndex tool, a CI job, or anything that is not an MCP host.

---

## Security

* **The API key is shown once**, at `create_account`. Save it immediately — ProxyCove cannot show it again.
* A key can be **revoked at any time** from the account on [proxycove.com](https://proxycove.com) or by writing to support. Revoking it kills agent access instantly; the balance and proxies stay.
* Run `attach_recovery` or `link_telegram` early. Without a recovery channel on the account, a lost key means a lost balance.
* Treat `pc_live_...` like a password: it is a spending credential. Never paste it into a shared chat, a public repo, or an issue on this tracker.
* Prefer env-var indirection (`bearer_token_env_var`, `${VAR}` substitution) over literal keys in config files that get committed.
* Found a vulnerability, or something that lets an agent spend more than it should? Email **support@proxycove.com** — please do not open a public issue for security reports.

---

## Contributing

Issues and pull requests are welcome — bug reports, client-config recipes for MCP hosts not covered above, and tool-description improvements especially. The tool schemas are the product surface here; if a description misled your agent, that is a bug worth filing.

## License

[MIT](LICENSE) © ProxyCove

---

**Website:** [proxycove.com](https://proxycove.com) · **MCP endpoint:** `https://mcp.proxycove.com/mcp` · **REST API:** `https://proxycove.com/api/v1` · **Support:** support@proxycove.com
