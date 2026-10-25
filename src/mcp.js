'use strict';
/**
 * MCP (Model Context Protocol) client manager.
 *
 * Reads a Claude-Desktop-compatible config ({ "mcpServers": { name: cfg } }), connects to every
 * enabled server (stdio child processes or remote HTTP endpoints), and exposes their tools to the
 * agent as Anthropic-style tool definitions named `mcp__<server>__<tool>`.
 *
 * Design notes:
 *  - Each server entry carries a generation counter (`gen`). Every connect/teardown bumps it, so a
 *    slow connection attempt that finishes after the user disabled/removed/edited the server can
 *    tell it is stale and close itself instead of clobbering newer state.
 *  - call() never throws; every failure becomes an `isError` tool result the model can read.
 *  - The SDK is required lazily so app startup doesn't pay for zod/ajv unless MCP is used.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const IS_WIN = process.platform === 'win32';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;
const START_WAIT_MS = 3_000;      // how long start()/reload() wait before letting slow servers finish in background
const KILL_GRACE_MS = 1_500;      // after closing stdin, how long a stdio server gets to exit before a tree kill
const REFRESH_DEBOUNCE_MS = 200;
const STDERR_KEEP = 2048;
const MAX_TEXT = 40_000;
const MAX_DESC = 1000;
const MAX_NAME = 64;              // Anthropic tool-name limit
const MAX_TOOL_PAGES = 100;       // guards against a server that keeps returning cursors
const MAX_IMAGE_B64 = Math.floor((5 * 1024 * 1024 * 4) / 3); // ~5 MB decoded, the API's per-image cap
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// JSON-RPC / MCP error codes we special-case.
const ERR_CONNECTION_CLOSED = -32000;
const ERR_REQUEST_TIMEOUT = -32001;

let _sdk = null;
function sdk() {
  if (!_sdk) {
    _sdk = {
      Client: require('@modelcontextprotocol/sdk/client/index.js').Client,
      StdioClientTransport: require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport,
      DEFAULT_INHERITED_ENV_VARS: require('@modelcontextprotocol/sdk/client/stdio.js').DEFAULT_INHERITED_ENV_VARS,
      StreamableHTTPClientTransport: require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport,
      SSEClientTransport: require('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport,
      ToolListChangedNotificationSchema: require('@modelcontextprotocol/sdk/types.js').ToolListChangedNotificationSchema,
    };
  }
  return _sdk;
}

let CLIENT_VERSION = '1.0.0';
try { CLIENT_VERSION = require('../package.json').version || CLIENT_VERSION; } catch { /* packaged layouts may differ */ }

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const delay = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Pick the most useful stderr line for a one-line error. The last line is often noise
 * ("Node.js v22.x", a stack frame), so prefer the first error-looking line in the tail
 * (Node: "Error: Cannot find module", Python: "ModuleNotFoundError: ..."), else the last line.
 */
function stderrHint(stderr, fallbackToLast = true) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|exception|not recognized|cannot|denied|not found|fatal|failed|usage:/i.test(l));
  return clip(hit || (fallbackToLast ? lines.pop() || '' : ''), 300);
}

// cmd.exe's message when cross-spawn had to fall back to a shell for a command it couldn't resolve.
const CMD_NOT_FOUND = /is not recognized as an internal or external command/i;

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_') || '_';
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);

/** API-safe, unique, ≤64-char tool name. Hash suffix only when truncation or a collision forces it. */
function apiName(server, tool, taken) {
  const base = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  if (base.length <= MAX_NAME && !taken.has(base)) return base;
  const h = shortHash(`${server}\0${tool}`);
  let name = `${base.slice(0, MAX_NAME - h.length - 1)}_${h}`;
  for (let i = 2; taken.has(name); i++) {
    const suf = `${h}${i}`;
    name = `${base.slice(0, MAX_NAME - suf.length - 1)}_${suf}`;
  }
  return name;
}

