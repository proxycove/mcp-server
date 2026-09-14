// ProxyCove MCP server — buy and manage proxies from an AI agent.
//
// Stateless streamable HTTP: a fresh server+transport pair is created per request,
// as recommended by the MCP SDK. Every tool is a thin wrapper over the public
// ProxyCove REST API (/api/v1) — this process keeps no database and no state.
//
// Auth: the client sends "Authorization: Bearer pc_live_..." and the header is
// forwarded upstream as-is. Three tools (get_pricing, list_locations,
// create_account) work without a key so an agent can bootstrap itself.
//
// Configuration comes entirely from environment variables — see .env.example.
import express from 'express';
import axios from 'axios';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = parseInt(process.env.MCP_PORT || '4010', 10);
const SECRET_PATH = process.env.MCP_SECRET_PATH || '/mcp';
const BACKEND = process.env.BACKEND_BASE_URL || 'http://backend:5000';
const INVITE_CODE = process.env.PUBLIC_API_INVITE_CODE || '';

const SERVER_INFO = { name: 'proxycove', version: '1.0.0' };
const INSTRUCTIONS = `ProxyCove — proxy service (residential / mobile / datacenter, pay per GB, no registration needed).
Typical flow for a new user:
1. create_account → returns an API key (pc_live_...). Tell the human to SAVE it; add it to this connector's Authorization header ("Bearer pc_live_...") for future sessions.
2. create_topup → returns payment_url. Give the link to the human — they pay in the browser (SBP / bank card / crypto). NEVER ask for card details.
3. Poll get_payment_status until "paid", then buy_proxy. Connection credentials come back immediately.
Prices: get_pricing. Traffic is prepaid per GB and never expires while the account is active.`;

// ── HTTP call to the ProxyCove REST API ──────────────────────────────────────
async function api(method, path, { auth, body, query, clientIp } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers['authorization'] = auth;
  // Without this the backend sees this container's own IP and treats every user in
  // the world as one address: a single agent would exhaust the signup rate limit
  // for everybody.
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  try {
    const resp = await axios({
      method,
      url: `${BACKEND}/api/v1${path}`,
      params: query,
      data: body,
      headers,
      timeout: 60000,
      validateStatus: () => true
    });
    return { status: resp.status, data: resp.data };
  } catch (e) {
    return { status: 0, data: { error: 'backend_unreachable', message: e.message } };
  }
}

const jsonText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const errText = (obj) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

const NEED_KEY_MSG = {
  error: 'no_api_key',
  message: 'No API key. Either call create_account first (new user), or ask the human for their existing pc_live_... key and configure it as the Authorization header of this MCP connector.'
};

