# Contributing

Use focused pull requests against the community repository. Run `npm ci`, `npm run build --workspace web`, the targeted frontend test command in `docs/validation.md`, and `go -C backend test -race ./...`.

Ordinary CI uses deterministic protocol fixtures; no model credentials or internal infrastructure is needed. Live model tests require an explicit opt-in and your own account, use synthetic or permitted audio, and may incur provider charges. Never add keys, user recordings, production exports or model assets to a PR.

Current priorities: browser compatibility, accessibility, provider adapters, dependency cleanup and better documented alignment strategies. Multi-party RTC and mobile sources follow the Web-first roadmap.
