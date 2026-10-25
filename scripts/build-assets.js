// Generates src/renderer/icons.js (Lucide) and src/renderer/logos.js (provider logos
// from @lobehub/icons-static-svg) so the app ships only the few SVGs it uses.
// Run: npm run assets
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LUCIDE = path.join(root, 'node_modules', 'lucide-static', 'icons');
const LOBE = path.join(root, 'node_modules', '@lobehub', 'icons-static-svg', 'icons');

// UI name -> Lucide icon
const ICONS = {
  send: 'arrow-up', screen: 'monitor', attach: 'paperclip', plus: 'plus', gear: 'settings', close: 'x', check: 'check', x: 'circle-x',
  copy: 'copy', globe: 'globe', terminal: 'square-terminal', clipboard: 'clipboard', app: 'layout-grid', folder: 'folder', file: 'file-text',
  music: 'music', timer: 'timer', cpu: 'cpu', open: 'external-link', sparkle: 'sparkles', brain: 'brain', key: 'key-round', cursor: 'mouse-pointer-2',
  hand: 'hand', type: 'keyboard', scroll: 'mouse', eye: 'eye', chevron: 'chevron-down', chevronRight: 'chevron-right', search: 'search', mic: 'mic',
  micOff: 'mic-off', live: 'audio-lines', history: 'history', pin: 'pin', edit: 'pencil', trash: 'trash-2', text: 'text-select',
  shield: 'shield-check', shieldAlert: 'shield-alert', shieldPlain: 'shield', zap: 'zap', plug: 'plug', server: 'server', question: 'message-circle-question',
  plan: 'list-checks', refresh: 'refresh-cw', power: 'power', user: 'user-round', info: 'info', alert: 'triangle-alert', arrowRight: 'arrow-right',
  upload: 'file-up', image: 'image', wand: 'wand-sparkles', layers: 'layers', book: 'book-open', clock: 'clock', star: 'star', palette: 'palette',
  sliders: 'sliders-horizontal', volume: 'volume-2', bell: 'bell', command: 'command', tag: 'tag', gauge: 'gauge', rocket: 'rocket', lock: 'lock',
  help: 'circle-help', circleCheck: 'circle-check', circleDot: 'circle-dot', circle: 'circle', todo: 'list-todo', hourglass: 'hourglass', scan: 'scan-eye',
  route: 'route', bot: 'bot', database: 'database', link: 'link', download: 'download', folderOpen: 'folder-open', more: 'ellipsis', pause: 'pause',
  play: 'play', undo: 'undo-2', list: 'list', note: 'notebook-pen', briefcase: 'briefcase', school: 'graduation-cap', bulb: 'lightbulb', scrollText: 'scroll-text',
  incognito: 'hat-glasses', eyeOff: 'eye-off', fileDown: 'file-down', maximize: 'maximize-2', minimize: 'minimize-2', branch: 'git-branch', retry: 'rotate-ccw',
};

