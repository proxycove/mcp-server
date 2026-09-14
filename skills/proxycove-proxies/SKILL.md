---
name: proxycove-proxies
description: Buy and manage HTTP proxies (residential, mobile, datacenter) in 170+ countries through ProxyCove. Use when the user needs a proxy, an IP in a specific country, a rotating IP, a sticky session, or asks to top up / check / extend an existing ProxyCove account. Works without any signup form — the agent creates the account itself.
license: MIT
---

# ProxyCove — buying and managing proxies

Prepaid HTTP/HTTPS proxies billed per gigabyte. Traffic never expires while the
account is active. No signup form: you create the account, the human only pays.

## Setup

Connect the remote MCP server once:

```bash
claude mcp add --transport http proxycove https://mcp.proxycove.com/mcp
```

Or, in any client that reads `mcp.json`:

```json
{
  "mcpServers": {
    "proxycove": {
      "type": "http",
      "url": "https://mcp.proxycove.com/mcp",
      "headers": { "Authorization": "Bearer ${PROXYCOVE_API_KEY}" }
    }
  }
}
```

The `Authorization` header is **optional**: `get_pricing`, `list_locations` and
`create_account` answer without it. Everything account-related needs a key.

Without MCP, the same operations are plain HTTP at `https://proxycove.com/api/v1`
with `Authorization: Bearer pc_live_…`.

## The standard flow

1. **`get_pricing`** — per-GB price by type. Quote it before spending the human's money.
2. **`create_account`** — only if the user has no key yet. Returns `pc_live_…`.
   **Immediately tell the human to save this key** and offer to store it in the
   connector's Authorization header. It is the only thing tying them to the balance.
3. **`create_topup`** — returns `payment_url`. **Give the link to the human and stop.**
   They pay in their own browser. Never ask for card numbers, never try to pay.
4. **`get_payment_status`** — poll until `paid`. Don't poll faster than every few
   seconds, and tell the human what you are waiting for.
5. **`buy_proxy`** — `type` (`residential` | `mobile` | `datacenter`),
   `country` (ISO-3166 alpha-2, lowercase), `traffic_gb` (1–1000),
   optional `rotation`.
6. **`get_credentials`** — login and password. Connection string:
   `http://LOGIN:PASSWORD@go.proxycove.com:824`

## Choosing the proxy type

| Type | Use it for | Trade-off |
|---|---|---|
| `datacenter` | bulk fetching, cheap throughput, tolerant targets | cheapest, easiest to detect |
| `residential` | ad platforms, marketplaces, multi-accounting, most scraping | balanced default |
| `mobile` | the strictest targets, account warm-up | most trusted, slowest and priciest |

When the user has not said which they want, ask what the proxy is for rather than
guessing — the type is the decision that actually matters.

## Rotation

- `{"mode": "every_request"}` — a new IP on every request. For spreading load.
- `{"interval_minutes": N}` (1–120) — a sticky session. Needed whenever the target
  keeps a login session: an ad account, a marketplace cabinet, a messenger.

Change it later with `set_rotation`; no need to buy a new proxy.

## Rules that matter

- **Never handle payment details.** Your only role in payment is passing a link.
- **Never spend without saying the price first.** State cost and what it buys,
  then act.
- **A new account is anonymous.** If the key is lost and no recovery is attached,
  the balance is unreachable. After the first purchase, offer `attach_recovery`
  (email) or `link_telegram`.
- **Country codes are two letters.** `de`, `us`, `br` — not `Germany`, not `DEU`.
  If a purchase fails, check the country before blaming the balance.
- **Check `get_account` before buying.** Balance is prepaid; there is no overdraft.

## Recovering from errors

| Error | What it actually means |
|---|---|
| `insufficient_funds` | balance is genuinely too low → `create_topup` |
| `bad_request` | wrong country code, traffic outside 1–1000, bad rotation value |
| `no_api_key` | no key configured → `create_account`, or ask the human for theirs |
| `401` | key revoked in the dashboard → ask the human for a fresh one |

## Extending, not rebuying

If the user needs more traffic on a proxy they already have, use `extend_proxy`
with the proxy id, not `buy_proxy`. Check `get_usage` first to show how much is left.

## Full tool list

`get_pricing`, `list_locations`, `create_account`, `get_account`, `create_topup`,
`get_payment_status`, `buy_proxy`, `list_proxies`, `get_credentials`,
`extend_proxy`, `get_usage`, `set_rotation`, `link_telegram`, `attach_recovery`.

Docs: https://proxycove.com/en/ai-agents/ · API: https://proxycove.com/en/api-docs/
