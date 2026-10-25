// Permission modes: when Island may act without asking.
//   ask    - ask before commands, mouse/keyboard control and connector tools
//   auto   - read-only things run; anything that could change the system still asks
//   bypass - never ask
// Hard limits (no passwords or payment details, takeover by moving the mouse) apply in
// every mode and live elsewhere.

const MODES = ['ask', 'auto', 'bypass'];
const modeOf = (settings) => (MODES.includes(settings.permissionMode) ? settings.permissionMode : 'ask');

// Cmdlets and programs that only read. A command is "safe" when every statement in it
// starts with one of these and nothing in it writes, deletes, starts or invokes.
const SAFE_VERBS = /^(get|test|measure|select|where|sort|format|group|compare|find|search|resolve|convertto|convertfrom|out-string|write-output|write-host|join-path|split-path)\b/i;
const SAFE_PROGRAMS = new Set([
  // Not here on purpose: wmic (can start programs), powercfg/route/arp (can change settings),
  // ping/nslookup/tracert (an address can carry data out to a website).
  'dir', 'ls', 'gci', 'cat', 'type', 'gc', 'echo', 'pwd', 'gl', 'gps', 'ps', 'gsv', 'where', 'whoami', 'hostname', 'ipconfig', 'systeminfo',
  'tasklist', 'netstat', 'ver', 'driverquery', 'getmac', 'fc', 'findstr', 'tree', 'sort',
  'measure', 'select', 'sls', '%', '?', 'foreach-object', 'foreach', 'where-object',
]);
const DANGER = [
  /(^|[^<])>{1,2}(?!\s*\$null)/, // redirection into files
  /\b(remove|set|new|add|clear|stop|start|restart|invoke|install|uninstall|update|enable|disable|rename|move|copy|push|pop|suspend|resume|register|unregister|import|export|out(?!-string)|tee|send|format(?=-volume)|connect|disconnect|mount|dismount|initialize|reset|restore|backup|grant|revoke|lock|unlock|protect|unprotect|write(?!-output|-host))-\w+/i, // acting cmdlets (Verb-Noun)
  /\b(iex|icm|saps|start|kill|del|erase|rd|rmdir|ri|rm|mv|move|cp|copy|ren|mkdir|md|ni|sc|tee|shutdown|restart|logoff|reg|netsh|bcdedit|diskpart|format|cipher|takeown|icacls|attrib|schtasks|wevtutil|vssadmin|net|setx|msiexec|winget|choco|scoop|curl|wget|iwr|irm|bitsadmin|certutil|cmd|powershell|pwsh|wscript|cscript|rundll32|mshta)\b(?!-)/i,
  /\.(kill|delete|remove|move|copy|write|set|create|start|invoke|close|dispose|open)\w*\s*\(/i, // .NET methods that act
  /\[(system\.)?(io\.file|io\.directory|diagnostics\.process|net\.|environment\]::set|microsoft\.win32\.registry)/i,
  /&\s*[\w'"$({]/, // call operator
  /\$\(\s*\)|`\s*$/, // obfuscation / line continuation games
  /-(force|recurse)\b/i,
  /\/(release|renew|flushdns|registerdns|setclassid)\b/i, // ipconfig switches that change the network
];

function isReadOnlyPowerShell(command) {
  const cmd = String(command || '').trim();
  if (!cmd || cmd.length > 2000) return false;
  if (DANGER.some((re) => re.test(cmd))) return false;
  // Every statement and every pipeline stage must start with a reading command
  // (assignments are fine if their right side is one).
  const statements = cmd.split(/[;\n]|&&|\|\|/).map((s) => s.trim()).filter(Boolean);
  for (const st of statements) {
    for (let stage of st.split('|').map((s) => s.trim()).filter(Boolean)) {
      stage = stage.replace(/^\$[\w:]+\s*=\s*/, '').replace(/^[(@]+/, '').trim();
      if (!stage) continue;
      if (/^\$[\w:.]+$/.test(stage) || /^[\d"'\[]/.test(stage)) continue; // a value or expression, e.g. "$x" or [math]::Round(...)
      const first = stage.split(/\s+/)[0].toLowerCase();
      if (SAFE_VERBS.test(first) || SAFE_PROGRAMS.has(first)) continue;
      return false;
    }
  }
  return true;
}

// Commands that remove, wipe or switch things off: always asked about, even inside an
// approved plan.
const DESTRUCTIVE = /\b(remove|clear|uninstall|disable|stop|format|reset|unregister|revoke)-\w+|\b(rm|del|erase|rd|rmdir|ri|format|shutdown|diskpart|bcdedit|cipher|takeown|icacls|vssadmin|wevtutil|reg\s+delete|schtasks\s+\/delete|net\s+user)\b|-recurse\b|-force\b/i;
const isDestructivePowerShell = (command) => DESTRUCTIVE.test(String(command || ''));

// Should this call ask the user first? kind: 'shell' | 'control' | 'file' | 'mcp'
// info.tainted: this turn has read outside content (web pages, connector results), which may
// carry planted instructions. From then on commands, file changes and connector tools that
// aren't strictly read-only always ask (unless the user chose Never asks).
// info.planApproved: the user pressed "OK all steps" on this turn's plan; then only deletes,
// destructive commands and connector tools marked destructive still ask (and tainted turns).
function needsApproval(kind, settings, info = {}) {
  const mode = modeOf(settings);
  if (mode === 'bypass') return false;
  if (info.tainted && (kind === 'shell' || kind === 'file')) return true;
  if (info.tainted && kind === 'mcp' && info.annotations?.readOnlyHint !== true) return true;
  if (info.planApproved) {
    if (kind === 'control') return false;
    if (kind === 'shell') return isDestructivePowerShell(info.command);
    if (kind === 'file') return info.op === 'delete';
    if (kind === 'mcp') return info.annotations?.destructiveHint === true;
  }
  if (kind === 'control') return mode === 'ask';
  if (kind === 'shell') return !(mode === 'auto' && isReadOnlyPowerShell(info.command));
  // File changes through Island's own tools can all be undone; Auto lets them run, except
  // deletes (still recoverable, but the most surprising if unwanted).
  if (kind === 'file') return mode === 'ask' || (mode === 'auto' && info.op === 'delete');
  if (kind === 'mcp') {
    if ((settings.mcpAllowed || []).includes(info.name)) return false;
    return !(mode === 'auto' && info.annotations?.readOnlyHint === true);
  }
  return true;
}

module.exports = { modeOf, needsApproval, isReadOnlyPowerShell, isDestructivePowerShell, MODES };