// Provider logo key -> lobehub file (color variants keep brand colours; mono ones use currentColor)
const LOGOS = {
  // Hand-picked for the providers the app ships with: model vendors, gateways and search.
  anthropic: 'claude-color', openai: 'openai', gemini: 'gemini-color', gemma: 'gemma-color', xai: 'grok', deepseek: 'deepseek-color',
  qwen: 'qwen-color', moonshot: 'moonshot', zhipu: 'zhipu-color', mistral: 'mistral-color', meta: 'meta-color', nous: 'nousresearch',
  cohere: 'cohere-color', minimax: 'minimax-color', nvidia: 'nvidia-color', ibm: 'ibm', tencent: 'hunyuan-color', baidu: 'wenxin-color',
  xiaomi: 'xiaomimimo', microsoft: 'microsoft-color', bytedance: 'bytedance-color', stepfun: 'stepfun-color', upstage: 'upstage-color', reka: 'reka',
  inception: 'inception', poolside: 'poolside-color', antgroup: 'antgroup-color', fireworks: 'fireworks-color', together: 'together-color', huggingface: 'huggingface-color',
  openrouter: 'openrouter-color', perplexity: 'perplexity-color', amazon: 'aws-color', alibaba: 'alibaba-color', ai21: 'ai21', baichuan: 'baichuan-color',
  liquid: 'liquid', sakana: 'sakana-color', morph: 'morph-color', databricks: 'dbrx-color', sambanova: 'sambanova-color', internlm: 'internlm-color',
  yi: 'yi-color', unsloth: 'unsloth-color', aionlabs: 'aionlabs', arcee: 'arcee-color', cognition: 'devin-color', ai2: 'ai2-color',
  siliconcloud: 'siliconcloud-color', novita: 'novita-color', hyperbolic: 'hyperbolic-color', deepinfra: 'deepinfra-color', cerebras: 'cerebras-color', aihubmix: 'aihubmix',
  opencode: 'opencode', elevenlabs: 'elevenlabs', jina: 'jina', snowflake: 'snowflake-color', aihub: 'aihubmix', openrouterfree: 'openrouter-color',
  firecrawl: 'firecrawl-color', tavily: 'tavily-color', brave: 'brave-color', exa: 'exa-color', searxng: 'searxng-color', google: 'google-color',

  // Every other brand in @lobehub/icons-static-svg, keyed by its lobehub slug, so that no
  // provider in a long list has to fall back to a letter. Colour variant when there is one,
  // otherwise the plain square mark - never a wordmark, it letterboxes to an unreadable strip.

  // 0
  '01-ai': 'zeroone-color',
  '01.ai': 'zeroone-color',
  '01ai': 'zeroone-color',

  // a
  ace: 'ace',
  adobe: 'adobe-color',
  adobefirefly: 'adobefirefly-color',
  agui: 'agui',
  agentvoice: 'agentvoice-color',
  agnesai: 'agnesai',
  ai21labs: 'ai21',
  ai302: 'ai302',
  ai360: 'ai360-color',
  aimass: 'aimass-color',
  'aion-labs': 'aionlabs',
  airjelly: 'airjelly-color',
  aistudio: 'aistudio',
  akashchat: 'akashchat-color',
  alephalpha: 'alephalpha',
  alibabacloud: 'alibabacloud-color',
  amdradeoncloud: 'amdradeoncloud-color',
  amp: 'amp-color',
  anspire: 'anspire-color',
  anthracite: 'huggingface-color',
  antigravity: 'antigravity-color',
  anyscale: 'anyscale-color',
  apertis: 'apertis-color',
  apple: 'apple',
  arceeai: 'arcee-color', 'arcee-ai': 'arcee-color',
  askverdict: 'askverdict-color',
  assemblyai: 'assemblyai-color',
  atlascloud: 'atlascloud',
  automatic: 'automatic-color',
  aws: 'aws-color',
  aya: 'aya-color',
  azure: 'azure-color',
  azureai: 'azureai-color',

  // b
  baai: 'baai',
  baiducloud: 'baiducloud-color',
  bailian: 'bailian-color',
  baseten: 'baseten',
  bedrock: 'bedrock-color',
  bfl: 'bfl',
  bilibili: 'bilibili-color',
  bilibiliindex: 'bilibiliindex',
  bing: 'bing-color',
  bocha: 'bocha-color',
  briaai: 'briaai-color',
  browserless: 'browserless',
  burncloud: 'burncloud-color',
  'bytedance-seed': 'bytedance-color',

  // c
  capcut: 'capcut',
  celestoai: 'celestoai-color',
  centml: 'centml-color',
  chatglm: 'chatglm-color',
  cherrystudio: 'cherrystudio-color',
  chutes: 'chutes',
  civitai: 'civitai',
  claude: 'claude-color',
  claudecode: 'claudecode-color',
  cline: 'cline',
  clipdrop: 'clipdrop',
  cloudflare: 'cloudflare-color',
  codebuddy: 'codebuddy',
  codeflicker: 'codeflicker-color',
  codegeex: 'codegeex-color',
  codex: 'codex-color',
  cogvideo: 'cogvideo-color',
  cogview: 'cogview-color',
  colab: 'colab-color',
  cometapi: 'cometapi-color',
  comfyui: 'comfyui-color',
  commanda: 'commanda-color',
  commandcode: 'commandcode',
  copilot: 'copilot-color',
  copilotkit: 'copilotkit-color',
  coqui: 'coqui-color',
  coze: 'coze',
  crewai: 'crewai',
  crusoe: 'crusoe-color',
  cursor: 'cursor',
  cybercut: 'cybercut',

  // d
  dalle: 'dalle-color',
  dbrx: 'dbrx-color',
  decart: 'decart-color',
  deepai: 'deepai',
  deepcogito: 'deepcogito-color',
  deepl: 'deepl-color',
  deepmind: 'deepmind-color',
  devin: 'devin-color',
  dify: 'dify-color',
  digitalocean: 'digitalocean',
  doc2x: 'doc2x-color',
  docsearch: 'docsearch-color',
  dolphin: 'dolphin',
  dots: 'dotsstudio',
  'dots-studio': 'dotsstudio',
  dotsstudio: 'dotsstudio',
  doubao: 'doubao-color',
  dreammachine: 'dreammachine',

  // e
  elevenx: 'elevenx',
  elorian: 'huggingface-color',
  essentialai: 'essentialai-color',

  // f
  fal: 'fal-color',
  fastgpt: 'fastgpt-color',
  featherless: 'featherless-color',
  figma: 'figma-color',
  fishaudio: 'fishaudio',
  flora: 'flora',
  flowith: 'flowith',
  flux: 'flux',
  friendli: 'friendli',

  // g
  geminicli: 'geminicli-color',
  giteeai: 'giteeai',
  github: 'github',
  githubcopilot: 'githubcopilot',
  glama: 'glama',
  glif: 'glif',
  glmv: 'glmv-color',
  gmicloud: 'gmicloud',
  'google-gemini': 'gemini-color',
  googlecloud: 'googlecloud-color',
  goose: 'goose',
  gradio: 'gradio-color',
  greptile: 'greptile-color',
  grok: 'grok',
  groq: 'groq',
  gryphe: 'huggingface-color',

  // h
  hailuo: 'hailuo-color',
  haiper: 'haiper',
  happyhorse: 'happyhorse',
  hedra: 'hedra',
  hermesagent: 'hermesagent',
  higress: 'higress-color',
  huawei: 'huawei-color',
  huaweicloud: 'huaweicloud-color',
  hunyuan: 'hunyuan-color',

  // i
  'ibm-granite': 'ibm',
  ideogram: 'ideogram',
  iflytekcloud: 'iflytekcloud-color',
  inceptron: 'inceptron-color',
  inclusionai: 'antgroup-color',
  inference: 'inference',
  'inference-net': 'inference',
  infermatic: 'infermatic-color',
  infinigence: 'infinigence-color',
  inflection: 'inflection',
  ionet: 'ionet',

  // j
  jimeng: 'jimeng-color',
  junie: 'junie-color',

  // k
  kagi: 'kagi',
  kilocode: 'kilocode',
  kimi: 'kimi',
  kiro: 'kiro-color',
  kling: 'kling-color',
  kluster: 'kluster-color',
  kolors: 'kolors-color',
  krea: 'krea',
  kwaikat: 'kwaikat',
  kwaipilot: 'kwaipilot-color',

  // l
  lambda: 'lambda',
  langchain: 'langchain-color',
  langfuse: 'langfuse-color',
  langgraph: 'langgraph-color',
  langsmith: 'langsmith-color',
  leptonai: 'leptonai-color',
  lg: 'lg-color',
  lightricks: 'lightricks',
  liquidai: 'liquid',
  liquidl2: 'liquid',
  livekit: 'livekit-color',
  llamaindex: 'llamaindex-color',
  llava: 'llava-color',
  llmapi: 'llmapi-color',
  lmstudio: 'lmstudio',
  lobehub: 'lobehub-color',
  longcat: 'longcat-color',
  lovable: 'lovable-color',
  lovart: 'lovart',
  luma: 'luma-color',

  // m
  magic: 'magic',
  make: 'make-color',
  mancer: 'huggingface-color',
  manus: 'manus',
  mastra: 'mastra',
  mcp: 'mcp',
  mcpso: 'mcpso-color',
  meituan: 'longcat-color',
  meituanlongcat: 'longcat-color',
  menlo: 'menlo-color',
  meshy: 'meshy-color',
  'meta-llama': 'meta-color',
  metaai: 'metaai-color',
  metagpt: 'metagpt',
  midjourney: 'midjourney',
  modelscope: 'modelscope-color',
  monica: 'monica-color',
  moonshotai: 'moonshot',
  moxt: 'moxt-color',
  myshell: 'myshell-color',

  // n
  n8n: 'n8n-color',
  nanobanana: 'nanobanana-color',
  nebius: 'nebius',
  newapi: 'newapi-color',
  nex: 'huggingface-color',
  nextbit: 'nextbit-color',
  notebooklm: 'notebooklm',
  notion: 'notion',
  nousresearch: 'nousresearch',
  nova: 'nova',
  novelai: 'novelai',
  nplcloud: 'nplcloud-color',

  // o
  obsidian: 'obsidian-color',
  ollama: 'ollama',
  'openai-codex': 'codex-color',
  openchat: 'openchat-color',
  openclaw: 'openclaw-color',
  openhands: 'openhands-color',
  openhuman: 'openhuman',
  'openrouter-free': 'openrouter-color',
  openwebui: 'openwebui',

  // p
  palm: 'palm-color',
  parasail: 'parasail',
  perceptron: 'perceptron',
  phala: 'phala-color',
  phidata: 'phidata-color',
  phind: 'phind',
  pi: 'pi',
  pika: 'pika',
  pixverse: 'pixverse-color',
  player2: 'player2-color',
  poe: 'poe-color',
  pollinations: 'pollinations',
  ppio: 'ppio-color',
  prunaai: 'prunaai-color',
  pydanticai: 'pydanticai-color',

  // q
  qingyan: 'qingyan-color',
  qiniu: 'qiniu-color',
  qoder: 'qoder-color',

  // r
  railway: 'railway',
  recraft: 'recraft',
  relace: 'relace',
  replicate: 'replicate',
  replit: 'replit-color',
  reve: 'reve',
  roocode: 'roocode',
  rsshub: 'rsshub-color',
  runway: 'runway',
  rwkv: 'rwkv-color',

  // s
  sao10k: 'huggingface-color',
  scaledown: 'huggingface-color',
  scales: 'huggingface-color',
  search1api: 'search1api-color',
  searchapi: 'searchapi',
  sensenova: 'sensenova-color',
  'shanghai-ai': 'internlm-color',
  'silicon-cloud': 'siliconcloud-color',
  siliconflow: 'siliconcloud-color',
  sillytavern: 'sillytavern-color',
  skywork: 'skywork-color',
  slock: 'slock',
  smithery: 'smithery-color',
  sophnet: 'sophnet-color',
  sora: 'sora-color',
  spark: 'spark-color',
  speedai: 'speedai-color',
  stability: 'stability-color',
  statecloud: 'statecloud-color',
  straico: 'straico-color',
  streamlake: 'streamlake-color',
  submodel: 'submodel-color',
  suno: 'suno',
  sync: 'sync',

  // t
  targon: 'targon-color',
  tencentcloud: 'tencentcloud-color',
  thedrummer: 'huggingface-color',
  tiangong: 'tiangong-color',
  tii: 'tii-color',
  topazlabs: 'topazlabs',
  trae: 'trae-color',
  tripo: 'tripo-color',
  turix: 'turix',

  // u
  udio: 'udio-color',
  unbiased: 'huggingface-color',
  unionalpha: 'unionalpha-color',
  unstructured: 'unstructured-color',

  // v
  v0: 'v0',
  vectorizerai: 'vectorizerai',
  venice: 'venice-color',
  vercel: 'vercel',
  vertexai: 'vertexai-color',
  vidu: 'vidu-color',
  viggle: 'viggle',
  vllm: 'vllm-color',
  volcengine: 'volcengine-color',
  voyage: 'voyage-color',

  // w
  wafer: 'wafer',
  wandb: 'wandb-color',
  wavespeed: 'wavespeed',
  wenxin: 'wenxin-color',
  windsurf: 'windsurf',
  workersai: 'workersai-color',
  worldrouter: 'worldrouter',

  // x
  'x-ai': 'grok',
  xaiwordmark: 'xai',
  xiaomimimo: 'xiaomimimo',
  xinference: 'xinference-color',
  xpay: 'xpay-color',
  xuanyuan: 'xuanyuan-color',

  // y
  yandex: 'yandex',
  youmind: 'youmind',
  yuanbao: 'yuanbao-color',

  // z
  'z-ai': 'zai',
  zai: 'zai',
  zapier: 'zapier-color',
  zeabur: 'zeabur-color',
  zencoder: 'zencoder-color',
  zenmux: 'zenmux',
  zeroone: 'zeroone-color',
};

