# Island

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Platform: Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6.svg)](#requirements)
[![CI](https://github.com/anythingeverything556-blip/island-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/anythingeverything556-blip/island-assistant/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/anythingeverything556-blip/island-assistant)](https://github.com/anythingeverything556-blip/island-assistant/releases/latest)

An open-source AI assistant for Windows that lives at the top of your screen, like a Dynamic Island. Press **Ctrl+Alt+Space** and it opens into a chat. It can answer questions, see your screen, use your mouse and keyboard when you allow it, teach you an app step by step, and talk with you out loud, in English, Hindi and many other languages. Bring your own key: Claude, Gemini, OpenAI-compatible services, or free local models.

<!-- Add a screenshot or short GIF at docs/screenshots/panel.png, then show it here:
![Island open](docs/screenshots/panel.png) -->

> **Project status:** early. The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC" (choose **More info → Run anyway**). Free signing for open-source projects (SignPath Foundation) is planned.

## What it does

- **Chat** with Claude, Gemini, or any model your provider offers. Message actions like Claude's: copy, edit, retry, and branch into a new chat.
- **Start free:** a free Google AI Studio key is enough for chat, voice input and web search.
- **Sees your screen** when you ask ("what does this error mean?") or while you talk.
- **Uses your PC** (mouse, keyboard, PowerShell, files) when you allow it. It shows a plan you can approve in one go, asks before anything risky, keeps an activity log, and file changes can be undone.
- **Teach me:** Island points at the real button to click, waits for you to do it, and explains each step, with a practice round.
- **Voice:** push-to-talk or a hands-free live conversation. It hears which language you speak and answers in it, with Windows voices or a natural voice from a service you choose.
- **Hindi interface**, plus study mode for students (hints first, full solutions when asked).
- **Reminders and timers**, long-term **memory** you can see and edit, and **connectors** (MCP) that only run while they're used.
- **Firecrawl** as a connector (MCP): Island can search the web and read pages as clean text. Add it in the Connectors tab. It can use Firecrawl's own server or run on your PC.
- **Accessible:** screen-reader announcements, Windows high-contrast mode, larger text sizes and a dyslexia-friendly font.

## Getting started

1. Download the latest installer from [**Releases**](https://github.com/anythingeverything556-blip/island-assistant/releases/latest) and run it.
2. Island opens its account page. Pick **Google (free)** and press **Get a free key**, or paste an Anthropic or gateway key.
3. Press **Ctrl+Alt+Space** anywhere to open or hide Island.

Useful keys: `Enter` send · `Shift+Enter` new line · `Esc` close · `Ctrl+N` new chat · `Ctrl+H` chats · `Ctrl+M` model · `Ctrl+Shift+S` include your screen · `Ctrl+Shift+L` live conversation · `F11` full screen · `Ctrl+,` settings.

## Keys you can use

Island never comes with a key. You bring your own, and each one is stored encrypted by Windows.

| Service | Used for | Free tier |
|---|---|---|
| Google AI Studio | Chat (Gemini), voice to text, web search, Google voices* | Yes |
| Anthropic | Chat with Claude, using the PC, web search | No (pay as you go) |
| Any Anthropic-compatible gateway | Chat with many models | Depends on the gateway |
| Any OpenAI-compatible service | Chat with many models | Depends on the service |
| A server on your own PC (Ollama, LM Studio) | Chat with local models, no key needed | Free |
| Deepgram | Voice to text while you talk (fastest live voice) | Free credit for new accounts |
| Sarvam | Voice to text and natural voices for Hindi and Indian languages | Free credit for new accounts |
| ElevenLabs | Very natural voices | Small monthly allowance |
| Speko | Natural voices: 40+ voice models (ElevenLabs, Cartesia, Deepgram, Google and more) behind one key, and Speko picks the best one for the language | $10 of credit for every new account |
| Microsoft Azure Speech | Natural voices in 140+ languages | Yes |

Paste the address of your service under API address and Island talks to it. It asks for
the model list the plain way first, so a gateway that changes the list when it sees an
Anthropic header still shows the real model names.

\*Google voices need the Cloud Text-to-Speech API turned on for the key's project.

### Web search services

Island can look things up on the web. You pick where the search comes from in Settings → AI and model → Web search. The default is Automatic: your AI service searches when it can, otherwise a search key you saved, otherwise DuckDuckGo.

| Service | Key | What you get |
|---|---|---|
| Tavily | Free key at tavily.com | 1,000 searches a month, no card |
| Brave Search | Free key at api.search.brave.com | 1,000 searches a month, a card is needed |
| Serper | Free key at serper.dev | 2,500 queries to start |
| Exa | Free key at exa.ai | $10 of credit a month |
| Firecrawl | Free key at firecrawl.dev | 1,000 credits a month, no card |
| SearXNG | None, it is your own instance | Nothing goes to anyone else |
| Google AI Studio | Free key at aistudio.google.com | 5,000 searches a month |
| Anthropic | The Anthropic key you already saved | Only works when Anthropic is your AI service |
| OpenRouter | The OpenRouter key you already saved | Search costs a little. Only works when OpenRouter is your AI service |
| DuckDuckGo | None needed | Free and always on |

## Privacy

Island runs on your PC. It sends your messages only to the AI service you chose, your voice only to the speech service you chose, and spoken sentences only to the voice service you chose. Web searches go to the search service you chose, and the keys for those services stay on your PC, encrypted by Windows. Chats, memory and settings stay in `%APPDATA%\island-assistant`. There is no telemetry and nothing is uploaded when it crashes. Once a day it asks GitHub whether a newer version is out; nothing about you is sent. See [PRIVACY.md](PRIVACY.md).

## Requirements

Windows 10 or 11, 64-bit. A microphone for voice.

## Development

```bash
npm install
npm run assets
npm run build:helpers
npm start
```

See [BUILDING.md](BUILDING.md) for building the installer, the native helpers, and the tests, and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

```
src/main.js            window, shortcuts, tray, approvals, IPC
src/agent.js           the conversation and tool loop
src/tools.js           tools (files, apps, PowerShell, memory, web…)
src/computer.js        using the mouse and keyboard, teach-me
src/stt.js             voice to text (gateway, Google, Deepgram, Sarvam)
src/tts.js             Windows voices; src/online-voice.js natural voices
src/mcp.js             connectors that sleep until used
src/permissions.js     when Island asks first
src/helpers/*.cs       small native helpers, compiled at build time
src/renderer/          the interface (plain HTML, CSS and JS; i18n/ has translations)
src/overlay/           the on-screen cursor, highlights and teach-me coach
scripts/               build steps and tests
```

## License

Island is made by [AnythingEverything](https://github.com/anythingeverything556-blip) and is free and open source under the [GNU Affero General Public License v3.0](LICENSE), with additional attribution terms in [NOTICE.md](NOTICE.md).

In short: you can use, study, change and share Island. If you share a changed version, or run one for other people (including as a website or online service), you must publish its full source under the same license, keep the credit **"Based on Island by AnythingEverything"**, and make clear it is a changed version, not the original Island or your own original work. The Island name and logo are not licensed for naming or promoting other products.

Logos of AI, speech and search services shown in the app are trademarks of their respective owners.