/** Human-readable error text; strips the SDK's "MCP error -32xxx:" prefix and surfaces fetch causes. */
function errMsg(e) {
  if (e == null) return 'unknown error';
  let msg = e instanceof Error ? e.message : String(e);
  msg = msg.replace(/^MCP error -?\d+:\s*/, '').replace(/[\s:]+$/, '');
  // Transport errors carry the HTTP status as a positive `code` (McpError codes are negative).
  if (typeof e.code === 'number' && e.code >= 100 && e.code < 600 && !msg.includes(String(e.code))) {
    msg += ` (HTTP ${e.code})`;
  }
  const c = e && e.cause;
  const detail = c && (c.code || c.message);
  if (detail && !msg.includes(detail)) msg += ` (${detail})`;
  return msg || e.name || 'error';
}

/** stdio / sse / http, or null for an unusable entry. Claude Code's explicit `type` is honoured. */
function kindOf(cfg) {
  if (!isObj(cfg)) return null;
  if (cfg.type === 'sse' && typeof cfg.url === 'string') return 'sse';
  if (typeof cfg.url === 'string' && cfg.url) return 'http';
  if (typeof cfg.command === 'string' && cfg.command) return 'stdio';
  return null;
}

/** Identity of a server's connection settings; `disabled` is excluded so toggling isn't a "change". */
function cfgKey(cfg) {
  const { disabled, ...rest } = cfg; // eslint-disable-line no-unused-vars
  return JSON.stringify(rest);
}

/**
 * Child environment = full process.env + cfg.env (PATH, PATHEXT, etc. must survive for npx/uvx).
 * Windows env names are case-insensitive, but a JS object isn't: the SDK layers its own upper-case
 * whitelist (PATH, APPDATA, ...) underneath ours, so normalise those keys to avoid sending both
 * `Path` and `PATH` with different values.
 */
function buildEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (isObj(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      if (v == null) continue;
      if (IS_WIN) for (const ek of Object.keys(env)) if (ek.toUpperCase() === k.toUpperCase()) delete env[ek];
      env[k] = String(v);
    }
  }
  if (IS_WIN) {
    const inherited = new Set(sdk().DEFAULT_INHERITED_ENV_VARS);
    for (const k of Object.keys(env)) {
      const u = k.toUpperCase();
      if (u !== k && inherited.has(u)) { env[u] = env[k]; delete env[k]; }
    }
  }
  return env;
}

/** Kill a whole process tree. Needed on Windows: .cmd shims run as cmd.exe -> node, and
 *  TerminateProcess on cmd.exe would orphan the real server. */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!isAlive(pid)) return resolve();
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Close a connection (client + transport + child). Never rejects. */
async function shutdown(conn) {
  if (!conn) return;
  const closing = Promise.resolve().then(() => conn.client.close()).catch(() => {});
  if (IS_WIN && conn.pid) {
    // The SDK closes stdin, waits 2 s, then SIGTERMs only the direct child. Beat it to the punch
    // with a tree kill so grandchildren of cmd.exe don't survive. Decide by liveness, not by
    // `closing`: after a failed handshake the SDK has already started its own close, so ours
    // resolves immediately while the process is still running.
    await Promise.race([closing, delay(KILL_GRACE_MS)]);
    if (isAlive(conn.pid)) await killTree(conn.pid);
  }
  await closing;
}

