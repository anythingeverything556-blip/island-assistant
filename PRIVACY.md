# Privacy

Island is a program on your PC, not an online service. Its makers don't receive anything you do in it.

## What leaves your PC, and only when you use it

- **Your messages** go to the AI service whose key you added (for example Google, Anthropic or a gateway). That includes what you type or say, files and pictures you attach, and a screenshot when you share your screen or ask Island to look.
- **Your voice** goes to the speech-to-text service you picked in Settings → Voice and keys (your AI service by default). Island doesn't keep the recording.
- **Spoken replies** are read by Windows on your PC. If you add a key for a natural voice (Azure, Google, ElevenLabs, Sarvam or Speko), only the sentence being read is sent to that service.
- **Web searches** go to the search service you pick in Settings → AI and model → Web search, or to your AI service when it does the searching itself. Island sends the words you searched for, and that service sends back the pages it found. By default that is your AI service when it can search, otherwise a search key you saved, otherwise DuckDuckGo.
- **Search services** are Tavily, Brave Search, Serper, Exa, Firecrawl, SearXNG, Google AI Studio, Anthropic, OpenRouter and DuckDuckGo. Their keys are encrypted by Windows and stay on your PC.
- **Connectors** you add get only what Island sends them while using them.
- **Update check:** once a day Island asks GitHub which version is newest. Nothing about you is sent.

Each of those services has its own privacy terms. Free tiers (such as Google AI Studio's) may let the provider use your chats to improve its models.

## What stays on your PC

- Chats, memory, the activity log and settings, in `%APPDATA%\island-assistant`. Private chats aren't saved at all. You can delete any of it inside Island.
- Your keys, encrypted by Windows (DPAPI). Island never shows them.

## What Island doesn't do

- No telemetry, analytics or crash uploads.
- It won't type passwords or payment details for you.
- It asks before using your mouse and keyboard, running commands or changing files, unless you chose otherwise in Settings.
