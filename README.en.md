# Luna Translator

A self-hosted Web frontend and Go backend for real-time speech translation, licensed under Apache-2.0. Version 0.1 covers solo / face-to-face translation, persistent history, WAV replay and revocable snapshot links. Models, training assets, private inference implementations, mobile clients and multi-party RTC are outside this release.

Install Docker Engine/Desktop with Compose, download/clone this repository, then run `./start.sh` (Windows: `./start.ps1`). Open http://localhost:8088 and use the generated workspace password printed by the script.

Default mode is explicitly simulated: fixed sample captions and a tone, with no speech recognition or actual translation. For real operation, copy `.env.example` to `.env`, set `DEMO_MODE=false`, configure your own Luna API key and optional Model Studio ASR / Embedding account, then restart using the same command. No GPU, SMS service or external database is required.

This is a single-workspace deployment: everyone with its password shares the same history. Use separate deployments for separate users. Remote microphone access requires HTTPS. Private keys stay in the backend environment. Provider accounts, costs and concurrency limits are separate from this application's source license.

Read the [Chinese quick start](README.md), [deployment guide](docs/deployment.md), [provider contracts](docs/providers.md), [validation record](docs/validation.md), [roadmap](docs/open-source-plan.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
