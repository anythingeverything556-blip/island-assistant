# Contributing to Island

Thanks for helping. Island is meant for everyone, including people who have hardly used a computer, so plain words and reliability matter more than features.

## Before a pull request

1. `npm test` passes (it needs no key and no internet).
2. If you touched the interface, run `npm start` and look at it in light and dark themes, at the normal and full-screen sizes, and with Settings → General → Language set to हिन्दी.
3. If you changed how Island uses the PC, run `node scripts/agent-eval.js --only <the tasks you affected>` and mention the result.

## Code style

- Plain JavaScript, no framework, no build step for the app itself. Match the code around your change.
- Comments explain *why*, briefly. Don't narrate what the code does.
- Keep functions small and names clear. Prefer one obvious way over a configurable one.
- Never log, print or commit keys. Keys go through `settings.setSpeechKey` / `setApiKey`, which encrypt them with Windows.
- Anything that reads outside content (web pages, files, connector results) must treat it as data, never as instructions.

## Writing interface text

- Short, everyday words. Say what will happen: "Delete 3 files" rather than "Confirm".
- No jargon, no exclamation marks in errors, no em dashes.
- Errors say what went wrong and what to do next.
- New strings are picked up by `scripts/extract-strings.js`; add their Hindi to `src/renderer/i18n/hi.js` (or ask in the PR and someone will).

## Reporting security problems

Please don't open a public issue. Use GitHub's **Report a vulnerability** (Security tab) so it can be fixed before it's public. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License of your contribution

Island is licensed under the GNU AGPL v3.0 with the additional terms in [NOTICE.md](NOTICE.md). By opening a pull request, you agree that your contribution is licensed under those same terms, and you confirm that you wrote it or otherwise have the right to submit it.
