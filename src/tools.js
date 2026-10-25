const { shell, nativeImage } = require('electron');
const clipboardApi = require('./clip');
const { spawn, execFileSync } = require('child_process');
const { runPowerShell } = require('./shell');
const web = require('./web');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectSecret, detectSensitive, askedToRemember } = require('./memory');
const docs = require('./docs');
const office = require('./office');
const pchelp = require('./pchelp');
const { describe: describeReminder } = require('./reminders');
const { describeStep, tidy: tidyRoutine } = require('./routines');
const vision = require('./vision');

const MAX_TEXT = 20000;

// ---------- helpers ----------

function clip(s, n = MAX_TEXT) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

function expandPath(p) {
  p = String(p).trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, os.homedir());
  p = p.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  return path.resolve(p);
}

let startAppsCache = { at: 0, apps: [] };
async function getStartApps() {
  if (Date.now() - startAppsCache.at < 10 * 60 * 1000 && startAppsCache.apps.length) return startAppsCache.apps;
  const r = await runPowerShell('Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress', { timeoutMs: 20000 });
  let apps = [];
  try { apps = [].concat(JSON.parse(r.stdout || '[]')); } catch {}
  startAppsCache = { at: Date.now(), apps };
  return apps;
}

function scoreName(name, q) {
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80 - (n.length - q.length) * 0.1;
  if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  return 0;
}

// Minimal JSON-schema check for our own tool schemas. Eager input streaming means the
// API no longer validates tool inputs for us, so a truncated/odd input must not run.
function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const req of schema.required || []) {
    if (input[req] === undefined) return `missing required field "${req}"`;
  }
  for (const [k, v] of Object.entries(input)) {
    const prop = schema.properties?.[k];
    if (!prop) continue; // extra fields are dropped before running (see execute)
    if (prop.enum && !prop.enum.includes(v)) return `"${k}" must be one of ${prop.enum.join(', ')}`;
    const t = prop.type;
    if (t === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
    if (t === 'boolean' && typeof v !== 'boolean') return `"${k}" must be a boolean`;
    if (t === 'array' && !Array.isArray(v)) return `"${k}" must be an array`;
    if ((t === 'number' || t === 'integer') && (typeof v !== 'number' || !Number.isFinite(v))) return `"${k}" must be a number`;
    if (t === 'integer' && !Number.isInteger(v)) return `"${k}" must be an integer`;
  }
  return null;
}

// Some models send arrays or objects as text ("275, 206", '{"type":"text"}'); accept them.
function coerce(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out = { ...input };
  for (const [k, v] of Object.entries(out)) {
    const prop = schema.properties?.[k];
    if (prop && Array.isArray(v) && prop.items?.type === 'object') { out[k] = v.map((x) => coerce(prop.items, x)); continue; }
    if (!prop || typeof v !== 'string') continue;
    if (prop.type === 'object') {
      try { out[k] = JSON.parse(v); } catch {}
    } else if (prop.type === 'array') {
      try { out[k] = JSON.parse(v); } catch {
        const nums = v.match(/-?\d+(\.\d+)?/g);
        if (nums && prop.items?.type === 'number') out[k] = nums.map(Number);
      }
    } else if ((prop.type === 'integer' || prop.type === 'number') && /^-?\d+(\.\d+)?$/.test(v.trim())) out[k] = Number(v);
  }
  return out;
}

