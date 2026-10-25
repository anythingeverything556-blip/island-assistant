// Connectors made one-click: a small catalog of MCP servers that work for regular users,
// Island's own Node runtime for node/npx (so nothing needs installing), and keys kept
// encrypted by Windows instead of sitting in the config file.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

// Only packages that are live on npm (several official servers were deprecated in 2025).
const CATALOG = [
  {
    id: 'files', name: 'Files on your PC', icon: 'folder',
    blurb: 'Read, search, create and organise files, only inside the folders you choose.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'],
    needs: [{ key: 'folders', type: 'folders', label: 'Folders Island may use' }],
  },
  {
    id: 'excel', name: 'Excel files', icon: 'file',
    blurb: 'Read and edit .xlsx spreadsheets directly, without opening Excel.',
    command: 'npx', args: ['-y', '@negokaz/excel-mcp-server'],
  },
  {
    id: 'browser', name: 'Browser automation', icon: 'globe',
    blurb: 'Island drives its own browser window to fill in forms, click through sites and test pages (Playwright).',
    command: 'npx', args: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'notion', name: 'Notion', icon: 'note',
    blurb: 'Search, read and update your Notion pages.',
    command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'],
    needs: [{ key: 'token', type: 'secret', env: 'NOTION_TOKEN', label: 'Notion integration token', help: 'Create one at notion.so/my-integrations, then share the pages you want with it.' }],
  },
  {
    id: 'thinking', name: 'Step-by-step thinking', icon: 'bulb',
    blurb: 'Helps smaller or faster models plan long tasks before acting.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'github', name: 'GitHub', icon: 'link', dev: true,
    blurb: "Issues, pull requests and code, through GitHub's official server.",
    url: 'https://api.githubcopilot.com/mcp/',
    needs: [{ key: 'token', type: 'secret', header: 'Authorization', format: 'Bearer {}', label: 'GitHub personal access token', help: 'Create one at github.com/settings/tokens.' }],
  },
  {
    id: 'docs', name: 'Code docs (Context7)', icon: 'book', dev: true,
    blurb: 'Up-to-date documentation for programming libraries, for coding questions.',
    command: 'npx', args: ['-y', '@upstash/context7-mcp'],
  },
  {
    id: 'firecrawl', name: 'Firecrawl', icon: 'globe', logo: 'firecrawl',
    blurb: 'Search the web and read any page as clean text, so Island can answer with facts from any site.',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    needs: [{ key: 'key', type: 'secret', header: 'Authorization', format: 'Bearer {}', label: 'Firecrawl API key', help: 'Get one at firecrawl.dev. The first 1,000 credits a month are free, and no card is needed.' }],
  },
  {
    id: 'firecrawlLocal', name: 'Firecrawl (on your PC)', icon: 'server', logo: 'firecrawl',
    blurb: 'The same Firecrawl tools, running on your own computer instead of on Firecrawl\'s server.',
    command: 'npx', args: ['-y', 'firecrawl-mcp'],
    needs: [{ key: 'key', type: 'secret', env: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', help: 'Get one at firecrawl.dev. The first 1,000 credits a month are free, and no card is needed.' }],
  },
];

// Is a program on PATH? (node.exe, npx.cmd, ...)
function onPath(name, envPath = process.env.PATH || '') {
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';');
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      try { if (fs.statSync(path.join(dir, name + ext.toLowerCase())).isFile()) return true; } catch {}
    }
  }
  return false;
}

// node/npx/npm for connectors: the user's own Node if installed, else Island's (Electron
// run as Node, plus the npm that ships with Island), via small .cmd shims on PATH.
function createRuntime(dir) {
  const own = onPath('node');
  let shims = null;
  const ensureShims = () => {
    if (shims) return shims;
    const npmDir = path.dirname(require.resolve('npm/package.json')).replace('app.asar', 'app.asar.unpacked');
    fs.mkdirSync(dir, { recursive: true });
    const head = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n`;
    fs.writeFileSync(path.join(dir, 'node.cmd'), `${head}"${process.execPath}" %*\r\n`);
    fs.writeFileSync(path.join(dir, 'npx.cmd'), `${head}"${process.execPath}" "${path.join(npmDir, 'bin', 'npx-cli.js')}" %*\r\n`);
    fs.writeFileSync(path.join(dir, 'npm.cmd'), `${head}"${process.execPath}" "${path.join(npmDir, 'bin', 'npm-cli.js')}" %*\r\n`);
    shims = dir;
    return shims;
  };
  return {
    // e.g. "your Node v22" or "Island's built-in Node v24"
    describe: () => (own ? 'your own Node' : `Island's built-in Node ${process.versions.node ? 'v' + process.versions.node : ''}`.trim()),
    usesBuiltIn: () => !own,
    // PATH for a server whose command is node/npx/npm, or null to leave it alone.
    pathFor(command, force = false) {
      if (!/^(npx|node|npm)(\.cmd|\.exe)?$/i.test(String(command || ''))) return null;
      if (own && !force) return null;
      return `${ensureShims()}${path.delimiter}${process.env.PATH || ''}`;
    },
  };
}

// Keys for connectors, encrypted with the Windows user's key (safeStorage):
// { [server]: base64(encrypt(JSON { env: {...}, headers: {...} })) } in settings.
function createSecrets(settings) {
  const all = () => settings.load().mcpSecrets || {};
  return {
    get(name) {
      const enc = all()[name];
      if (!enc || !safeStorage.isEncryptionAvailable()) return null;
      try { return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))); } catch { return null; }
    },
    set(name, value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows can't encrypt keys right now, so the key wasn't saved.");
      settings.save({ mcpSecrets: { ...all(), [name]: safeStorage.encryptString(JSON.stringify(value)).toString('base64') } });
    },
    remove(name) {
      const next = { ...all() };
      delete next[name];
      settings.save({ mcpSecrets: next });
    },
  };
}

// Catalog entry + the user's answers -> { name, cfg, secret }
function buildFromCatalog(item, values = {}) {
  const cfg = item.url ? { url: item.url } : { command: item.command, args: [...item.args] };
  const secret = { env: {}, headers: {} };
  for (const need of item.needs || []) {
    const v = values[need.key];
    if (need.type === 'folders') {
      const folders = (Array.isArray(v) ? v : []).filter(Boolean);
      if (!folders.length) throw new Error('Choose at least one folder.');
      cfg.args.push(...folders);
    } else if (need.type === 'secret') {
      const s = String(v || '').trim();
      if (!s) throw new Error(`${need.label} is needed.`);
      if (need.env) secret.env[need.env] = s;
      if (need.header) secret.headers[need.header] = (need.format || '{}').replace('{}', s);
    }
  }
  const hasSecret = Object.keys(secret.env).length || Object.keys(secret.headers).length;
  return { cfg, secret: hasSecret ? secret : null };
}

module.exports = { CATALOG, createRuntime, createSecrets, buildFromCatalog, onPath };
