# Mail Reader

A local-first desktop email assistant for Outlook. It syncs your mail through the
Microsoft Graph API, analyzes each message with a **local** AI model via
[Ollama](https://ollama.com) (nothing is sent to a cloud LLM), and helps you
triage and reply — drafting and sending responses straight back through Outlook.

Built with [Tauri 2](https://tauri.app), React + TypeScript, and a Rust backend
with per-account SQLite storage.

## Features

- **Outlook sync** — Inbox, Sent, and Drafts folders via Microsoft Graph (OAuth, PKCE).
- **Local AI analysis** — each email gets a priority (high / medium / low), reasoning,
  and a suggested response, generated on-device with your chosen Ollama model.
- **Home dashboard** — inbox stats, priority breakdown, analysis progress, and a
  slideshow of analyzed emails you can edit, draft, or send from.
- **Draft & send** — create a reply draft in your Outlook Drafts folder, or send a
  reply immediately, using the AI suggestion (editable) as a starting point.
- **Threaded reading** — reply chains are split into distinct message blocks.
- **Writing styles** — define tone/style presets that get injected into analysis and drafts.
- **Per-account databases** — each signed-in account gets its own isolated SQLite file.
- **Theming** — light/dark mode plus a selectable accent colour.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable)
- [Ollama](https://ollama.com) running locally with at least one model pulled
  (e.g. `ollama pull llama3.1`)
- Platform build tooling:
  - **macOS** — Xcode Command Line Tools
  - **Windows** — Microsoft C++ Build Tools + WebView2 (bundled on Win 11)
  - **Linux** — `webkit2gtk` and related dev packages (see Tauri docs)

## Development

```bash
npm install
npm run tauri dev
```

This starts Vite and launches the desktop app with hot reload.

## Building

```bash
npm run tauri build
```

Installers are written to `src-tauri/target/release/bundle/`:

- macOS → `.dmg` / `.app`
- Windows → `.msi` (WiX) and `.exe` (NSIS)
- Linux → `.AppImage` / `.deb`

> **Cross-compiling is not supported.** Build each platform on that platform, or
> use the GitHub Actions workflow below to build macOS + Windows in the cloud.

## Releasing (GitHub Actions)

The workflow at [`.github/workflows/release.yml`](.github/workflows/release.yml)
builds macOS and Windows installers on GitHub's runners and attaches them to a
draft GitHub Release.

Trigger it by pushing a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or run it manually from the **Actions** tab (it also supports `workflow_dispatch`).
When it finishes, open the draft release under **Releases**, review the attached
`.msi` / `.exe` / `.dmg`, and publish.

## Project layout

```
src/                  React + TypeScript frontend
  pages/              Home, Inbox, Conversations, Settings, DraftEditor
  components/         NavBar, UI primitives
src-tauri/            Rust backend
  src/lib.rs          Tauri commands, auth, app state
  src/graph.rs        Microsoft Graph API calls
  src/db.rs           SQLite schema + queries
  src/ollama.rs       Local AI model integration
  icons/              App icons
scripts/
  clear-data.sh       Testing helper: wipes local databases
```

## Notes

- **Deep-link login on Windows/Linux** relies on the single-instance plugin so the
  `mailreader://` OAuth callback reaches the running app. The URI scheme is
  registered by the installer, so test the *installed* build (not `tauri dev`) on Windows.
- **Resetting local data** (for testing) — run `./scripts/clear-data.sh`. There is no
  in-app button for this by design.