// ---------- tool definitions ----------

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// How Island confirms a lesson step worked (teach_step and teach_lesson).
const EXPECT = {
  type: 'object',
  description: 'How Island can confirm the step worked, checked from the app right after the learner acts. Pick the most specific: text (what they should type: Island watches as they type, moves on when it is right and points out typos); toggled_on/toggled_off a toggle button (name: "Bold"); selected a tab, cell or item (name: "Insert"); opened a menu or dropdown (name of the button); appears / disappears a control, dialog or menu item (name: "Save As"); focused (keyboard focus on the named control); window_title (title contains text, e.g. the file name after saving); screen_changes (anything visibly changed, the weakest). For key presses use action press_key instead. Omit for steps that cannot be checked.',
  properties: {
    type: { type: 'string', enum: ['text', 'toggled_on', 'toggled_off', 'selected', 'opened', 'appears', 'disappears', 'focused', 'window_title', 'screen_changes'] },
    name: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['type'],
};
const TEACH_ACTIONS = ['click', 'double_click', 'right_click', 'type', 'press_key', 'drag', 'look'];
const KEY = { type: 'string', description: 'For action press_key: the key or combination, e.g. "Enter", "Tab", "Ctrl+B", "Ctrl+Z". Island detects the press itself.' };

const TOOLS = [
  {
    name: 'capture_screen',
    description:
      "Take a screenshot of the user's screen (the monitor the assistant bar is on) and look at it. Use whenever the user refers to something they are looking at, an error on screen, 'this', a window, a page, etc.",
    input_schema: obj({}),
    summary: () => 'Looking at your screen',
  },
  {
    name: 'read_clipboard',
    description: "Read the current contents of the user's clipboard (text or image).",
    input_schema: obj({}),
    summary: () => 'Reading clipboard',
  },
  {
    name: 'write_clipboard',
    description: "Copy text to the user's clipboard so they can paste it.",
    input_schema: obj({ text: { type: 'string', description: 'Text to copy' } }, ['text']),
    summary: (i) => `Copying ${i.text?.length ?? 0} chars to clipboard`,
  },
  {
    name: 'launch_app',
    description:
      'Launch an installed Windows application by its Start-menu name (e.g. "Spotify", "Visual Studio Code", "Calculator", "Settings"). Fuzzy-matched.',
    input_schema: obj({ name: { type: 'string', description: 'Application name' } }, ['name']),
    summary: (i) => `Launching ${i.name}`,
  },
  {
    name: 'open_item',
    description:
      'Open a protocol URI (ms-settings:display, mailto:…, spotify:…) or a file/folder path with its default handler. For web pages use open_url.',
    input_schema: obj({ target: { type: 'string', description: 'URI or absolute path. ~ and %ENV% are expanded.' } }, ['target']),
    summary: (i) => `Opening ${i.target}`,
  },
  {
    name: 'open_url',
    description:
      'Open a web page in a new tab of a browser the user already has open (or a new window). Pick the browser and profile the user asks for; "default" uses the system default browser. Opening in a specific profile reuses that profile\'s existing window. To load a page into the CURRENT tab instead, use focus_window plus the keyboard (Ctrl+L, type the URL, Enter).',
    input_schema: obj(
      {
        url: { type: 'string', description: 'http(s) URL' },
        browser: { type: 'string', enum: ['default', 'chrome', 'edge', 'brave', 'firefox'], description: 'Which browser (default: the system default)' },
        profile: { type: 'string', description: 'Chrome/Edge/Brave profile name, e.g. "Work". Omit to use the last-used profile.' },
        new_window: { type: 'boolean', description: 'Open in a new window instead of a new tab' },
      },
      ['url']
    ),
    summary: (i) => `Opening ${shortUrl(i.url)}${i.browser && i.browser !== 'default' ? ` in ${i.browser}` : ''}${i.profile ? ` (${i.profile})` : ''}`,
  },
  {
    name: 'list_windows',
    description:
      'List the open app windows (front to back) with their window id, app/process name, title and whether minimized. Use it to find the exact window the user means, e.g. which Chrome window or profile.',
    input_schema: obj({}),
    summary: () => 'Checking open windows',
  },
  {
    name: 'focus_window',
    description:
      'Bring a window to the front and give it keyboard focus (restoring it if minimized), by id from list_windows. More reliable than clicking taskbar icons. Returns the window that actually has focus afterwards.',
    input_schema: obj({ window_id: { type: 'integer', description: 'id from list_windows' } }, ['window_id']),
    summary: () => 'Switching window',
  },
  {
    name: 'get_system_info',
    description: 'Get live system status: CPU and RAM usage, uptime, battery, disk space, and the top processes by memory.',
    input_schema: obj({}),
    summary: () => 'Checking system status',
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory (name, type, size, modified time).',
    input_schema: obj({ path: { type: 'string', description: 'Directory path. ~ = user home.' } }, ['path']),
    summary: (i) => `Listing ${i.path}`,
  },
  {
    name: 'read_file',
    description: 'Read a file on the PC and get its contents: PDFs, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument, RTF, text, CSV, code and config files come back as text (spreadsheets as rows, slides one by one); images (.png .jpg .gif .webp .bmp) come back as a picture you can see. PDF pages without selectable text (scans) come back as pictures (or as text read off the pictures). For a PDF you can pick pages, and ask for them as pictures to see charts, forms, stamps or layout. Use this whenever the user asks about a file on their computer, instead of opening it on screen.',
    input_schema: obj({
      path: { type: 'string', description: 'Full file path. ~ = user home; %USERPROFILE%\\Downloads etc. work too.' },
      pages: { type: 'string', description: 'PDF only, optional: which pages, e.g. "1-3" or "2, 5, 9". Default: all.' },
      as_images: { type: 'boolean', description: 'PDF only, optional: also return those pages as pictures (up to 8 at a time). Pages without text are always sent as pictures.' },
    }, ['path']),
    summary: (i) => `Reading ${path.basename(String(i.path ?? ''))}`,
  },
  {
    name: 'media_control',
    description: 'Control media playback and system volume, like the keyboard media keys.',
    input_schema: obj(
      { action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute'] }, times: { type: 'integer', description: 'Repeat count for volume steps (default 1, each step = 2%)' } },
      ['action']
    ),
    summary: (i) => `Media: ${String(i.action).replace('_', ' ')}`,
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder for a clock time, once or repeating (medicine, appointments, bills, "every day at 8 am"). It is saved, survives restarts, pops up with a notification, and is read aloud. For "in N minutes" use in_minutes. Use set_timer only for short countdowns the user wants to watch.',
    input_schema: obj({
      text: { type: 'string', description: 'What to remind them, in their words, e.g. "Take your blood pressure tablet"' },
      time: { type: 'string', description: 'Local time "08:00" (next occurrence) or date and time "2026-10-20 17:30"' },
      in_minutes: { type: 'integer', description: 'Instead of time: minutes from now' },
      repeat: { type: 'string', enum: ['none', 'hourly', 'daily', 'weekdays', 'weekly'], description: 'Default none' },
      speak: { type: 'boolean', description: 'Read it aloud when it fires (default true)' },
    }, ['text']),
    summary: (i) => `Reminder: ${String(i.text ?? '').slice(0, 50)}`,
  },
  {
    name: 'list_reminders',
    description: 'List the user\'s upcoming reminders with their ids.',
    input_schema: obj({}),
    summary: () => 'Checking reminders',
  },
  {
    name: 'find_on_screen',
    description: 'Find exactly where a word, phrase, link or button text is on the screen (web pages, apps, documents) and get its click coordinates in screenshot pixels. If it is further down a page, it is scrolled into view first. Far more reliable than spotting small text in a screenshot or scrolling around looking for it: use it whenever you need to click or check specific words.',
    input_schema: obj({
      text: { type: 'string', description: 'The words to find, as they appear on screen, e.g. "Sign in" or "Download PDF"' },
      scroll: { type: 'boolean', description: 'Scroll the best match into view if it is off screen (default true)' },
      window: { type: 'string', description: 'Which window to look in, by app ("chrome", "Word") or part of its title. Default: the window in front. It is brought to the front.' },
    }, ['text']),
    summary: (i) => `Finding "${String(i.text ?? '').slice(0, 40)}" on screen`,
  },
  {
    name: 'read_screen_text',
    description: 'Get the real text of the window in front: a whole web page (including the parts below what is visible), a document, an email, an app. With visible_only, the text currently visible on screen, read by text recognition (works for pictures and apps that hide their text too). Use it to read long, small or hard-to-see text instead of zooming and scrolling through screenshots.',
    input_schema: obj({
      visible_only: { type: 'boolean', description: 'Only what is visible right now (default false: the whole page or document if possible)' },
      window: { type: 'string', description: 'Which window to read, by app ("chrome", "Word") or part of its title. Default: the window in front.' },
    }),
    summary: (i) => (i.visible_only ? 'Reading the text on screen' : 'Reading the page'),
  },
  {
    name: 'look_closely',
    description: 'Have a strong vision model study part of the screen, a window, or a picture file, and answer a precise question about it. It gets a sharp, enlarged view, reads text exactly, reads charts value by value, tables and forms field by field, describes photos and screens, and gives positions as (x, y) screenshot pixels you can click. It also returns the exact text Windows reads in that area. Use it whenever you are unsure what something on screen says or shows (small or dense text, a chart, a photo, a scanned form, an error dialog, icons), before acting on a guess. Works even if you cannot see images yourself.',
    input_schema: obj({
      question: { type: 'string', description: 'What to find out, specific: e.g. "What are the 5 tender numbers and closing dates in this table?", "What does the red error message say?", "Which product is cheapest and where is its Add to cart button?"' },
      region: { type: 'array', items: { type: 'number' }, description: 'Optional [x0, y0, x1, y1] in screenshot pixels: just that part of the screen (enlarged, so small things read well)' },
      window: { type: 'string', description: 'Optional: a window by app ("chrome", "Excel") or part of its title, instead of the whole screen' },
      file: { type: 'string', description: 'Optional: path of a picture file (png, jpg, webp, bmp, gif) to look at instead of the screen' },
    }, ['question']),
    summary: (i) => `Looking closely${i.file ? ` at ${path.basename(String(i.file))}` : ''}: ${String(i.question ?? '').slice(0, 50)}`,
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a reminder by id (from list_reminders).',
    input_schema: obj({ id: { type: 'string' } }, ['id']),
    summary: () => 'Cancelling a reminder',
  },
  {
    name: 'record_routine',
    description: 'Watch the user do a task once on their PC and save it as a routine you can repeat later ("let me show you", "watch me", "record this", "learn how I do it"). Island folds away and shows a small "Island is watching" card; the user does the task normally and presses "Done, save it". Clicks are saved by the control\'s name (not screen position) and typed text is saved; passwords are never recorded. Returns the saved steps. Saving with an existing name replaces that routine.',
    input_schema: obj({
      name: { type: 'string', description: 'Short name the user will use later, e.g. "Send the weekly report" or "Open my bank statement"' },
      description: { type: 'string', description: 'One line on what the task does' },
    }, ['name']),
    summary: (i) => `Watching you: ${String(i.name ?? '').slice(0, 50)}`,
  },
  {
    name: 'run_routine',
    description: 'Do a saved routine (from record_routine) on the screen, step by step, finding each control again by name. Use it whenever the user asks for a task they have recorded, instead of doing it from scratch. To change typed text (another name, date, amount), pass values with the step numbers from list_routines. If it stops at a step, do that step yourself from the screenshot, then call run_routine again with from_step to finish.',
    input_schema: obj({
      name: { type: 'string', description: 'Routine name (from list_routines)' },
      from_step: { type: 'integer', description: 'Start at this step (default 1)' },
      values: { type: 'array', description: 'Text to type instead of what was recorded', items: { type: 'object', properties: { step: { type: 'integer' }, text: { type: 'string' } }, required: ['step', 'text'] } },
    }, ['name']),
    summary: (i) => `Doing "${String(i.name ?? '').slice(0, 50)}"${i.from_step > 1 ? ` from step ${i.from_step}` : ''}`,
  },
  {
    name: 'list_routines',
    description: 'List the routines the user has shown Island (record_routine), with their steps.',
    input_schema: obj({}),
    summary: () => 'Checking saved routines',
  },
  {
    name: 'delete_routine',
    description: 'Delete a saved routine by name, when the user asks.',
    input_schema: obj({ name: { type: 'string' } }, ['name']),
    summary: (i) => `Deleting routine "${String(i.name ?? '').slice(0, 50)}"`,
  },
  {
    name: 'set_timer',
    description: 'Start a countdown timer shown live in the island; the user gets a notification when it ends. Use for reminders like "remind me in 10 minutes".',
    input_schema: obj(
      { seconds: { type: 'integer', description: 'Duration in seconds' }, label: { type: 'string', description: 'Short label, e.g. "Tea" or "Stand up"' } },
      ['seconds']
    ),
    summary: (i) => `Timer ${fmtDur(i.seconds)}${i.label ? ` · ${i.label}` : ''}`,
  },
  {
    name: 'create_folder',
    description: 'Create a new folder (and any missing parent folders). Use this rather than PowerShell for folders: the user can undo it. ~ = home; common places: ~/Desktop, ~/Documents, ~/Downloads.',
    input_schema: obj({ path: { type: 'string', description: 'Full path of the new folder' } }, ['path']),
    summary: (i) => `Creating folder ${path.basename(String(i.path ?? ''))}`,
  },
  {
    name: 'move_item',
    description: 'Move or rename a file or folder. Use this rather than PowerShell: the user can undo it. If "to" is an existing folder, the item goes inside it. To move into a folder that doesn\'t exist yet, set into: true (it is created). Never overwrites anything. Move one item per call and check each result before the next.',
    input_schema: obj({
      from: { type: 'string', description: 'Current path' },
      to: { type: 'string', description: 'New path (rename/move), or a folder to move it into' },
      into: { type: 'boolean', description: 'true: "to" is a folder to put the item in (created if missing). false: "to" is the new name. Leave out to let Island decide.' },
    }, ['from', 'to']),
    summary: (i) => `Moving ${path.basename(String(i.from ?? ''))} to ${String(i.to ?? '')}`,
  },
  {
    name: 'delete_items',
    description: 'Delete files or folders by sending them to the Recycle Bin (Island also keeps a copy so the user can undo it). Always use this to delete; never delete permanently with PowerShell.',
    input_schema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Paths to delete' } }, ['paths']),
    summary: (i) => `Deleting ${(i.paths || []).length} item${(i.paths || []).length === 1 ? '' : 's'} (to the Recycle Bin)`,
  },
  {
    name: 'pc_checkup',
    description: 'Run a quick, read-only health check of the PC (about 10 seconds): disk space, memory and the apps using most of it, processor load, how long since a restart and whether Windows is waiting for one, apps that start with Windows, temp files and Recycle Bin size, Wi-Fi signal, internet and DNS, printers and stuck print jobs, battery, and antivirus. Returns plain-language findings, worst first. Use it whenever the user says the PC is slow, something isn\'t working (internet, Wi-Fi, printer, a full disk), or asks you to check or fix their PC.',
    input_schema: obj({}),
    summary: () => 'Checking your PC',
  },
  {
    name: 'deleted_files',
    description: 'Find files in the Recycle Bin (action "find", with part of the name) and put one back where it was (action "restore", with the index and exact name from a find). Use when the user deleted something by accident.',
    input_schema: obj({
      action: { type: 'string', enum: ['find', 'restore'] },
      name: { type: 'string', description: 'For find: part of the file name (empty lists the most recent). For restore: the exact name from find.' },
      index: { type: 'integer', description: 'For restore: the index from find' },
    }, ['action']),
    summary: (i) => (i.action === 'restore' ? `Restoring ${i.name ?? 'a file'}` : `Looking in the Recycle Bin${i.name ? ` for "${i.name}"` : ''}`),
  },
  {
    name: 'save_lesson_card',
    description: 'Save the steps of a lesson as a large-print Word document the learner can keep, print and follow later without help ("Your steps: how to make a chart in Excel"). Offer it at the end of a lesson. One short line per step, in the same plain words as the lesson; add a "Remember" tip or two.',
    input_schema: obj({
      title: { type: 'string', description: 'e.g. "How to make text bold in Word"' },
      steps: { type: 'array', items: { type: 'string' }, description: 'The steps in order, plain words; **bold** the word on the button' },
      tips: { type: 'array', items: { type: 'string' }, description: 'Optional reminders, e.g. "If something goes wrong, press Ctrl+Z to undo."' },
    }, ['title', 'steps']),
    summary: (i) => `Saving steps: ${String(i.title ?? '').slice(0, 50)}`,
  },
  {
    name: 'create_spreadsheet',
    description: 'Create a real Excel file (.xlsx) with formatted headers, number/currency/date formats, working formulas (any cell text starting with "=", e.g. "=B2*C2") and an optional totals row. Saved to Documents unless a full path is given, never overwriting an existing file, and opened for the user. Use this whenever the user wants a spreadsheet, table, budget, invoice list or data they will work with in Excel, rather than a Markdown table. Charts are not supported here; put charts in a presentation or add them in Excel afterwards.',
    input_schema: obj({
      path: { type: 'string', description: 'File name or full path, e.g. "October expenses.xlsx" or "C:\\Users\\me\\Desktop\\Budget.xlsx"' },
      sheets: {
        type: 'array',
        description: 'One or more sheets',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Sheet tab name' },
            title: { type: 'string', description: 'Optional title line above the table' },
            columns: { type: 'array', items: { type: 'object', properties: { header: { type: 'string' }, format: { type: 'string', enum: ['text', 'number', 'integer', 'currency', 'percent', 'date'] }, width: { type: 'number' } }, required: ['header'] } },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Rows of cell values. Numbers can be plain (1200 or "1200"); formulas start with "=" and use Excel cell references (with a title the header is row 3 and data starts on row 4; without a title the header is row 1 and data starts on row 2)' },
            totals: { type: 'boolean', description: 'Add a Total row summing the amount columns' },
            total_columns: { type: 'array', items: { type: 'string' }, description: 'Instead of guessing, sum exactly these column headers' },
          },
          required: ['rows'],
        },
      },
      currency: { type: 'string', description: 'Currency symbol for currency columns, e.g. "₹" or "$" (default: from the data or the PC)' },
      open: { type: 'boolean', description: 'Open it in Excel afterwards (default true)' },
    }, ['path', 'sheets']),
    summary: (i) => `Creating ${path.basename(String(i.path ?? 'spreadsheet'))}`,
  },
  {
    name: 'create_document',
    description: 'Create a real Word document (.docx) from Markdown: # headings, paragraphs, **bold**, *italic*, bullet and numbered lists, tables and page breaks (---). Saved to Documents unless a full path is given, never overwriting, and opened for the user. Use for letters, reports, quotations, notes or anything the user wants as a Word file.',
    input_schema: obj({
      path: { type: 'string', description: 'File name or full path, e.g. "Quotation.docx"' },
      title: { type: 'string', description: 'Optional document title (big text at the top)' },
      markdown: { type: 'string', description: 'The document content in Markdown' },
      open: { type: 'boolean', description: 'Open it in Word afterwards (default true)' },
    }, ['path', 'markdown']),
    summary: (i) => `Creating ${path.basename(String(i.path ?? 'document'))}`,
  },
  {
    name: 'create_presentation',
    description: 'Create a real PowerPoint presentation (.pptx): a title slide plus slides with a title and bullets or text, optionally beside a table, a chart (bar, line, pie, doughnut) or a picture, with speaker notes. Saved to Documents unless a full path is given, never overwriting, and opened for the user. Keep slides short: 3 to 6 bullets of a few words each.',
    input_schema: obj({
      path: { type: 'string', description: 'File name or full path, e.g. "Q3 review.pptx"' },
      title: { type: 'string', description: 'Title slide heading' },
      subtitle: { type: 'string', description: 'Title slide subtitle' },
      theme: { type: 'string', enum: ['light', 'dark', 'blue'] },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            text: { type: 'string' },
            notes: { type: 'string', description: 'Speaker notes' },
            table: { type: 'object', properties: { header: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } },
            chart: { type: 'object', properties: { type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] }, labels: { type: 'array', items: { type: 'string' } }, series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } } } } } },
            image: { type: 'string', description: 'Full path of a picture on the PC' },
          },
          required: ['title'],
        },
      },
      open: { type: 'boolean', description: 'Open it in PowerPoint afterwards (default true)' },
    }, ['path', 'slides']),
    summary: (i) => `Creating ${path.basename(String(i.path ?? 'presentation'))}`,
  },
  {
    name: 'write_text_file',
    description: 'Create or overwrite a text file (notes, code, CSV), or add to its end. If it already exists, the old version is kept so the user can undo the change.',
    input_schema: obj({ path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'The text to write' }, append: { type: 'boolean', description: 'Add to the end instead of replacing' } }, ['path', 'content']),
    summary: (i) => `${i.append ? 'Adding to' : 'Writing'} ${path.basename(String(i.path ?? ''))}`,
  },
  {
    name: 'run_powershell',
    description:
      'Run a PowerShell command on the user\'s PC. The user sees the exact command and must approve it before it runs. Use for anything the other tools cannot do (settings, file operations, network diagnostics, process management). Prefer read-only commands; 60s timeout.',
    input_schema: obj(
      { command: { type: 'string', description: 'PowerShell script to run' }, reason: { type: 'string', description: 'One short sentence telling the user what this does' } },
      ['command', 'reason']
    ),
    summary: (i) => i.reason || 'Running PowerShell',
  },
  {
    name: 'remember',
    memory: true,
    description:
      'Save a short, lasting fact or preference about the user to long-term memory, so future chats know it (e.g. "Uses the Work Chrome profile", "Prefers short answers", "Studies class 11 chemistry"). One fact per call, written in third person. Never store secrets.',
    input_schema: obj(
      {
        fact: { type: 'string', description: 'The fact, one short sentence' },
        category: { type: 'string', enum: ['profile', 'preference', 'project', 'instruction', 'fact'], description: 'profile = who they are; preference = how they like things / apps and accounts they use; project = ongoing work and deadlines; instruction = standing rules for you; fact = anything else' },
      },
      ['fact']
    ),
    summary: (i) => `Remembered: ${String(i.fact ?? '').slice(0, 60)}`,
  },
  {
    name: 'update_memory',
    memory: true,
    description: 'Correct or update an existing memory by id (ids are shown in brackets in your memory list), instead of adding a near-duplicate.',
    input_schema: obj(
      {
        id: { type: 'string', description: 'Memory id, e.g. "m3"' },
        text: { type: 'string', description: 'The corrected fact' },
        category: { type: 'string', enum: ['profile', 'preference', 'project', 'instruction', 'fact'] },
      },
      ['id', 'text']
    ),
    summary: (i) => `Updated memory: ${String(i.text ?? '').slice(0, 60)}`,
  },
  {
    name: 'forget',
    memory: true,
    description: 'Delete a memory by its id, when the user says it is wrong or asks you to forget it.',
    input_schema: obj({ id: { type: 'string', description: 'Memory id, e.g. "m3"' } }, ['id']),
    summary: (i) => `Forgot ${i.id}`,
  },
  {
    name: 'recall_memory',
    memory: true,
    description: 'Search everything you remember about the user. Use when they refer to something from before ("my project", "like last time", "the profile I use") that isn\'t already in your context.',
    input_schema: obj({ query: { type: 'string', description: 'What to look for' }, category: { type: 'string', enum: ['profile', 'preference', 'project', 'instruction', 'fact'] } }, ['query']),
    summary: (i) => `Recalling “${String(i.query ?? '').slice(0, 50)}”`,
  },
  {
    name: 'search_past_chats',
    chatSearch: true,
    description: 'Search the user\'s earlier conversations with you (titles and messages) and get matching passages. Use when the user refers to a previous chat ("what did we decide about…", "the code you wrote yesterday") and the answer isn\'t in this conversation or your memory.',
    input_schema: obj({ query: { type: 'string', description: 'Keywords to look for' } }, ['query']),
    summary: (i) => `Searching past chats for “${String(i.query ?? '').slice(0, 50)}”`,
  },
  {
    name: 'hand_over',
    description:
      'Hand the screen to the user for something only they should do: signing in, a 2FA or one-time code, entering a password, card or payment details, or anything that needs them physically at the PC. Island hides its cursor and stops looking at the screen, shows a "Your turn" card with your instructions, and waits until they press Continue; then you get a fresh screenshot and carry on. Never ask the user to tell you passwords or codes instead.',
    input_schema: obj(
      {
        reason: { type: 'string', description: 'Why they need to step in, in a few words, e.g. "This site needs you to sign in"' },
        steps: { type: 'string', description: 'What to do, in 1 or 2 plain sentences, e.g. "Sign in to your Google account in the Chrome window, then press Continue."' },
      },
      ['reason']
    ),
    summary: (i) => `Your turn: ${String(i.reason ?? '').slice(0, 70)}`,
  },
  {
    name: 'finish_task',
    description:
      'Call this once at the end of any task where you changed something on the PC (clicked, typed, opened, moved, saved, created or deleted files, ran commands), after checking the result yourself: look at the latest screenshot, re-read the file, check the value or that the file exists. Island shows the user a result card. Be honest: status "done" only if you verified it worked; "partly" if some of it worked; "failed" if it didn\'t. Don\'t call it for plain questions and answers.',
    input_schema: obj(
      {
        status: { type: 'string', enum: ['done', 'partly', 'failed'], description: 'done = verified it worked; partly = some of it; failed = it did not work' },
        checked: { type: 'string', description: 'How you verified it, in plain words, e.g. "Budget.xlsx now has a chart on Sheet1" or "the email is in Sent". Say "couldn\'t check" if you couldn\'t.' },
        summary: { type: 'string', description: 'One short sentence on what was done (or what went wrong and what the user can do).' },
      },
      ['status', 'checked']
    ),
    summary: (i) => `Result: ${i.status ?? ''}`,
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a question and wait for their answer: a choice between options, a missing detail, or a file you need from them. A card pops up for them (even if Island is folded away) and their answer comes back as the result. Use it when you genuinely can\'t proceed sensibly without their input, especially mid-task; for simple chat clarifications just ask in your reply. Offer 2 to 5 short options when the likely answers are known (the user can still type their own).',
    input_schema: obj(
      {
        question: { type: 'string', description: 'The question, short and specific' },
        options: { type: 'array', description: 'Suggested answers', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string', description: 'Optional one-line explanation' } }, required: ['label'] } },
        multi_select: { type: 'boolean', description: 'Let the user pick several options' },
        allow_text: { type: 'boolean', description: 'Let the user type a free answer (default true)' },
        request_files: { type: 'boolean', description: 'You want the user to attach a file or image' },
        placeholder: { type: 'string', description: 'Hint shown in the answer box' },
      },
      ['question']
    ),
    summary: (i) => `Asked you: ${String(i.question ?? '').slice(0, 60)}`,
  },
  {
    name: 'teach_lesson',
    description:
      'Run a planned lesson on the user\'s real screen: give the steps in order and Island shows them one by one (spotlight + big card, read aloud), waits for the learner, and checks each step\'s result itself from Windows\' control state (expect), moving on instantly when it passed. You only hear back when a check fails, a step\'s control isn\'t on screen, the learner asks a question or presses "Do it for me", or the steps are done; then continue with first_step set. Much faster than one teach_step per step: prefer it whenever the user wants to learn something.',
    input_schema: obj(
      {
        title: { type: 'string', description: 'What this lesson teaches, a few words' },
        first_step: { type: 'integer', description: 'Number of the first step given here (default 1; when continuing, the step to resume at)' },
        practice: { type: 'boolean', description: 'Practice round: the learner has done this before and tries on their own. The card shows the instruction without the glowing spot; the spot appears only if they hesitate or click the wrong thing. Write instructions as goals ("Make the title bold") rather than directions to the spot.' },
        total: { type: 'integer', description: 'Number of steps in the whole lesson (best estimate)' },
        steps: {
          type: 'array',
          description: 'The steps, in order. Plan from the latest screenshot; later steps may name controls that only appear after earlier steps (give target_name without target for those).',
          items: {
            type: 'object',
            properties: {
              instruction: { type: 'string', description: 'One small action in plain everyday words, under ~25 words. **Bold** the word on the button.' },
              detail: { type: 'string', description: 'Optional 1 short sentence: why, or what they will see' },
              success: { type: 'string', description: 'Short praise shown on the next card when this step is confirmed, e.g. "Nice, the title is bold now!"' },
              target: { type: 'array', items: { type: 'number' }, description: '[x, y] in the latest screenshot; omit for controls that are not visible yet' },
              target_name: { type: 'string', description: 'Control name as Windows knows it (tooltip or visible text): "Bold", "Insert", "New Slide", a cell "B4". Omit for unnamed things on a slide or document (give target instead).' },
              target_box: { type: 'array', items: { type: 'number' }, description: 'Optional [x0, y0, x1, y1] area to highlight instead' },
              action: { type: 'string', enum: TEACH_ACTIONS, description: 'type = they type text (give expect {type:"text", text}); press_key = they press a key (give key)' },
              key: KEY,
              expect: EXPECT,
            },
            required: ['instruction'],
          },
        },
      },
      ['steps']
    ),
    summary: (i) => `Lesson${i.title ? `: ${String(i.title).slice(0, 50)}` : ''} (${(i.steps || []).length} step${(i.steps || []).length === 1 ? '' : 's'}${i.first_step > 1 ? ` from step ${i.first_step}` : ''})`,
  },
  {
    name: 'teach_step',
    description:
      'Teach the user one step of a lesson on their real screen: highlights the spot to click (target, in screenshot pixels), shows your instruction in a big friendly card (also read aloud), then waits until they do it. Returns how they responded ("clicked" the spot, said they did it, asked you to do it, or asked a question) plus a fresh screenshot so you can check before the next step. Use it whenever the user wants to learn how to do something, instead of doing it for them.',
    input_schema: obj(
      {
        step: { type: 'integer', description: 'This step number, starting at 1' },
        total: { type: 'integer', description: 'Best estimate of the number of steps in the whole lesson' },
        instruction: { type: 'string', description: 'One small action in plain everyday words, under about 25 words: where it is, what it looks like, what to do. **Bold** the word on the button.' },
        detail: { type: 'string', description: 'Optional, 1 or 2 short sentences: why, what they will see next, praise for the last step, or the answer to their question' },
        target: { type: 'array', items: { type: 'number' }, description: '[x, y] center of the thing to click or look at, in pixels of the latest screenshot' },
        target_name: { type: 'string', description: 'The name of the control to click as Windows knows it: usually its tooltip or its visible text, e.g. "Bold", "Fill Color", "Home", "Insert", "Save", or a cell like "B4". The highlight snaps to that real control; if it is not on screen the step is not shown and you are told what is there.' },
        target_box: { type: 'array', items: { type: 'number' }, description: 'Optional [x0, y0, x1, y1] to highlight an area (a row, a range of cells) instead of one control' },
        action: { type: 'string', enum: TEACH_ACTIONS, description: 'What the user should do (default click). type = typing text (give expect {type:"text", text}); press_key = pressing a key (give key).' },
        key: KEY,
        expect: EXPECT,
      },
      ['step', 'instruction']
    ),
    summary: (i) => `Step ${i.step ?? '?'}${i.total ? ` of ${i.total}` : ''}: ${String(i.instruction ?? '').replace(/\*\*/g, '').slice(0, 70)}`,
  },
  {
    name: 'update_plan',
    description:
      'Show the user a live checklist for a multi-step task and keep it current. Call it at the start of any task with 3 or more steps, then again whenever a step starts or finishes (send the whole list each time). Exactly one step should be "active" while you work. Keep titles short (2 to 6 words).',
    input_schema: obj(
      { steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'active', 'done'] } }, required: ['title', 'status'] } } },
      ['steps']
    ),
    summary: () => 'Updated plan',
  },
  // The web tools: offered when web search is on. Claude normally searches with the
  // provider's own server-side tool, so these are for the cases where that is not
  // available (a gateway that is not Anthropic, or a search service the user picked).
  {
    name: 'search_web',
    web: true,
    description:
      'Search the web for current information (news, prices, weather, releases, docs, facts that may have changed). Returns a short digest of what the results say plus the result list with URLs. Use read_webpage to read a specific result in full. Cite the sources you rely on.',
    input_schema: obj({ query: { type: 'string', description: 'What to search for, as you would type it into a search engine' } }, ['query']),
    summary: (i) => `Searched “${String(i.query ?? '').slice(0, 60)}”`,
  },
  {
    name: 'read_webpage',
    web: true,
    description:
      'Fetch a public web page (http/https) and return its readable text, title and links. Use it to read search results or any URL the user gives. Pages that need JavaScript or a login may come back empty; open those in the browser instead.',
    input_schema: obj({ url: { type: 'string', description: 'Full http(s) URL' } }, ['url']),
    summary: (i) => `Reading ${shortUrl(i.url)}`,
  },
];

