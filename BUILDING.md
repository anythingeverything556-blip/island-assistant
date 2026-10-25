# Building Island

Island is a plain Electron app (no bundler, no framework). Everything below runs on Windows 10/11 x64 with Node 22.

## First time

```bash
npm install          # Electron and the few libraries Island uses
npm run assets       # icons and provider logos → src/renderer/icons.js, logos.js
npm run build:helpers
npm start            # run from source
```

`npm start` uses the same settings, chats and memory as the installed app (`%APPDATA%\island-assistant`). To try things without touching them, set `ISLAND_PROFILE_DIR` to an empty folder first:

```powershell
$env:ISLAND_PROFILE_DIR = "$env:TEMP\island-dev"; npm start
```

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Runs Island from source |
| `npm run assets` | Rebuilds the icon and logo files from `lucide-static` and `@lobehub/icons-static-svg` |
| `npm run build:helpers` | Compiles the native helpers into `helpers/` (see below) |
| `npm run icon` | Packs `build/icon-src/*.png` into `build/icon.ico`, `build/icon.png` and `src/assets/icon.ico` |
| `npm run dist` | Builds the helpers, then the NSIS installer in `dist/` |
| `npm run test:smoke` | Starts Island with a throwaway profile, opens every screen, checks idle memory and page errors |
| `npm run test:connectors` | Connectors sleep until used, wake on a call, and refuse a tool that changed |
| `npm run test:search` | The search services that need no key (DuckDuckGo, SearXNG, automatic) against the real web |
| `npm run test:speech` | Speech services (Google, Deepgram incl. streaming, Sarvam, ElevenLabs) against a local stand-in server |
| `npm run test:google` | The free Google key path (models, key check, web search) against a stand-in server |
| `npm test` | All of the above that need no key or network |
| `node scripts/helpers-check.js` | Native helpers give the same answers as their PowerShell versions |
| `node scripts/agent-eval.js` | The task suite: everyday jobs given to Island, run several times each, with a success rate. Needs an API key and costs a few cents. `--pc` adds mouse-and-keyboard tasks (don't use the PC while it runs) |

## Native helpers

Four small programs do Windows work that JavaScript can't: tracking the window in front (`island-focus.exe`), mouse and keyboard (`island-input.exe`), reading other apps' controls through UI Automation (`island-uia.exe`) and speaking with Windows voices (`island-tts.exe`).

`scripts/build-helpers.js` compiles them with the C# compiler that ships with Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`), so there's nothing extra to install. The C# for input and UI Automation lives in `src/input.js` and `src/uia.js`; the others are in `src/helpers/`.

If a helper is missing, or antivirus blocks it, Island runs the same code through PowerShell instead. That works the same but uses about 70 MB more memory per helper.

## Connectors (MCP)

The catalog of MCP servers Island offers in Settings → Connectors is in `src/connectors.js`. Each one either points at a hosted server or runs a package with `npx`, using the Node that ships with Island, so nothing has to be installed. Firecrawl comes in two forms:

| Form | How it runs | Where the key goes |
|---|---|---|
| Hosted | `https://mcp.firecrawl.dev/v2/mcp` | The `Authorization` header |
| On your PC | `npx -y firecrawl-mcp` | The `FIRECRAWL_API_KEY` environment variable |

## Translations

Interface text is translated at run time by `src/renderer/i18n.js` from `src/renderer/i18n/<lang>.js` (English text → translation; `{0}` marks numbers or names). To add or update a language:

```bash
node scripts/extract-strings.js > strings.json          # every interface string
node scripts/build-i18n.js hi my-translations.json       # merge a batch of translations
```

## Troubleshooting

- **"Windows protected your PC"** when installing: the installer isn't signed yet. Choose More info → Run anyway.
- **Antivirus flags a helper**: Island falls back to PowerShell automatically. You can report a false positive to your antivirus vendor.
- **The shortcut doesn't open Island**: another app took Ctrl+Alt+Space. Island picks a free one and says which; change it in Settings → Voice and keys.