/** Resolve/reject with `promise`, or reject as soon as `signal` aborts. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// ---------------------------------------------------------------------------------------------
// Tool definition / result conversion
// ---------------------------------------------------------------------------------------------

function normalizeSchema(schema) {
  if (!isObj(schema)) return { type: 'object', properties: {} };
  return { ...schema, type: 'object', properties: isObj(schema.properties) ? schema.properties : {} };
}

function pickAnnotations(tool) {
  const a = isObj(tool.annotations) ? tool.annotations : {};
  const out = {};
  for (const k of ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  if (out.title === undefined && typeof tool.title === 'string') out.title = tool.title;
  return out;
}

function toDef(name, server, tool) {
  const desc = String(tool.description || tool.title || tool.name).trim();
  return {
    name,
    description: clip(`[MCP: ${server}] ${desc}`, MAX_DESC),
    input_schema: normalizeSchema(tool.inputSchema),
    annotations: pickAnnotations(tool),
    server,
    tool: tool.name,
  };
}

/** MCP CallToolResult -> { content: Anthropic tool_result blocks, isError }. */
function convertResult(res) {
  const blocks = [];
  let budget = MAX_TEXT;
  let truncated = false;
  const pushText = (text) => {
    text = String(text ?? '');
    if (!text || truncated) return; // the API rejects empty text blocks
    if (text.length > budget) {
      blocks.push({ type: 'text', text: `${text.slice(0, budget)}\n…[output truncated at ${MAX_TEXT} characters]` });
      truncated = true;
      budget = 0;
      return;
    }
    budget -= text.length;
    blocks.push({ type: 'text', text });
  };

  const content = Array.isArray(res && res.content) ? res.content : [];
  for (const c of content) {
    if (!isObj(c)) continue;
    switch (c.type) {
      case 'text':
        pushText(c.text);
        break;
      case 'image': {
        let mime = String(c.mimeType || '').toLowerCase();
        if (mime === 'image/jpg') mime = 'image/jpeg';
        const ok = IMAGE_TYPES.has(mime) && typeof c.data === 'string' && c.data.length > 0;
        if (ok && c.data.length <= MAX_IMAGE_B64) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: c.data } });
        } else {
          pushText(`[image returned: ${mime || 'unknown type'}${ok ? ', too large to display' : ', unsupported format'}]`);
        }
        break;
      }
      case 'audio':
        pushText(`[audio returned: ${c.mimeType || 'unknown type'}]`);
        break;
      case 'resource': {
        const r = isObj(c.resource) ? c.resource : {};
        if (typeof r.text === 'string') pushText(r.text);
        else pushText(`[binary resource ${r.uri || '?'} (${r.mimeType || 'unknown type'})]`);
        break;
      }
      case 'resource_link':
        pushText(`[resource link: ${c.name || ''} ${c.uri || ''}]`.replace(/\s+\]/, ']'));
        break;
      default:
        pushText(JSON.stringify(c));
    }
  }

  if (!blocks.length && res && res.structuredContent !== undefined) {
    pushText(JSON.stringify(res.structuredContent, null, 2));
  }
  if (!blocks.length && res && res.toolResult !== undefined) {
    pushText(typeof res.toolResult === 'string' ? res.toolResult : JSON.stringify(res.toolResult, null, 2)); // pre-2025 servers
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '(no output)' });
  return { content: blocks, isError: !!(res && res.isError) };
}

const fail = (msg) => ({ content: [{ type: 'text', text: `MCP error: ${msg}` }], isError: true });

function normalizeArgs(args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return {}; }
  }
  return isObj(args) ? args : {};
}

// ---------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------