function fmtDur(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

const MEDIA_KEYS = { play_pause: 179, next: 176, previous: 177, volume_up: 175, volume_down: 174, mute: 173 };

function shortUrl(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 24) + (x.pathname.length > 24 ? '…' : '') : ''); } catch { return String(u).slice(0, 40); }
}

// ---------- browsers ----------

const BROWSERS = {
  chrome: { exe: 'chrome.exe', userData: ['Google', 'Chrome', 'User Data'] },
  edge: { exe: 'msedge.exe', userData: ['Microsoft', 'Edge', 'User Data'] },
  brave: { exe: 'brave.exe', userData: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  firefox: { exe: 'firefox.exe' },
};

function browserPath(exe) {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
      if (m) return m[1].trim().replace(/^"|"$/g, '');
    } catch {}
  }
  return null;
}

// Profile display names -> directory names, from the browser's Local State file.
function browserProfiles(b) {
  if (!b.userData) return [];
  try {
    const state = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, ...b.userData, 'Local State'), 'utf8'));
    const cache = state.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, v]) => ({ dir, names: [v.name, v.gaia_name, v.gaia_given_name, v.shortcut_name].filter(Boolean) }));
  } catch {
    return [];
  }
}

// ---------- implementations ----------
// Each returns either a string or an array of tool_result content blocks.
// ctx: { captureScreen, systemSnapshot, timers, requestApproval, settings, signal }