// ── Tool definitions ─────────────────────────────────────────────────────────
function buildServer(authHeader, clientIp) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const auth = authHeader && authHeader.startsWith('Bearer pc_') ? authHeader : null;

  const needAuth = (fn) => async (args) => {
    if (!auth) return errText(NEED_KEY_MSG);
    return fn(args);
  };

  const pass = async (method, path, opts = {}) => {
    const out = await api(method, path, { ...opts, auth, clientIp });
    return out.status >= 200 && out.status < 300 ? jsonText(out.data) : errText(out.data);
  };

  server.registerTool('get_pricing', {
    title: 'Get pricing',
    description: 'Prices per GB (USD) for residential / mobile / datacenter proxies.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => pass('get', '/pricing'));

  server.registerTool('list_locations', {
    title: 'List available countries',
    description: 'Countries available for the given proxy type.',
    inputSchema: { type: z.enum(['residential', 'mobile', 'datacenter']).describe('Proxy type') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ type }) => pass('get', '/locations', { query: { type } }));

  server.registerTool('create_account', {
    title: 'Create ProxyCove account',
    description: 'Creates a new account WITHOUT registration forms and returns an API key (pc_live_...). The key is shown ONCE — tell the human to save it and add it as the Authorization header ("Bearer <key>") of this connector so future sessions keep access. Optional contact_email lets the human recover the account on proxycove.com later.',
    inputSchema: {
      label: z.string().max(80).optional().describe('Short account label, e.g. the human\'s project name'),
      contact_email: z.string().email().optional().describe('Optional email for account recovery')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ label, contact_email }) => {
    const out = await api('post', '/accounts', {
      body: { label, contact_email, source: 'mcp', invite_code: INVITE_CODE || undefined },
      clientIp
    });
    return out.status === 201 ? jsonText(out.data) : errText(out.data);
  });

  server.registerTool('get_account', {
    title: 'Get account and balance',
    description: 'Current balance (USD), attached email and number of active proxies.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, needAuth(async () => pass('get', '/account')));

  server.registerTool('create_topup', {
    title: 'Create top-up payment link',
    description: 'Creates an invoice and returns payment_url. Give the URL to the human — they open it in the browser and pay. Methods: sbp (Russian instant bank transfer, default for RU users), card_ru (Russian bank card), crypto (crypto via the RU provider), card_international (international card, best for non-RU users), crypto_cryptomus (crypto via Cryptomus — alternative crypto gateway). Agents must NEVER collect card details.',
    inputSchema: {
      amount_usd: z.number().min(1.5).max(10000).describe('Top-up amount in USD, min 1.5'),
      method: z.enum(['sbp', 'card_ru', 'crypto', 'card_international', 'crypto_cryptomus']).default('sbp').describe('Payment method')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, needAuth(async ({ amount_usd, method }) => pass('post', '/topup', { body: { amount_usd, method } })));

  server.registerTool('get_payment_status', {
    title: 'Check payment status',
    description: 'Status of an invoice: pending | paid | cancelled. Poll after the human opens the payment link.',
    inputSchema: { invoice_id: z.string().describe('Invoice id from create_topup') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, needAuth(async ({ invoice_id }) => pass('get', `/payments/${encodeURIComponent(invoice_id)}`)));

  server.registerTool('buy_proxy', {
    title: 'Buy proxy',
    description: 'Buys a proxy, deducting the account balance. Returns connection credentials (host go.proxycove.com, port 824 = new IP every request, port 10000 = sticky IP by interval). Check get_pricing × traffic_gb against the balance first. IMPORTANT: wait ~5 seconds after the purchase before sending the first request through the proxy — the country filter takes a moment to propagate at the upstream provider, so an immediate first request may exit from another country.',
    inputSchema: {
      type: z.enum(['residential', 'mobile', 'datacenter']).describe('Proxy type'),
      country: z.string().length(2).optional().describe('Country code, e.g. "br" for Brazil. Omit for mixed pool'),
      traffic_gb: z.number().int().min(1).max(1000).describe('Prepaid traffic in GB'),
      rotation_interval_minutes: z.number().int().min(1).max(120).optional().describe('Sticky IP: keep the same IP for N minutes. Omit = rotate on every request')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, needAuth(async ({ type, country, traffic_gb, rotation_interval_minutes }) => pass('post', '/proxies', {
    body: {
      type, country, traffic_gb,
      rotation: rotation_interval_minutes ? { interval_minutes: rotation_interval_minutes } : undefined
    }
  })));

  server.registerTool('list_proxies', {
    title: 'List proxies',
    description: 'All proxies of the account with remaining traffic and connection credentials.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, needAuth(async () => pass('get', '/proxies')));

  server.registerTool('get_credentials', {
    title: 'Get connection credentials',
    description: 'Connection string for one proxy: http://login:password@go.proxycove.com:port.',
    inputSchema: { proxy_id: z.string().describe('Proxy id from list_proxies') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, needAuth(async ({ proxy_id }) => pass('get', `/proxies/${encodeURIComponent(proxy_id)}/credentials`)));

  server.registerTool('extend_proxy', {
    title: 'Add traffic to proxy',
    description: 'Adds prepaid GB to an existing proxy (same credentials keep working). Deducts balance.',
    inputSchema: {
      proxy_id: z.string().describe('Proxy id'),
      traffic_gb: z.number().int().min(1).max(1000).describe('GB to add')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, needAuth(async ({ proxy_id, traffic_gb }) => pass('post', `/proxies/${encodeURIComponent(proxy_id)}/extend`, { body: { traffic_gb } })));

  server.registerTool('get_usage', {
    title: 'Get traffic usage',
    description: 'Live used / remaining traffic for one proxy.',
    inputSchema: { proxy_id: z.string().describe('Proxy id') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, needAuth(async ({ proxy_id }) => pass('get', `/proxies/${encodeURIComponent(proxy_id)}/usage`)));

  server.registerTool('set_rotation', {
    title: 'Change IP rotation',
    description: 'Switch between rotate-every-request (port 824) and sticky interval 1..120 minutes (port 10000).',
    inputSchema: {
      proxy_id: z.string().describe('Proxy id'),
      interval_minutes: z.number().int().min(1).max(120).optional().describe('Sticky interval; omit to rotate every request')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, needAuth(async ({ proxy_id, interval_minutes }) => pass('post', `/proxies/${encodeURIComponent(proxy_id)}/rotation`, {
    body: interval_minutes ? { interval_minutes } : { mode: 'every_request' }
  })));

  server.registerTool('link_telegram', {
    title: 'Link account to Telegram bot',
    description: 'Returns a short code the human sends to the ProxyCove Telegram bot (@ProxyCove_bot -> "Link website account"). After linking, the human can manage the account and issue new API keys from the bot — a second way to keep access if the API key is lost. Code expires in 30 minutes.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, needAuth(async () => pass('post', '/account/link-telegram')));

  server.registerTool('attach_recovery', {
    title: 'Attach recovery email',
    description: 'Attaches an email to the account so the human can log in on proxycove.com (via "Forgot password") and never lose the balance.',
    inputSchema: { email: z.string().email().describe('Human\'s email') },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, needAuth(async ({ email }) => pass('post', '/account/recovery', { body: { email } })));

  return server;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'proxycove-mcp' }));

// OAuth 2.1 protected-resource metadata. Clients such as Claude read this to
// learn that the service supports one-click sign-in and where its authorization
// server lives. Anonymous access is deliberately kept: get_pricing,
// list_locations and create_account still work without a key.
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const site = process.env.SITE_URL || 'https://proxycove.com';
  res.json({
    resource: `https://mcp.proxycove.com${SECRET_PATH}`,
    authorization_servers: [site],
    bearer_methods_supported: ['header'],
    scopes_supported: ['proxycove'],
    resource_documentation: `${site}/en/ai-agents/`
  });
});

app.post(SECRET_PATH, async (req, res) => {
  const clientIp = String(
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.socket?.remoteAddress || ''
  ).replace(/^::ffff:/, '').trim();
  const server = buildServer(req.headers['authorization'], clientIp);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true
  });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp] request error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

// GET/DELETE on the MCP path: the stateless mode supports neither SSE streams nor sessions
app.get(SECRET_PATH, (req, res) => res.status(405).json({
  jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: stateless server, POST only' }, id: null
}));
app.delete(SECRET_PATH, (req, res) => res.status(405).json({
  jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp] ProxyCove MCP server on :${PORT}, path ${SECRET_PATH}, backend ${BACKEND}`);
});