function createMcp({
  configPath,
  onChange,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  callTimeoutMs = CALL_TIMEOUT_MS,
  startWaitMs = START_WAIT_MS,
  // (name, cfg) -> cfg used to connect: lets the app add secrets kept outside the config
  // file and point node/npx at its built-in runtime. The config file is never changed.
  prepare = null,
  // Where the last known tool list of each server is kept, so servers can sleep until used.
  toolCachePath = null,
  idleMs = 10 * 60 * 1000, // a server stops after this long without a tool call (0 = never)
  learnIdleMs = 30 * 1000, // ...or this soon if it only started to report its tools
} = {}) {
  if (!configPath) throw new Error('createMcp: configPath is required');

  const clientInfo = { name: 'island-assistant', version: CLIENT_VERSION };
  let servers = new Map();   // name -> entry, in config-file order
  let index = new Map();     // api name -> { server, tool, def } for every enabled server with known tools
  let configError = null;
  let queue = Promise.resolve(); // serialises config-mutating operations
  let notifyQueued = false;
  let toolCache = {}; // name -> { key, tools }
  try { if (toolCachePath) toolCache = JSON.parse(fs.readFileSync(toolCachePath, 'utf8')) || {}; } catch { toolCache = {}; }
  const saveToolCache = () => {
    if (!toolCachePath) return;
    try { fs.writeFileSync(toolCachePath, JSON.stringify(toolCache)); } catch { /* ignore */ }
  };

  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function rebuildIndex() {
    const next = new Map();
    const taken = new Set();
    for (const s of servers.values()) {
      if (!s.enabled) continue;
      for (const t of s.tools) {
        const name = apiName(s.name, t.name, taken);
        taken.add(name);
        next.set(name, { server: s.name, tool: t.name, def: toDef(name, s.name, t) });
      }
    }
    index = next;
  }

  /** Rebuild the tool index now; coalesce onChange callbacks into one per tick. */
  function notify() {
    rebuildIndex();
    if (notifyQueued) return;
    notifyQueued = true;
    setImmediate(() => {
      notifyQueued = false;
      try { onChange && onChange(); } catch (e) { console.error('[mcp] onChange threw:', e); }
    });
  }

  // ---- config file -------------------------------------------------------------------------

  function writeConfigFile(data) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const tmp = `${configPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, configPath); // atomic, so a crash never leaves half a config
    } catch {
      // rename can fail on Windows if an editor/AV holds the file; fall back to a direct write.
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      fs.writeFileSync(configPath, text, 'utf8');
    }
  }

  /** Throws on unreadable/invalid JSON so mutations never overwrite a file the user broke by hand. */
  function readConfigFile() {
    let raw;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const fresh = { mcpServers: {} };
      writeConfigFile(fresh);
      return fresh;
    }
    raw = raw.replace(/^\uFEFF/, ''); // Notepad likes to add a BOM
    if (!raw.trim()) return { mcpServers: {} };
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in ${configPath}: ${e.message}`); }
    if (!isObj(data)) throw new Error(`Invalid MCP config in ${configPath}: expected a JSON object`);
    if (!isObj(data.mcpServers)) data.mcpServers = {};
    return data;
  }

  // ---- connection lifecycle ----------------------------------------------------------------

  function newEntry(name) {
    return {
      name, cfg: {}, key: null, enabled: false, state: 'disabled', error: null,
      tools: [], conn: null, attempt: null, connecting: null, stderr: '', gen: 0, refreshTimer: null,
      idleTimer: null, busy: 0,
    };
  }

  /** Invalidate the current generation and close whatever is open or in flight. */
  function teardown(s, clearTools) {
    s.gen++;
    clearTimeout(s.refreshTimer);
    s.refreshTimer = null;
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.connecting = null;
    const victims = [s.conn, s.attempt].filter(Boolean);
    s.conn = null;
    s.attempt = null;
    if (clearTools) s.tools = [];
    return Promise.all(victims.map(shutdown));
  }

  /** Called when an established connection drops (crash, server exit, network close). */
  function onClosed(s, client) {
    if (!s.conn || s.conn.client !== client) return; // intentional close or stale connection
    s.conn = null;
    clearTimeout(s.refreshTimer);
    s.state = 'error';
    const hint = stderrHint(s.stderr, false);
    s.error = `Server disconnected${hint ? `: ${hint}` : ''}`;
    // Keep s.tools: names stay resolvable so call() can transparently reconnect.
    notify();
  }

  function scheduleRefresh(s, client) {
    clearTimeout(s.refreshTimer);
    s.refreshTimer = setTimeout(async () => {
      s.refreshTimer = null;
      if (!s.conn || s.conn.client !== client) return;
      try {
        const tools = await listAllTools(client);
        if (!s.conn || s.conn.client !== client) return;
        s.tools = tools;
        notify();
      } catch (e) {
        console.warn(`[mcp] ${s.name}: tools refresh failed: ${errMsg(e)}`);
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  // Servers are separate programs (one started through npx is often 100-180 MB), so each runs
  // only while it's being used: it goes to sleep after a quiet spell and wakes on the next call.
  function touchIdle(s, ms = idleMs) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (!ms || !s.conn) return;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.busy > 0) return touchIdle(s, ms);
      if (!s.conn) return;
      teardown(s, false);
      s.state = 'sleeping';
      s.error = null;
      notify();
    }, ms);
    s.idleTimer.unref?.();
  }

  async function listAllTools(client) {
    if (!client.getServerCapabilities()?.tools) return [];
    const all = [];
    const seen = new Set();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
      for (const t of res.tools || []) {
        if (t && typeof t.name === 'string' && !seen.has(t.name)) { seen.add(t.name); all.push(t); }
      }
      cursor = res.nextCursor;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    // listTools() caches output-schema validators per page, so after paging only the last page
    // would be validated; re-cache the full set.
    if (typeof client.cacheToolMetadata === 'function') client.cacheToolMetadata(all);
    return all;
  }

  /** One handshake over `transport`. Resolves to a conn { client, transport, pid }. */
  async function attempt(s, gen, transport, timeoutMs, diag) {
    const { Client, ToolListChangedNotificationSchema } = sdk();
    const client = new Client(clientInfo, { capabilities: {} });
    const conn = { client, transport, pid: null };

    // Record the child pid as soon as it exists, so a hung handshake can still be tree-killed.
    const origStart = transport.start.bind(transport);
    transport.start = async () => {
      await origStart();
      if (typeof transport.pid === 'number') conn.pid = transport.pid;
    };

    client.onerror = (e) => {
      if (!conn.ready && (e instanceof SyntaxError || e?.name === 'ZodError' || /JSON/i.test(e?.message || ''))) {
        diag.badOutput = true;
      }
    };
    client.onclose = () => { diag.closed = true; onClosed(s, client); };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => scheduleRefresh(s, client));

    if (gen === s.gen) s.attempt = conn;
    let timer;
    try {
      await Promise.race([
        client.connect(transport, { timeout: timeoutMs }),
        // Backstop: transport.start() itself has no timeout (e.g. an SSE endpoint that never answers).
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Request timed out'), { code: ERR_REQUEST_TIMEOUT })), timeoutMs + 1000);
        }),
      ]);
      conn.ready = true;
      return conn;
    } catch (e) {
      shutdown(conn); // don't block error reporting on process teardown
      throw e;
    } finally {
      clearTimeout(timer);
      if (s.attempt === conn) s.attempt = null;
    }
  }

  async function openStdio(s, gen) {
    const { StdioClientTransport } = sdk();
    const cfg = prepare ? prepare(s.name, s.cfg) || s.cfg : s.cfg;
    const cwd = typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : os.homedir();
    // The SDK spawns via cross-spawn, which resolves PATHEXT shims (npx.cmd, uvx.exe, ...) and
    // wraps .cmd/.bat in `cmd.exe /d /s /c` with correct escaping, and sets windowsHide.
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: buildEnv(cfg.env),
      cwd,
      stderr: 'pipe',
    });
    const decoder = new StringDecoder('utf8');
    // Must consume stderr regardless, or a chatty server blocks once the pipe buffer fills.
    transport.stderr.on('data', (chunk) => {
      if (gen === s.gen) s.stderr = (s.stderr + decoder.write(chunk)).slice(-STDERR_KEEP);
    });

    const diag = {};
    try {
      return await attempt(s, gen, transport, connectTimeoutMs, diag);
    } catch (e) {
      const tail = stderrHint(s.stderr);
      const notFound = `Command not found: "${cfg.command}" (is it installed and on PATH?)`;
      if (e && e.code === 'ENOENT') {
        if (!fs.existsSync(cwd)) throw new Error(`Working directory not found: ${cwd}`);
        throw new Error(notFound);
      }
      if (CMD_NOT_FOUND.test(s.stderr)) throw new Error(notFound);
      if (e && e.code === ERR_REQUEST_TIMEOUT) {
        throw new Error(`Timed out after ${Math.round(connectTimeoutMs / 1000)}s waiting for the server to start${tail ? `: ${tail}` : ''}`);
      }
      if (diag.closed || (e && e.code === ERR_CONNECTION_CLOSED)) {
        let msg = 'Server process exited before completing the MCP handshake';
        if (diag.badOutput) msg += ' (it printed non-MCP output on stdout; is this an MCP server?)';
        throw new Error(tail ? `${msg}: ${tail}` : msg);
      }
      throw new Error(`${errMsg(e)}${tail ? `: ${tail}` : ''}`);
    }
  }

  async function openHttp(s, gen, kind) {
    const { StreamableHTTPClientTransport, SSEClientTransport } = sdk();
    const cfg = prepare ? prepare(s.name, s.cfg) || s.cfg : s.cfg;
    let url;
    try { url = new URL(cfg.url); } catch { throw new Error(`Invalid URL: ${cfg.url}`); }
    const headers = {};
    if (isObj(cfg.headers)) for (const [k, v] of Object.entries(cfg.headers)) if (v != null) headers[k] = String(v);
    const opts = Object.keys(headers).length ? { requestInit: { headers } } : {};
    const timeoutMsg = () => `Timed out after ${Math.round(connectTimeoutMs / 1000)}s connecting to ${url.origin}`;

    const started = Date.now();
    let firstErr = null;
    if (kind !== 'sse') {
      try {
        return await attempt(s, gen, new StreamableHTTPClientTransport(url, opts), connectTimeoutMs, {});
      } catch (e) {
        if (gen !== s.gen) throw e;
        if (e && e.code === ERR_REQUEST_TIMEOUT) throw new Error(timeoutMsg()); // a hang isn't a protocol mismatch
        // Network-level failure (refused, DNS, TLS): the host is unreachable, SSE won't fare better.
        if (e && (e.cause || /fetch failed/i.test(e.message))) throw new Error(`Cannot reach ${url.origin}: ${errMsg(e)}`);
        // An explicit `type: "http"` means the user knows it's Streamable HTTP; don't mask the real error.
        if (cfg.type === 'http' || cfg.type === 'streamable-http') throw new Error(errMsg(e));
        firstErr = e;
      }
    }
    // Legacy HTTP+SSE servers (2024-11-05 spec) reject the Streamable HTTP POST; retry that way.
    const remaining = Math.max(connectTimeoutMs - (Date.now() - started), 5000);
    try {
      return await attempt(s, gen, new SSEClientTransport(url, opts), remaining, {});
    } catch (e) {
      const second = e && e.code === ERR_REQUEST_TIMEOUT ? timeoutMsg() : errMsg(e);
      throw new Error(firstErr ? `${errMsg(firstErr)} (SSE fallback also failed: ${second})` : second);
    }
  }

  /** Start (or restart) a server's connection. The returned promise never rejects. */
  function connect(s, { clearTools = false } = {}) {
    teardown(s, clearTools);
    const gen = s.gen;
    s.state = 'connecting';
    s.error = null;
    s.stderr = '';
    notify();

    const p = (async () => {
      let conn = null;
      try {
        const kind = kindOf(s.cfg);
        if (!kind) throw new Error('Invalid config: needs "command" (stdio) or "url" (http)');
        conn = kind === 'stdio' ? await openStdio(s, gen) : await openHttp(s, gen, kind);
        if (gen !== s.gen) { await shutdown(conn); return; }
        s.conn = conn;
        const tools = await listAllTools(conn.client);
        if (gen !== s.gen) return; // superseded; whoever bumped gen closed s.conn
        s.tools = tools;
        s.state = 'connected';
        s.error = null;
        toolCache[s.name] = { key: s.key, tools };
        saveToolCache();
        touchIdle(s, learnIdleMs); // a tool call keeps it up longer
      } catch (e) {
        if (gen !== s.gen) return;
        s.state = 'error';
        s.error = errMsg(e);
        if (s.conn) { const c = s.conn; s.conn = null; shutdown(c); }
      } finally {
        if (gen === s.gen) { s.connecting = null; notify(); }
      }
    })();
    s.connecting = p;
    return p;
  }

  /** Diff the config against live state; returns promises for new connections and closures. */
  function applyConfig(data) {
    const next = new Map();
    const pending = [];
    const closing = [];
    for (const [name, cfg] of Object.entries(data.mcpServers)) {
      if (!isObj(cfg) || !name) continue;
      const s = servers.get(name) || newEntry(name);
      const key = cfgKey(cfg);
      const changed = s.key !== key;
      const wasEnabled = s.enabled;
      s.cfg = cfg;
      s.key = key;
      s.enabled = !cfg.disabled;
      if (!s.enabled) {
        if (wasEnabled || s.conn || s.attempt) closing.push(teardown(s, true));
        s.state = 'disabled';
        s.error = null;
      } else if (changed || !wasEnabled || s.state === 'error' || s.state === 'disabled') {
        const known = toolCache[name];
        if (idleMs && known && known.key === key && Array.isArray(known.tools) && s.state !== 'error') {
          // Tools already known: offer them without starting the program; it starts on first use.
          if (s.conn || s.attempt) closing.push(teardown(s, false));
          s.tools = known.tools;
          s.state = 'sleeping';
          s.error = null;
        } else {
          // Errored servers are retried too, so "reload" doubles as "retry" after the user fixes things.
          pending.push(connect(s, { clearTools: changed || !wasEnabled }));
        }
      }
      next.set(name, s);
    }
    for (const [name, s] of servers) {
      if (next.has(name)) continue;
      closing.push(teardown(s, true));
      delete toolCache[name];
      saveToolCache();
    }
    servers = next;
    notify();
    return { pending, closing };
  }

  function loadAndApply() {
    let data;
    try {
      data = readConfigFile();
      configError = null;
    } catch (e) {
      // Keep whatever is running; a typo in the file shouldn't disconnect everything.
      configError = errMsg(e);
      notify();
      return { pending: [], closing: [] };
    }
    return applyConfig(data);
  }

  /** Wait for connections, but no longer than `ms`; the rest finish in the background. */
  async function settle({ pending, closing }, ms) {
    await Promise.all(closing);
    if (pending.length) await Promise.race([Promise.allSettled(pending), delay(ms)]);
  }

  function statusOf(s) {
    const kind = kindOf(s.cfg);
    const out = {
      name: s.name,
      type: kind === 'http' || kind === 'sse' ? 'http' : 'stdio',
      enabled: s.enabled,
      state: s.state,
      error: s.error,
      tools: s.state === 'connected' || s.state === 'sleeping' ? s.tools.map((t) => ({ name: t.name, description: t.description || '' })) : [],
    };
    if (kind === 'stdio') {
      out.command = s.cfg.command;
      out.args = Array.isArray(s.cfg.args) ? s.cfg.args.map(String) : [];
    } else if (typeof s.cfg.url === 'string') {
      out.url = s.cfg.url;
    }
    if (s.stderr) out.stderr = s.stderr;
    return out;
  }

  // ---- public API --------------------------------------------------------------------------

  return {
    configPath,

    /** Last config-file read error (invalid JSON etc.), or null. */
    get configError() { return configError; },

    start() {
      return serial(() => settle(loadAndApply(), startWaitMs));
    },

    reload() {
      return serial(() => settle(loadAndApply(), startWaitMs));
    },

    stop() {
      return serial(async () => {
        const all = [...servers.values()].map((s) => teardown(s, true));
        servers = new Map();
        notify();
        await Promise.all(all);
      });
    },

    status() {
      return [...servers.values()].map(statusOf);
    },

    toolDefs() {
      const out = [];
      for (const ref of index.values()) {
        const s = servers.get(ref.server);
        if (s && s.enabled && (s.state === 'connected' || s.state === 'sleeping' || (s.state === 'connecting' && s.tools.length))) out.push(ref.def);
      }
      return out;
    },

    /** True for every toolDefs() name, and also for tools of an enabled server that is momentarily
     *  down after a crash (so routing still reaches call(), which reconnects). */
    has(name) {
      return index.has(name);
    },

    info(name) {
      const ref = index.get(name);
      if (!ref) return null;
      // What the user approved: if the server later changes this tool's description, inputs
      // or hints (a "rug pull"), the fingerprint changes and Island asks again.
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([ref.def.description, ref.def.input_schema, ref.def.annotations])).digest('hex').slice(0, 16);
      return { server: ref.server, tool: ref.tool, annotations: ref.def.annotations, description: ref.def.description, fingerprint };
    },

    /** Never throws. Abort via opts.signal; times out after callTimeoutMs. A sleeping server is
     *  woken first; it goes back to sleep after idleMs without calls. */
    async call(name, args, { signal } = {}) {
      const ref = index.get(name);
      const s = ref && servers.get(ref.server);
      if (s) s.busy++;
      try {
        if (!ref) return fail(`unknown tool "${name}"`);
        if (!s) return fail(`server "${ref.server}" is not configured`);
        if (!s.enabled) return fail(`server "${ref.server}" is disabled`);
        if (signal && signal.aborted) return fail('tool call was cancelled');

        if (!s.conn) {
          // Asleep, crashed or still starting: one (shared) connection attempt before giving up.
          const known = s.tools.find((t) => t.name === ref.tool);
          if (!s.connecting) connect(s);
          await abortable(s.connecting || Promise.resolve(), signal);
          if (!s.conn) return fail(`server "${s.name}" is unavailable: ${s.error || 'not connected'}`);
          // The user approved the tool as it was remembered; if the server now describes it
          // differently, don't run it (a "rug pull"). The next attempt asks the user again.
          const now = s.tools.find((t) => t.name === ref.tool);
          const sig = (t) => JSON.stringify([t?.description || '', t?.inputSchema || null, t?.annotations || null]);
          if (!now) return fail(`the ${s.name} connector no longer has a tool called "${ref.tool}"`);
          if (known && sig(known) !== sig(now)) return fail(`the ${s.name} connector changed what "${ref.tool}" does since it was last used. Try again so the user can review the change.`);
        }
        const res = await s.conn.client.callTool(
          { name: ref.tool, arguments: normalizeArgs(args) },
          undefined,
          { signal, timeout: callTimeoutMs },
        );
        return convertResult(res);
      } catch (e) {
        if (signal && signal.aborted) return fail('tool call was cancelled');
        if (e && e.code === ERR_REQUEST_TIMEOUT) return fail(`tool call timed out after ${Math.round(callTimeoutMs / 1000)}s`);
        return fail(errMsg(e));
      } finally {
        if (s) {
          s.busy--;
          touchIdle(s);
        }
      }
    },

    addServer(name, cfg) {
      return serial(async () => {
        if (typeof name !== 'string' || !name.trim()) throw new Error('Server name is required');
        if (!kindOf(cfg)) throw new Error('Server config needs "command" (stdio) or "url" (http)');
        const data = readConfigFile();
        data.mcpServers[name] = cfg;
        writeConfigFile(data);
        const r = applyConfig(data);
        await Promise.all(r.closing);
        const s = servers.get(name);
        if (s && s.connecting) await s.connecting;
        return s ? statusOf(s) : null;
      });
    },

    removeServer(name) {
      return serial(async () => {
        const data = readConfigFile();
        if (!Object.prototype.hasOwnProperty.call(data.mcpServers, name)) return false;
        delete data.mcpServers[name];
        writeConfigFile(data);
        await Promise.all(applyConfig(data).closing);
        return true;
      });
    },

    setEnabled(name, enabled) {
      return serial(async () => {
        const data = readConfigFile();
        const cfg = data.mcpServers[name];
        if (!isObj(cfg)) throw new Error(`Unknown MCP server: ${name}`);
        if (enabled) delete cfg.disabled;
        else cfg.disabled = true;
        writeConfigFile(data);
        const r = applyConfig(data);
        await Promise.all(r.closing);
        const s = servers.get(name);
        if (s && s.connecting) await s.connecting;
        return s ? statusOf(s) : null;
      });
    },

    /** Merge servers from Claude Desktop's config. `fromPath` overrides the default location. */
    importClaudeDesktop(fromPath) {
      return serial(async () => {
        const src = fromPath || path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
        let raw;
        try { raw = fs.readFileSync(src, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
        let theirs;
        try { theirs = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { throw new Error(`Invalid JSON in ${src}: ${e.message}`); }
        const incoming = isObj(theirs) && isObj(theirs.mcpServers) ? theirs.mcpServers : {};
        const data = readConfigFile();
        let n = 0;
        for (const [name, cfg] of Object.entries(incoming)) {
          if (!isObj(cfg) || Object.prototype.hasOwnProperty.call(data.mcpServers, name)) continue;
          data.mcpServers[name] = cfg;
          n++;
        }
        if (n) {
          writeConfigFile(data);
          await settle(applyConfig(data), startWaitMs);
        }
        return n;
      });
    },
  };
}

module.exports = { createMcp };