// Asks the user (depending on the permission mode) before a file change.
async function approveFile(ctx, id, op, summary, paths) {
  const ok = await ctx.approveFile({ id, op, summary, paths });
  if (!ok) throw new Error('The user declined this file change. Ask what they would like instead.');
}

// Create an Office file: pick a free name (Documents by default), make it, read it back to
// confirm what's in it, open it, and offer undo.
async function makeOfficeFile(ctx, id, raw, ext, kind, build, open) {
  let p = String(raw || '').trim() || `New ${kind}`;
  if (!/[\\/]/.test(p)) p = path.join(os.homedir(), 'Documents', p);
  const file = office.freePath(expandPath(p), ext);
  ctx.files.guard(file, 'create a file'); // never in system folders or a drive root
  await approveFile(ctx, id, 'create', `Create the ${kind} ${file}`, [file]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info = await build(file);
  // Check it really exists and what Office will see.
  let preview = '';
  try { preview = (await docs.readFile(file)).text.slice(0, 600); } catch (e) { throw new Error(`The file was written but couldn't be read back: ${e.message}`); }
  if (open !== false) shell.openPath(file).catch(() => {});
  const wanted = expandPath(p).replace(/\.[^.\\/]+$/, '') + ext;
  const renamed = wanted.toLowerCase() !== file.toLowerCase()
    ? ` A file named ${path.basename(wanted)} already existed, so this one was saved as ${path.basename(file)}. Leave the existing file alone: don't delete, replace or rename it unless the user asks.`
    : '';
  return {
    content: `Created ${file}${info?.sheets ? ` (${info.sheets.join(', ')})` : info?.slides ? ` (${info.slides} slides)` : ''}${open !== false ? ' and opened it' : ''}. The user can undo this.${renamed} Read back from the file:\n${preview}`,
    undo: { op: 'remove_new_file', path: file },
  };
}

const IMPL = {
  async pc_checkup() {
    const { raw: r, findings } = await pchelp.checkup();
    const lines = findings.length ? findings.map((f) => `- ${f.level.toUpperCase()}: ${f.text}`).join('\n') : '- Nothing wrong found.';
    const facts = [
      `Windows: ${r.windows}; last restart ${r.uptimeDays} days ago${r.restartPending ? ' (restart pending)' : ''}`,
      `Memory: ${r.memory?.freeGB} GB free of ${r.memory?.totalGB} GB; processor ${r.cpuLoad}% busy`,
      `Most memory: ${(r.topMemory || []).map((p) => `${p.name} ${p.MB} MB`).join(', ')}`,
      `Disks: ${(r.disks || []).map((d) => `${d.drive} ${d.freeGB}/${d.totalGB} GB free`).join(', ')}`,
      `Start with Windows (${(r.startupApps || []).length}): ${(r.startupApps || []).join(', ')}`,
      `Temp files ${r.tempGB} GB; Recycle Bin ${r.recycleBin?.items} items, ${r.recycleBin?.GB} GB`,
      `Network: ${r.wifi ? `Wi-Fi "${r.wifi.network}" ${r.wifi.signal}%` : 'no Wi-Fi (maybe cable)'}; internet ${r.internet ? 'OK' : 'DOWN'}; DNS ${r.dns ? 'OK' : 'failing'}`,
      `Printers: ${(r.printers || []).map((p) => `${p.name}${p.default ? ' (main)' : ''}: ${p.status}, ${p.queued} queued${p.errorJobs ? `, ${p.errorJobs} stuck` : ''}`).join('; ') || 'none'}`,
      `Battery: ${r.battery ? `${r.battery.percent}%${r.battery.charging ? ', charging' : ''}` : 'none (desktop)'}; antivirus ${r.antivirus ? (r.antivirus.on ? 'on' : 'OFF') : 'unknown'}`,
    ];
    return `PC check-up findings (worst first):\n${lines}\n\nDetails:\n${facts.map((f) => `- ${f}`).join('\n')}\n\nExplain the findings to the user in simple words, then offer the fixes: do safe ones for them with their OK (moving temp files to the Recycle Bin with delete_items, restoring files), or teach them step by step (turning off startup apps in Task Manager, restarting). Never offer to empty the Recycle Bin or delete anything permanently yourself: that can't be undone. If space is needed, tell them they can empty the Recycle Bin themselves once they're sure nothing in it is needed.`;
  },

  async deleted_files({ action, name, index }, ctx, id) {
    if (action === 'restore') {
      if (!Number.isInteger(index) || !name) throw new Error('Use find first, then restore with its index and exact name.');
      await approveFile(ctx, id, 'restore', `Put "${name}" back where it was, from the Recycle Bin`, [name]);
      const r = await pchelp.restoreDeleted(index, name);
      if (!r?.ok) throw new Error(r?.error || `Couldn't confirm "${name}" was restored. Look in ${r?.from || 'its original folder'}.`);
      return `Restored "${name}" to ${r.from}. Checked: the file is there again.`;
    }
    const hits = await pchelp.listDeleted(name || '');
    if (!hits.length) return name ? `Nothing in the Recycle Bin matches "${name}". It may have been emptied, or the file was deleted another way (Shift+Delete, or from a USB/network drive).` : 'The Recycle Bin is empty.';
    return `In the Recycle Bin (newest first):\n${hits.map((h) => `- index ${h.index}: ${h.name} (from ${h.from}, deleted ${h.deleted}, ${h.KB} KB)`).join('\n')}`;
  },

  async save_lesson_card({ title, steps, tips }, ctx, id) {
    const md = [
      ...(steps || []).map((s, i) => `${i + 1}. ${String(s).trim()}`),
      ...(tips?.length ? ['', '## Remember', ...tips.map((t) => `- ${String(t).trim()}`)] : []),
      '',
      `*Made by Island on ${new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}. You can ask Island to show you again any time.*`,
    ].join('\n');
    const dir = path.join(os.homedir(), 'Documents', 'Island lessons');
    const name = String(title || 'My steps').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80);
    return makeOfficeFile(ctx, id, path.join(dir, name), '.docx', 'step card', (f) => office.createDocument(f, { title, markdown: md, large: true }), true);
  },

  async create_spreadsheet({ path: p, sheets, currency, open }, ctx, id) {
    return makeOfficeFile(ctx, id, p, '.xlsx', 'spreadsheet', (f) => office.createSpreadsheet(f, { sheets, currency }), open);
  },

  async create_document({ path: p, title, markdown, open }, ctx, id) {
    return makeOfficeFile(ctx, id, p, '.docx', 'document', (f) => office.createDocument(f, { title, markdown }), open);
  },

  async create_presentation({ path: p, title, subtitle, theme, slides, open }, ctx, id) {
    return makeOfficeFile(ctx, id, p, '.pptx', 'presentation', (f) => office.createPresentation(f, { title, subtitle, theme, slides }), open);
  },

  async create_folder({ path: p }, ctx, id) {
    await approveFile(ctx, id, 'create', `Create the folder ${ctx.files.expandPath(p)}`, [ctx.files.expandPath(p)]);
    const r = ctx.files.createFolder(p);
    return { content: `${r.message}. The user can undo this.`, undo: r.undo };
  },

  async move_item({ from, to, into }, ctx, id) {
    await approveFile(ctx, id, 'move', `Move ${ctx.files.expandPath(from)} ${into ? 'into the folder' : 'to'} ${ctx.files.expandPath(to)}`, [ctx.files.expandPath(from)]);
    const r = ctx.files.moveItem(from, to, { into });
    return { content: `${r.message}. The user can undo this.`, undo: r.undo };
  },

  async delete_items({ paths }, ctx, id) {
    const full = (paths || []).map((p) => ctx.files.expandPath(p));
    if (!full.length) throw new Error('No paths given.');
    await approveFile(ctx, id, 'delete', `Move ${full.length} item${full.length > 1 ? 's' : ''} to the Recycle Bin`, full);
    const r = await ctx.files.deleteItems(paths);
    return { content: `${r.message}. The user can undo this.`, undo: r.undo };
  },

  async write_text_file({ path: p, content, append }, ctx, id) {
    await approveFile(ctx, id, 'write', `${append ? 'Add to' : 'Write'} the file ${ctx.files.expandPath(p)}`, [ctx.files.expandPath(p)]);
    const r = ctx.files.writeTextFile(p, content, append ? 'append' : 'overwrite');
    return { content: `${r.message}. The user can undo this.`, undo: r.undo };
  },

  async remember({ fact, category }, ctx, toolUseId) {
    if (ctx.settings.memoryOn === false) throw new Error('Memory is turned off in settings.');
    const secret = detectSecret(fact);
    if (secret) throw new Error(`Not saved: it looks like ${secret}, and Island never keeps those in memory.`);
    // Sensitive facts (or every memory, if the user chose that) need a yes, unless the user
    // just asked for it to be remembered.
    const sensitive = detectSensitive(fact);
    if (ctx.confirmMemory && !askedToRemember(ctx.turn?.text) && (sensitive || ctx.settings.memoryConfirm === 'always')) {
      const r = await ctx.confirmMemory({ id: toolUseId, text: String(fact || ''), category, sensitive, signal: ctx.signal });
      if (!r?.approved) return "The user chose not to save that to memory. Don't save it another way, and carry on without mentioning it again.";
      fact = r.text || fact;
    }
    const m = ctx.memory.add(fact, { source: 'assistant', category, chat: ctx.chatId || null });
    ctx.onMemoryChange?.();
    ctx.turn && (ctx.turn.memoryTouched = true);
    ctx.turn?.memUsed?.delete(m.id);
    if (m.duplicate) return `Already remembered as ${m.id}.`;
    return m.merged ? `Updated ${m.id} (it was a near-duplicate): ${m.text}` : `Saved as ${m.id}. It will be available in future chats.`;
  },

  async update_memory({ id, text, category }, ctx) {
    const m = ctx.memory.update(id.trim(), { text, ...(category ? { category } : {}) });
    ctx.onMemoryChange?.();
    ctx.turn && (ctx.turn.memoryTouched = true);
    return m ? `Updated ${m.id}: ${m.text}` : `No memory with id ${id}.`;
  },

  async forget({ id }, ctx) {
    const ok = ctx.memory.remove(id.trim());
    ctx.onMemoryChange?.();
    ctx.turn && (ctx.turn.memoryTouched = true);
    ctx.turn?.memUsed?.delete(id.trim());
    return ok ? `Forgot ${id}.` : `No memory with id ${id}.`;
  },

  async recall_memory({ query, category }, ctx) {
    const hits = ctx.memory.search(query, { limit: 10, category });
    if (!hits.length) return `Nothing in memory matches "${query}".`;
    for (const m of hits.slice(0, 4)) ctx.turn?.memUsed?.add(m.id);
    return hits.map((m) => `- [${m.id}] (${m.category}) ${m.text}`).join('\n');
  },

  async search_past_chats({ query }, ctx) {
    if (ctx.settings.chatSearch === false) throw new Error('Searching past chats is turned off in settings.');
    const hits = ctx.chats.search(query, { limit: 4, exclude: ctx.chatId });
    if (!hits.length) return `No earlier chats mention "${query}".`;
    return hits.map((h) => `## ${h.title} (${new Date(h.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})\n${h.excerpts.map((e) => `> ${e}`).join('\n')}`).join('\n\n');
  },

  async ask_user(input, ctx, toolUseId) {
    const r = await ctx.askUser({
      id: toolUseId,
      question: input.question,
      options: (input.options || []).filter((o) => o && o.label).slice(0, 8).map((o) => ({ label: String(o.label).slice(0, 80), description: o.description ? String(o.description).slice(0, 160) : '' })),
      multiSelect: !!input.multi_select,
      allowText: input.allow_text !== false,
      requestFiles: !!input.request_files,
      placeholder: input.placeholder || '',
    });
    if (!r || r.cancelled) return 'The question was cancelled (the user stopped the task).';
    if (r.skipped) return 'The user skipped this question. Make a sensible choice yourself and say what you chose, or ask again in chat if it really matters.';
    const said = [r.selected?.length ? `Chose: ${r.selected.join(', ')}` : '', r.answer ? `Answered: ${r.answer}` : ''].filter(Boolean).join('\n');
    const blocks = [{ type: 'text', text: said || 'The user replied with the attached file(s).' }];
    for (const f of r.files || []) {
      if (f.kind === 'image' && f.base64) blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.base64 } });
      else if ((f.kind === 'pdf' || f.kind === 'file') && f.base64) {
        // As text (plus pictures of pages without text), so it works with every model.
        try {
          const buf = Buffer.from(f.base64, 'base64');
          if (f.kind === 'pdf' && ctx.readPdf) blocks.push(...(await ctx.readPdf(buf, f.name)));
          else blocks.push({ type: 'text', text: docs.asBlock(f.name, await docs.extract(buf, f.name)) });
        } catch (e) { blocks.push({ type: 'text', text: `[Couldn't read ${f.name}: ${e.message}]` }); }
      } else if (f.kind === 'text') blocks.push({ type: 'text', text: `<file name="${String(f.name).replace(/"/g, '')}">\n${clip(f.text, 60000)}\n</file>` });
    }
    return blocks.length === 1 ? blocks[0].text : blocks;
  },

  async teach_lesson(input, ctx) {
    return ctx.teachLesson(input);
  },

  async teach_step(input, ctx) {
    const r = await ctx.teach(input);
    if (!r || r.action === 'stopped') return 'The lesson was stopped by the user.';
    if (r.action === 'not_found') {
      const near = r.nearby?.length ? `Controls that really are around that spot: ${r.nearby.join(', ')}.` : 'No named controls were found around that spot.';
      return [
        { type: 'text', text: `NOT SHOWN to the user: nothing named "${input.target_name}" is on screen near your target, so this step may describe something that isn't there. ${near} Below is a close-up of the area around your target. Look again and call teach_step for this step with the correct target_name and target (the name Windows uses, often the button's tooltip, e.g. "Fill Color"), or first teach a step that opens the menu or tab where it lives. Only describe what you can actually see.` },
        ...(r.zoom ? [r.zoom] : []),
      ];
    }
    let checked = '';
    if (input.expect?.type && ['clicked', 'done', 'typed', 'pressed'].includes(r.action) && ctx.teachCheck) {
      const v = await ctx.teachCheck(input.expect, ctx.signal);
      checked = v.ok ? ` Island confirmed it worked (${v.saw}).` : ` Island checked and it did NOT work: ${v.saw}. Help them fix it.`;
    } else if (['clicked', 'done'].includes(r.action)) {
      checked = ' NOT CONFIRMED by Island: before saying it worked, check the screenshot and the window title.';
    }
    const said = {
      clicked: 'The user clicked the highlighted spot.',
      done: 'The user pressed "I did it".',
      typed: `The user typed it (Island read: "${String(r.typed || '').slice(0, 120)}").`,
      pressed: `The user pressed ${input.key || 'the key'}.`,
      do_it: 'The user asked you to do this step for them. Do just this step with the computer tools (say briefly what you are doing), then carry on teaching the next step.',
      question: `The user asked a question instead: "${String(r.text || '').slice(0, 500)}". Answer it simply in the detail of your next teach_step (repeat this step if they still need to do it).`,
    }[r.action] || `The user responded: ${r.action}.`;
    const check = checked;
    const rep = r.report?.highlighted ? ` Highlighted: ${r.report.highlighted}.${r.report.now ? ` At that spot now: ${r.report.now}.` : ''}` : '';
    return [{ type: 'text', text: said + rep + check }, ...(r.screen || [])];
  },

  async hand_over({ reason, steps }, ctx, toolUseId) {
    if (!ctx.handOver) return 'Hand-over is not available here; ask the user in your reply instead.';
    const r = await ctx.handOver({ id: toolUseId, reason: String(reason || '').slice(0, 160), steps: String(steps || '').slice(0, 400), signal: ctx.signal });
    if (!r || r.cancelled) return 'The user cancelled the task. Stop working on it and say you have stopped.';
    if (!r.done) return `The user chose not to do it${r.note ? ` and said: "${r.note}"` : ''}. Don't try to get around it; ask what they'd like instead.`;
    return [{ type: 'text', text: `The user finished their part${r.note ? ` and said: "${r.note}"` : ''}. This is the screen now; check it and continue the task.` }, ...(r.screen || [])];
  },

  async finish_task({ status, checked, summary }, ctx) {
    const st = ['done', 'partly', 'failed'].includes(status) ? status : 'partly';
    ctx.turn && (ctx.turn.finished = st);
    ctx.onResult?.({ status: st, checked: String(checked || '').slice(0, 240), summary: String(summary || '').slice(0, 240) });
    if (ctx.turn?.wroteReply) return 'Result shown to the user. You already wrote your reply, so end here: do not write anything more.';
    return 'Result shown to the user. If you already told the user the result or answer earlier in this task, end here without writing anything more. Otherwise give your short final reply (do not repeat the card word for word).';
  },

  async update_plan({ steps }, ctx) {
    const clean = (steps || []).filter((s) => s && s.title).slice(0, 12).map((s) => ({ title: String(s.title).slice(0, 80), status: ['pending', 'active', 'done'].includes(s.status) ? s.status : 'pending' }));
    ctx.onPlan?.(clean);
    const done = clean.filter((s) => s.status === 'done').length;
    return `Plan shown to the user (${done}/${clean.length} done).`;
  },

  async search_web({ query }, ctx) {
    return web.search(query, { clientOptions: ctx.clientOptions, signal: ctx.signal, model: ctx.settings?.model, ...(ctx.searchOpts?.() || {}) });
  },

  async read_webpage({ url }, ctx) {
    return web.read(url, { signal: ctx.signal });
  },

  async capture_screen(_, ctx) {
    const shot = await ctx.captureScreen();
    return [
      { type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.base64 } },
      { type: 'text', text: `Screenshot (${shot.width}x${shot.height}) taken ${new Date().toLocaleTimeString()}.` },
    ];
  },

  async read_clipboard() {
    const pic = await clipboardApi.readImage();
    if (pic) {
      let img = nativeImage.createFromBuffer(pic.buffer);
      const size = img.getSize();
      if (size.width > 1568) img = img.resize({ width: 1568 });
      return [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.toPNG().toString('base64') } },
        { type: 'text', text: `Clipboard contains an image (${size.width}x${size.height}).` },
      ];
    }
    const text = await clipboardApi.readText();
    return text ? `Clipboard text:\n${clip(text)}` : 'The clipboard is empty.';
  },

  async write_clipboard({ text }) {
    await clipboardApi.writeText(text);
    return `Copied ${text.length} characters to the clipboard.`;
  },

  async launch_app({ name }) {
    const q = name.trim().toLowerCase();
    const apps = await getStartApps();
    const ranked = apps
      .map((a) => ({ ...a, score: scoreName(a.Name || '', q) }))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length) {
      const best = ranked[0];
      spawn('explorer.exe', [`shell:AppsFolder\\${best.AppID}`], { detached: true, stdio: 'ignore' }).unref();
      const others = ranked.slice(1, 4).map((a) => a.Name);
      return `Launched "${best.Name}".${others.length ? ` Other matches: ${others.join(', ')}.` : ''}`;
    }
    return new Promise((resolve) => {
      const child = spawn(name.trim(), [], { detached: true, stdio: 'ignore', shell: false });
      child.on('error', () => resolve(`No installed app matching "${name}" was found.`));
      child.on('spawn', () => { child.unref(); resolve(`Started "${name}".`); });
    });
  },

  async open_item({ target }) {
    const t = target.trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
    if (scheme && scheme.length > 1) {
      if (['javascript', 'vbscript', 'data', 'file'].includes(scheme)) throw new Error(`Refusing to open ${scheme}: URIs`);
      await shell.openExternal(t);
      return `Opened ${t}${scheme.startsWith('http') ? ' in the default browser (use open_url to choose a browser or profile)' : ''}`;
    }
    const p = expandPath(t);
    if (!fs.existsSync(p)) throw new Error(`Path not found: ${p}`);
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return `Opened ${p}`;
  },

  async open_url({ url, browser = 'default', profile, new_window }) {
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
    if (browser === 'default' && !profile && !new_window) {
      await shell.openExternal(url);
      return `Opened ${url} in the default browser.`;
    }
    const b = BROWSERS[browser === 'default' ? 'chrome' : browser];
    const exe = browserPath(b.exe);
    if (!exe) throw new Error(`${browser} doesn't appear to be installed.`);
    const args = [];
    let profileNote = '';
    if (profile) {
      const all = browserProfiles(b);
      const q = profile.trim().toLowerCase();
      const hit = all.find((p) => p.names.some((n) => n.toLowerCase() === q) || p.dir.toLowerCase() === q) || all.find((p) => p.names.some((n) => n.toLowerCase().includes(q)));
      if (!hit) throw new Error(`No ${browser} profile named "${profile}". Profiles: ${all.map((p) => p.names[0]).join(', ') || 'none found'}`);
      args.push(`--profile-directory=${hit.dir}`);
      profileNote = ` (profile "${hit.names[0]}")`;
    }
    if (new_window) args.push(browser === 'firefox' ? '-new-window' : '--new-window');
    args.push(url);
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    return `Opened ${url} in ${browser === 'default' ? 'chrome' : browser}${profileNote}, ${new_window ? 'new window' : "new tab in that profile's existing window"}.`;
  },

  async list_windows(_, ctx) {
    const wins = (await ctx.input.windows()).filter((w) => w.pid !== process.pid);
    if (!wins.length) return 'No app windows are open.';
    const profiles = browserProfiles(BROWSERS.chrome).map((p) => p.names[0]);
    return (
      wins.map((w) => `id=${w.id}  ${w.app}${w.minimized ? ' (minimized)' : ''}  "${w.title}"`).join('\n') +
      `\n\nNotes: "claude" is the Claude desktop app (its browser pane is not the user's browser).${profiles.length > 1 ? ` Chrome profiles on this PC: ${profiles.join(', ')}.` : ''}`
    );
  },

  async focus_window({ window_id }, ctx) {
    const ok = await ctx.input.focus(window_id);
    const fg = await ctx.input.foreground();
    const now = fg ? `${fg.app} "${fg.title}"` : 'nothing';
    if (!ok) throw new Error(`Couldn't focus that window; the focused window is ${now}.`);
    return `Focused: ${now}`;
  },

  async get_system_info(_, ctx) {
    const snap = ctx.systemSnapshot();
    const r = await runPowerShell(
      `$b = Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus
$d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}},@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}
$p = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 Name,Id,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}},@{n='CpuSeconds';e={[math]::Round($_.CPU,1)}}
[pscustomobject]@{battery=$b;disks=@($d);topProcessesByMemory=@($p)} | ConvertTo-Json -Depth 4 -Compress`,
      { timeoutMs: 20000 }
    );
    let extra = {};
    try { extra = JSON.parse(r.stdout); } catch {}
    return JSON.stringify({
      computer: os.hostname(),
      os: `${os.version()} (${os.release()})`,
      cpu: { model: os.cpus()[0]?.model, cores: os.cpus().length, usagePercent: snap.cpu },
      memory: { usedGB: +((os.totalmem() - os.freemem()) / 2 ** 30).toFixed(1), totalGB: +(os.totalmem() / 2 ** 30).toFixed(1), usagePercent: snap.mem },
      uptime: fmtDur(os.uptime()),
      ...extra,
    });
  },

  async list_directory({ path: p }) {
    const dir = expandPath(p);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const rows = [];
    for (const e of entries.slice(0, 300)) {
      let st = null;
      try { st = await fs.promises.stat(path.join(dir, e.name)); } catch {}
      rows.push(`${e.isDirectory() ? '[dir] ' : '      '}${e.name}${st && !e.isDirectory() ? `  (${(st.size / 1024).toFixed(1)} KB)` : ''}${st ? `  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}` : ''}`);
    }
    return `${dir} — ${entries.length} entries${entries.length > 300 ? ' (first 300 shown)' : ''}\n${rows.join('\n')}`;
  },

  async read_file({ path: p, pages, as_images }, ctx) {
    const file = expandPath(p);
    const st = await fs.promises.stat(file);
    if (st.isDirectory()) throw new Error('That is a folder; use list_directory.');
    const ext = docs.extOf(file);
    if (ext === 'pdf' && ctx.readPdf) {
      if (st.size > 60 * 1024 * 1024) throw new Error(`${path.basename(file)} is larger than 60 MB.`);
      const blocks = await ctx.readPdf(await fs.promises.readFile(file), path.basename(file), { pages, asImages: !!as_images });
      return [{ type: 'text', text: `${file} (${(st.size / 1024).toFixed(0)} KB)` }, ...blocks];
    }
    if (/^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
      // Pictures: shrink to what a model reads well, as JPEG unless it's already small.
      let img = nativeImage.createFromPath(file);
      if (img.isEmpty()) throw new Error(`Couldn't open ${path.basename(file)} as a picture.`);
      const { width, height } = img.getSize();
      const k = Math.min(1, 1568 / Math.max(width, height));
      if (k < 1) img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' });
      return [{ type: 'text', text: `${file} (picture, ${width}×${height})` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.toJPEG(88).toString('base64') } }];
    }
    if (!docs.supported(file)) {
      // Unknown type: read it as text if it looks like text, else explain.
      const head = Buffer.alloc(Math.min(st.size, 4096));
      const fh = await fs.promises.open(file, 'r');
      try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
      if (head.includes(0)) throw new Error(`Island can't read .${ext || 'this kind of'} files. It can read PDFs, Word, Excel, PowerPoint, text and code files, and pictures.`);
    }
    const r = await docs.readFile(file);
    return `${file} (${(st.size / 1024).toFixed(0)} KB)\n${docs.asBlock(path.basename(file), r)}`;
  },

  async media_control({ action, times }) {
    const n = Math.min(Math.max(times || 1, 1), 50);
    const code = MEDIA_KEYS[action];
    await runPowerShell(`$w=New-Object -ComObject WScript.Shell; 1..${n} | % { $w.SendKeys([char]${code}) }`, { timeoutMs: 10000 });
    return `Sent ${action}${n > 1 ? ` x${n}` : ''}.`;
  },

  async set_reminder({ text, time, in_minutes, repeat, speak }, ctx) {
    if (!ctx.reminders) throw new Error('Reminders are not available.');
    let at = time;
    if (Number.isFinite(in_minutes) && in_minutes > 0) at = new Date(Date.now() + in_minutes * 60000);
    if (!at) throw new Error('Give a time ("08:00" or "2026-10-20 17:30") or in_minutes.');
    const r = ctx.reminders.add({ text, at, repeat: repeat || 'none', speak });
    return `Reminder saved (id ${r.id}): "${r.text}", ${describeReminder(r)}. It will pop up${r.speak ? ' and be read aloud' : ''}, even after a restart.`;
  },

  async list_reminders(_, ctx) {
    const list = ctx.reminders?.list() || [];
    return list.length ? list.map((r) => `- ${r.id}: "${r.text}", ${describeReminder(r)}`).join('\n') : 'No reminders set.';
  },

  async find_on_screen({ text, scroll, window }, ctx) {
    if (!ctx.computer) throw new Error('Screen tools are not available.');
    const r = await ctx.computer.findOnScreen(text, { scroll: scroll !== false, window });
    if (!r.matches.length) return `"${text}" was not found in the window in front or on screen. It may be worded differently, in another tab or window, or not loaded yet. Try a shorter part of it, or read_screen_text to see what is there.`;
    const lines = r.matches.map((m, i) => `${i + 1}. ${m.type ? `${m.type} ` : ''}"${String(m.text).replace(/\s+/g, ' ').slice(0, 100)}" ${m.onScreen ? `at (${m.center[0]}, ${m.center[1]}), box [${m.box.join(', ')}]` : '(not on screen right now)'}`);
    return `${r.scrolled ? 'Scrolled the page so the first match is in view.\n' : ''}Matches for "${text}" (best first):\n${lines.join('\n')}\n\nClick a match at its coordinates (they are in the latest screenshot's pixels).`;
  },

  async read_screen_text({ visible_only, window }, ctx) {
    if (!ctx.computer) throw new Error('Screen tools are not available.');
    const r = await ctx.computer.screenText({ visibleOnly: !!visible_only, window });
    if (!r.text.trim()) return 'No readable text was found in the window in front.';
    return `${r.title ? `Window: ${r.title}\n` : ''}Text from ${r.source}:\n${clip(r.text, 24000)}`;
  },

  async look_closely({ question, region, window, file }, ctx) {
    if (!ctx.vision) throw new Error('Looking closely is not available.');
    let prep, map, area, ocrText = '';
    if (file) {
      const p = expandPath(file);
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) throw new Error(`Couldn't open ${path.basename(p)} as a picture.`);
      prep = vision.prepare(img, { minEdge: 1600 });
      map = (x, y) => [Math.round(x / prep.k), Math.round(y / prep.k)];
      area = `the picture ${path.basename(p)}`;
    } else {
      const c = ctx.computer;
      if (!c) throw new Error('Screen tools are not available.');
      const g = c.geometry();
      let rect = null; // physical px
      if (window) {
        const w = await c.resolveWindow(window);
        if (!w) throw new Error(`No open window matches "${window}". Use list_windows to see what is open.`);
        await c.input.focus(w.id).catch(() => false);
        await new Promise((r) => setTimeout(r, 300));
        rect = w.rect;
        area = `the ${w.app} window "${String(w.title).slice(0, 60)}"`;
      } else if (Array.isArray(region) && region.length === 4 && region.every(Number.isFinite)) {
        const a = c.toPhys([Math.max(0, Math.min(region[0], region[2])), Math.max(0, Math.min(region[1], region[3]))], g);
        const b = c.toPhys([Math.min(g.shotW, Math.max(region[0], region[2])), Math.min(g.shotH, Math.max(region[1], region[3]))], g);
        if (b.x - a.x < 8 || b.y - a.y < 8) throw new Error('That region is too small.');
        rect = [a.x, a.y, b.x, b.y];
        area = 'that part of the screen';
      } else area = 'the whole screen';
      let img = await c.grab(g);
      let off = { x: 0, y: 0 };
      if (rect) {
        const x0 = Math.max(0, rect[0] - g.origin.x), y0 = Math.max(0, rect[1] - g.origin.y);
        const x1 = Math.min(g.physW, rect[2] - g.origin.x), y1 = Math.min(g.physH, rect[3] - g.origin.y);
        img = img.crop({ x: x0, y: y0, width: Math.max(8, x1 - x0), height: Math.max(8, y1 - y0) });
        off = { x: x0, y: y0 };
      }
      prep = vision.prepare(img, { minEdge: rect ? 1600 : 2000 });
      map = (x, y) => [Math.round((off.x + x / prep.k) * g.scale), Math.round((off.y + y / prep.k) * g.scale)];
      // Windows' own reading of the same area: exact characters, to check the answer against.
      if (rect) {
        const lines = await c.ocrScreen(g, rect).catch(() => []);
        ocrText = lines.map((l) => l.text).join('\n').slice(0, 3000);
      }
    }
    const r = await ctx.vision({ images: [prep], question: String(question), signal: ctx.signal });
    const parts = [`${r.model} looked at ${area}${prep.k > 1.05 ? ` (enlarged ${prep.k.toFixed(1)}x)` : ''}:`, vision.mapPoints(r.text, map)];
    if (!file) parts.push('Positions shown as (x, y) are screenshot pixels you can click.');
    if (ocrText.trim()) parts.push(`Text Windows reads in that area (a cross-check: exact for normal-size print, unreliable for tiny or stylised text):\n${ocrText}`);
    return parts.join('\n\n');
  },

  async cancel_reminder({ id }, ctx) {
    return ctx.reminders?.remove(String(id).trim()) ? `Cancelled reminder ${id}.` : `No reminder with id ${id}.`;
  },

  async record_routine({ name, description }, ctx) {
    if (!ctx.recordRoutine || !ctx.routines) throw new Error('Recording is not available.');
    name = String(name).trim().slice(0, 80);
    if (!name) throw new Error('Give the routine a name.');
    const r = await ctx.recordRoutine({ name, description });
    if (r.cancelled) return 'The user cancelled the recording. Nothing was saved.';
    const steps = tidyRoutine(r.steps);
    if (!steps.length) return 'Nothing was recorded (no clicks or typing were seen). Ask the user whether they want to try again.';
    const saved = ctx.routines.add({ name, description, steps });
    return `Saved routine "${saved.name}" with ${steps.length} step${steps.length === 1 ? '' : 's'}:\n${steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n')}\n\nTell the user it is saved, in one or two sentences, and that they can ask for "${saved.name}" any time. Mention any step that looks accidental. Don't run it now unless they ask.`;
  },

  async run_routine(input, ctx) {
    return ctx.runRoutine(input);
  },

  async list_routines(_, ctx) {
    const list = ctx.routines?.list() || [];
    if (!list.length) return 'No routines saved yet. The user can show Island a task with record_routine.';
    return list.map((r) => `"${r.name}"${r.description ? ` (${r.description})` : ''}, ${r.steps.length} steps, run ${r.runs || 0} times:\n${r.steps.map((s, i) => `  ${i + 1}. ${describeStep(s)}`).join('\n')}`).join('\n\n');
  },

  async delete_routine({ name }, ctx) {
    return ctx.routines?.remove(name) ? `Deleted routine "${name}".` : `No routine named "${name}".`;
  },

  async set_timer({ seconds, label }, ctx) {
    if (seconds <= 0 || seconds > 24 * 3600) throw new Error('seconds must be between 1 and 86400');
    ctx.timers.add(seconds, label || 'Timer');
    return `Timer set for ${fmtDur(seconds)}${label ? ` (${label})` : ''}. It will show in the island and notify when done.`;
  },

  async run_powershell({ command, reason }, ctx, toolUseId) {
    if (ctx.settings.shellMode === 'off') throw new Error('PowerShell is disabled in settings. Tell the user how to do it manually instead.');
    // Asks the user unless the permission mode allows this command to just run.
    const approved = await ctx.requestApproval({ id: toolUseId, command, reason });
    if (!approved) return 'The user declined to run this command.';
    const r = await runPowerShell(command, { timeoutMs: 60000, signal: ctx.signal });
    const parts = [`exit code: ${r.code}${r.timedOut ? ' (timed out after 60s)' : ''}`];
    if (r.stdout.trim()) parts.push(`stdout:\n${clip(r.stdout)}`);
    if (r.stderr.trim()) parts.push(`stderr:\n${clip(r.stderr, 6000)}`);
    return parts.join('\n\n');
  },
};