const read = (dir, name) => {
  const f = path.join(dir, `${name}.svg`);
  if (!fs.existsSync(f)) throw new Error(`missing icon: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

// Inner markup of a Lucide icon, re-wrapped with our stroke weight.
function lucide(name) {
  const inner = read(LUCIDE, name).replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return inner.replace(/\s*\n\s*/g, '').replace(/\s+\/>/g, '/>');
}

function logo(name) {
  return read(LOBE, name)
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/\s(height|width|style)="[^"]*"/g, '')
    .replace(/<svg /, '<svg aria-hidden="true" ');
}

const banner = (what) => `// Generated by scripts/build-assets.js from ${what}. Do not edit by hand.\n`;

const iconLines = Object.entries(ICONS).map(([k, v]) => `  ${k}: svg(${JSON.stringify(lucide(v))}),`);
const icons = `${banner('lucide-static (ISC)')}const svg = (d) =>
  \`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${d}</svg>\`;

window.ICONS = {
${iconLines.join('\n')}
  stop: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor"/></svg>',
};

window.STEP_ICONS = {
  screenshot: 'scan', zoom: 'search', cursor_position: 'cursor',
  left_click: 'cursor', right_click: 'cursor', middle_click: 'cursor', double_click: 'cursor', triple_click: 'cursor',
  left_click_drag: 'hand', left_mouse_down: 'hand', left_mouse_up: 'hand', mouse_move: 'cursor',
  scroll: 'scroll', type: 'type', key: 'command', hold_key: 'command', wait: 'hourglass',
};

window.TOOL_ICONS = {
  capture_screen: 'screen', read_clipboard: 'clipboard', write_clipboard: 'clipboard', launch_app: 'app', open_item: 'open', get_system_info: 'cpu',
  list_directory: 'folder', read_file: 'file', read_text_file: 'file', media_control: 'music', set_timer: 'timer', run_powershell: 'terminal', web_search: 'globe',
  web_fetch: 'globe', open_url: 'globe', search_web: 'globe', read_webpage: 'globe', remember: 'brain', forget: 'brain', update_memory: 'brain',
  recall_memory: 'brain', search_past_chats: 'history', list_windows: 'app', focus_window: 'app', ask_user: 'question', update_plan: 'plan', teach_step: 'school', teach_lesson: 'school', hand_over: 'hand', save_lesson_card: 'school', find_on_screen: 'search', read_screen_text: 'text', look_closely: 'scan', record_routine: 'circleDot', run_routine: 'route', list_routines: 'route', delete_routine: 'route', set_reminder: 'bell', list_reminders: 'bell', cancel_reminder: 'bell', pc_checkup: 'cpu', deleted_files: 'undo', create_spreadsheet: 'file', create_document: 'file', create_presentation: 'file', finish_task: 'circleCheck', create_folder: 'folder', move_item: 'folderOpen', delete_items: 'trash', write_text_file: 'file',
};
`;

// Provider keys can contain dashes or dots, so quote anything that is not a plain identifier.
const logoKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const logoLines = Object.entries(LOGOS).map(([k, v]) => `  ${logoKey(k)}: ${JSON.stringify(logo(v))},`);
const logos = `${banner('@lobehub/icons-static-svg (MIT)')}window.LOGOS = {
${logoLines.join('\n')}
};
`;

fs.writeFileSync(path.join(root, 'src', 'renderer', 'icons.js'), icons);
fs.writeFileSync(path.join(root, 'src', 'renderer', 'logos.js'), logos);
console.log(`icons: ${Object.keys(ICONS).length + 1}, logos: ${Object.keys(LOGOS).length}, ${(Buffer.byteLength(logos) / 1024).toFixed(1)} KB of logos`);