// opts.chat: the request goes to a Chat Completions model.
// opts.web: web search is on, so the web tools are offered (Claude uses the provider's
// own server-side search instead, unless Island has to do the searching itself).
function apiToolDefs(opts = {}) {
  return TOOLS.filter((t) => !(t.web && !opts.web) && !(t.memory && opts.memory === false) && !(t.chatSearch && opts.chatSearch === false)).map(({ name, description, input_schema }) => ({ name, description, input_schema, eager_input_streaming: true }));
}

function summarize(name, input) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t && /^mcp__/.test(name)) return name.replace(/^mcp__/, '').replace('__', ': ').replace(/_/g, ' ');
  try { return t?.summary(input || {}) ?? name; } catch { return name; }
}

// Returns { content, isError, sources? }. A tool may return a string, content blocks,
// or { content, sources } when it has links worth showing in the UI.
async function execute(name, input, ctx, toolUseId) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  input = coerce(tool.input_schema, input);
  // Models sometimes add a field a tool doesn't have; ignore it rather than fail the call.
  if (input && typeof input === 'object' && !Array.isArray(input)) input = Object.fromEntries(Object.entries(input).filter(([k]) => tool.input_schema.properties?.[k]));
  const bad = validateInput(tool.input_schema, input);
  if (bad) return { content: `INVALID_INPUT: ${bad}. Re-issue the call with complete, valid arguments.`, isError: true };
  try {
    const out = await IMPL[name](input, ctx, toolUseId);
    if (out && typeof out === 'object' && !Array.isArray(out) && 'content' in out) return { content: out.content, sources: out.sources, undo: out.undo, isError: false };
    return { content: out, isError: false };
  } catch (e) {
    return { content: `Error: ${e.message || e}`, isError: true };
  }
}

module.exports = { apiToolDefs, execute, summarize, fmtDur };
