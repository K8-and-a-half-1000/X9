# X9 Setup Guide

This page keeps the detailed install, deployment, troubleshooting, and configuration notes out of the front README.

## Quick Start

> **Branch note:** `dev` is the default branch and contains the latest development changes, but it may be unstable. For the more stable curated branch, use [`main`](https://github.com/K8-and-a-half-1000/X9/tree/main).

Defaults work out of the box: clone, run, then configure models/search
inside **Settings**. Only edit `.env` for deployment-level overrides like
`APP_BIND`, `APP_PORT`, or `DATABASE_URL`.

Contributing? See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, testing, and
pull request guidelines.

### Native Linux
```bash
git clone https://github.com/K8-and-a-half-1000/X9.git
cd X9
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python setup.py
python -m uvicorn app:app --host 127.0.0.1 --port 7000
```
Requirements: Python 3.11+. Cookbook also needs `tmux` for background model
downloads and serves. The app itself is lightweight; local model serving is the
heavy part and depends on the model, runtime, GPU, and VRAM, so small hosts can
connect to API or remote model servers instead. Use `--host 0.0.0.0` only when you intentionally want LAN/reverse-proxy access.

<details>
<summary>Cookbook, GPU, Ollama, and troubleshooting notes</summary>

**Remote servers.** In **Cookbook -> Settings -> Servers**, generate the
X9 SSH key and add the public key to the remote server's
`~/.ssh/authorized_keys`. From the host you can also run:

```bash
ssh-copy-id -i data/ssh/id_ed25519.pub user@server
```

> **GPU visible ≠ llama.cpp CUDA.** `nvidia-smi` passing confirms the GPU is
> reachable, but llama.cpp also needs `cudart` and the CUDA Toolkit at
> runtime. If Cookbook logs show `Unable to find cudart library`, `Could NOT
> find CUDAToolkit`, `CUDA Toolkit not found`, or tensors/layers assigned to
> CPU, that is a Cookbook/llama.cpp build issue. Reinstall the serve engine
> via **Cookbook → Dependencies** to get a CUDA-enabled build.

**Ollama.** If Ollama is already running on this machine, add this endpoint
in Settings:

```text
http://localhost:11434/v1
```

Cookbook **Serve** is a separate workflow for serving downloaded models
through X9/llama.cpp, so users with an existing Ollama install usually
only need to add the endpoint in Settings.

</details>

### Native Windows

**One-command launcher** (creates the venv, installs deps, runs setup, starts the
server; safe to re-run):

```powershell
git clone https://github.com/K8-and-a-half-1000/X9.git
cd X9
powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1
```

Or do it by hand:

```powershell
git clone https://github.com/K8-and-a-half-1000/X9.git
cd X9
py -3.11 -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt
python setup.py
python -m uvicorn app:app --host 127.0.0.1 --port 7000
```

If `python` points at an older interpreter, use `py -3.12` (or another installed
3.11+ version) for the venv step.

**Exposing on a LAN/Tailscale (Windows):** the launcher binds to `127.0.0.1` and
does **not** read `APP_BIND` / `X9_HOST` from `.env`, so editing `.env`
alone leaves the native Windows server on loopback. Pass the launcher's
`-BindHost` flag instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1 -BindHost 0.0.0.0
```

The manual `uvicorn` command takes the same address as `--host 0.0.0.0`. Bind
outside loopback only for a trusted LAN/VPN such as Tailscale, and do not
expose the port directly to the public internet — X9 has no login flow.

**Requirements:** Python 3.11+. The core app (chat, agent, memory, documents,
calendar, deep research) runs fully native. For **Cookbook** background
model downloads, also install
[Git for Windows](https://git-scm.com/download/win) (provides `bash.exe`);
the agent shell tool runs PowerShell natively.
Local GPU *serving* of vLLM/SGLang needs Linux/WSL2; for a local model on Windows,
[Ollama](https://ollama.com/download) is the easiest path — point X9 at
`http://localhost:11434/v1` in Settings.

Open `http://localhost:7000` and configure everything else inside **Settings**.

## Troubleshooting & Advanced Setup

### `chromadb-client` conflicts with embedded ChromaDB
If `chromadb-client` (the lightweight HTTP-only package) is installed alongside the full `chromadb` package, X9 starts but ChromaDB silently falls back to HTTP-only mode and fails.

**Fix:** uninstall `chromadb-client` and force-reinstall the full package:
```bash
./venv/bin/pip uninstall chromadb-client -y
./venv/bin/pip install --force-reinstall chromadb
```

### HTTPS + LAN/Tailscale exposure
To expose X9 on a local network or Tailscale with HTTPS:
1. Change the bind address to `0.0.0.0` in `.env` (`APP_BIND=0.0.0.0` or `X9_HOST=0.0.0.0`).
2. Generate a locally-trusted cert for your LAN/Tailscale IPs using [mkcert](https://github.com/FiloSottile/mkcert):
   ```bash
   mkcert -install
   mkcert -cert-file cert.pem -key-file key.pem 192.168.1.100 tailscale-ip
   ```
3. Run `uvicorn` with the generated certs:
   ```bash
   python -m uvicorn app:app --host 0.0.0.0 --port 7000 --ssl-certfile=cert.pem --ssl-keyfile=key.pem
   ```
4. Install the `mkcert` CA on any other device you want to access X9 from (e.g., for iOS, email the `rootCA.pem` to yourself, install the profile, and trust it in Certificate Trust Settings).

### Common self-host traps (30-second fixes)
A grab-bag of small gotchas that otherwise turn into long debugging sessions.

- **The first `.env` setting is silently ignored (Windows).** If you edited `.env` in Notepad it may have saved a UTF-8 **BOM**, turning the first key into `﻿APP_PORT` (etc.) so it is never matched. X9 loads `.env` with `encoding="utf-8-sig"` to tolerate a leading BOM, but the safe fix is to re-save `.env` as **UTF-8 without BOM** (VS Code: *Save with Encoding → UTF-8*).
- **Copy buttons do nothing over a plain-HTTP Tailscale/LAN URL.** Browsers only expose the clipboard API (`navigator.clipboard`) on **secure origins** — HTTPS, or `localhost`. Over `http://100.x.y.z:7860` it is blocked. Serve over HTTPS (see *HTTPS + LAN/Tailscale exposure* above); `localhost` is exempt, so copy still works on the host itself.
- **Self-hosted ntfy reminders don't reach your phone.** Two things: (1) a loopback-bound ntfy is unreachable from your phone — bind ntfy to your host/Tailscale IP and use that same server URL in X9 reminder settings; (2) in the ntfy **Android** app, subscribe to the topic with **Instant delivery** enabled — non-`ntfy.sh` servers don't get instant push otherwise.
- **Calendar/contacts (Radicale) won't sync.** Point X9 at the **full collection URL** with its trailing slash — e.g. `http://host:5232/<user>/<collection-id>/` — not just the server root. Radicale shows this address for each calendar/address book in its web UI.

### Optional Dependencies
`requirements-optional.txt` contains packages that unlock extra features. It is not installed by default.

| Package | Feature unlocked |
|---------|-----------------|
| `faster-whisper` | Local speech-to-text (microphone -> text) via the "local" STT provider. |
| `ddgs` | DuckDuckGo as a search provider option. |
| `PyMuPDF` | PDF page rendering in the side viewer panel and form-filling. (Note: AGPL-3.0) |
| `markitdown` | Office/EPUB document text extraction (converts .docx/.xlsx/.pptx/.xls/.epub to Markdown). |

### Faster, reproducible installs with uv (optional)
[uv](https://docs.astral.sh/uv/) works as a drop-in replacement for the
venv + pip steps in the native install guides, no project changes are needed but this change results in faster installs along with a lockfile for reproducible environments. After [installing `uv`](https://docs.astral.sh/uv/getting-started/installation/), use:

```bash
uv venv venv --python 3.13
uv pip install -r requirements.txt
# then continue as usual: python setup.py, uvicorn, ...
```

`requirements.txt` is intentionally unpinned, so two installs at different times can produce different package versions. If you want a reproducible environment (e.g. across your own machines, or to roll back after a bad upgrade), snapshot and restore exact versions with:

```bash
uv pip compile requirements.txt -o requirements.lock   # snapshot current resolution
uv pip sync requirements.lock                          # reproduce it exactly later
```

`requirements.lock` is gitignored and platform-specific (compile it on the OS you deploy to). Regenerate it deliberately when you want to take upgrades. The plain `uv pip install -r requirements.txt` keeps following the unpinned requirements like pip does.

## Security Notes
X9 is a self-hosted workspace with powerful local tools: shell access, file uploads, model downloads, web research, calendar integrations, and API tokens. Treat it like an admin console.

- X9 has **no login flow** (single-user). Keep it bound to loopback and serve it exclusively through your Zero-Trust gateway.
- Do not expose it directly to the public internet without HTTPS and a trusted reverse proxy or private access layer.
- Keep `.env`, `data/`, `logs/`, databases, uploads, generated media, backups, session files, API keys, and model/provider tokens out of Git and private shares. They are ignored by default.
- Rotate any API keys or tokens that were ever pasted into a shared chat, demo, screenshot, or log.
- If you enable API tokens or webhooks, create separate tokens per integration and delete unused ones.
- Prefer binding manual development runs to `127.0.0.1`; bind to `0.0.0.0` only when you intentionally want LAN/reverse-proxy access.
- Keep ChromaDB, SearXNG, ntfy, Ollama, vLLM, llama.cpp, databases, and raw model/provider APIs internal-only. Expose only the authenticated X9 web/API entrypoint through your trusted proxy or private access layer.
- Before publishing a fork, run `git status --short` and confirm no private files from `.env`, `data/`, `logs/`, uploads, backups, or local databases are staged.

### Private or proxied deployments
X9 serves plain HTTP on its app port and binds to `127.0.0.1` by default, so a typical production/private setup is:

1. Keep X9 on localhost, for example `127.0.0.1:7000`.
2. Terminate HTTPS and authentication at a trusted reverse proxy or private access gateway.
3. Put the X9 web/API entrypoint behind that layer.
4. Keep raw service and model ports internal-only.

Cloudflare Access, Tailscale, Caddy, nginx, and Traefik can all fit this pattern; none are required by X9.
`ALLOWED_ORIGINS` lists exact permitted origins for cross-origin browser/API clients; ordinary same-origin reverse-proxy access usually does not need a special CORS entry.

Common internal-only ports from the default setup:

| Port | Service |
|---|---|
| `7000` | X9 raw app port |
| `8080` | SearXNG |
| `8091` | ntfy |
| `8100` | ChromaDB host port for manual/compose access |
| `11434` | Ollama |
| `8000-8020` | Common local model/provider APIs |

## Configuration
Most setup is done inside the app with `/setup` or **Settings**. Use `.env`
for deployment-level defaults and secrets you want present before first boot.
Key settings:

| Variable | Default | Description |
|---|---|---|
| `LLM_HOST` | `localhost` | Your LLM server (e.g. `llm-host.local:8000`) |
| `LLM_HOSTS` | -- | Comma-separated list for model discovery |
| `OPENAI_API_KEY` | -- | Optional OpenAI key. Prefer adding providers in the app unless pre-seeding. |
| `SEARXNG_INSTANCE` | `http://localhost:8080` | SearXNG URL. |
| `APP_BIND` | `127.0.0.1` | Bind address for the web UI. Use `0.0.0.0` only for intentional LAN/reverse-proxy access. |
| `APP_PORT` | `7000` | Port for the web UI. |
| `ALLOWED_ORIGINS` | `http://localhost,http://127.0.0.1` | Comma-separated exact permitted origins for cross-origin browser/API clients. |
| `DATABASE_URL` | `sqlite:///./data/app.db` | Database connection string |
| `CHROMADB_HOST` | `localhost` | ChromaDB host for vector memory. |
| `CHROMADB_PORT` | `8100` | ChromaDB port. |
| `EMBEDDING_URL` | -- | OpenAI-compatible embeddings endpoint |
| `X9_CHAT_UPLOAD_MAX_BYTES` | `10485760` | Chat/agent attachment cap in bytes. Raise for larger local PDFs or text documents. |
| `X9_GALLERY_UPLOAD_MAX_BYTES` | `104857600` | Gallery image upload cap in bytes (100 MB). |
| `X9_GALLERY_TRANSFORM_UPLOAD_MAX_BYTES` | `26214400` | Gallery transform input cap in bytes (25 MB). |
| `X9_MEMORY_IMPORT_MAX_BYTES` | `10485760` | Memory import file cap in bytes (10 MB). |
| `X9_PERSONAL_UPLOAD_MAX_BYTES` | `26214400` | Personal document upload cap in bytes (25 MB). |
| `X9_STT_MAX_AUDIO_BYTES` | `26214400` | Speech-to-text audio cap in bytes (25 MB). |
| `X9_ICS_MAX_BYTES` | `10485760` | Calendar `.ics` import cap in bytes (10 MB). |

All upload-limit vars are validated (must be a positive integer) and optional; an invalid value fails fast at startup.

### Built-in MCP servers (optional setup)

X9 auto-registers a few built-in MCP servers at startup. The npx-based ones (currently the browser server, `@playwright/mcp`) only start when their npm package is already in the local npx cache. If a package isn't cached, that server is skipped with a startup log message explaining what to do, so a fresh install does not block on a multi-minute npm download or hang if Playwright system deps are missing.

To enable the browser MCP (page navigation, screenshots, vision), run once:

```bash
npx -y @playwright/mcp@latest --version
```

That installs `@playwright/mcp` plus Playwright (~300MB total). Restart X9 and the server will register at startup.

## Architecture
```
app.py                   # FastAPI entry point
core/      auth, database, middleware, constants
src/       llm_core, agent_loop, agent_tools, chat_processor, search/
routes/    chat, session, document, memory, model … endpoints
services/  docs, memory, search, hwfit (Cookbook) …
static/    index.html + app.js + style.css + js/ (modular front-end)
docs/      landing page (index.html) + preview clips
```

## Data
All user data lives in `data/` (gitignored): `app.db` (sessions, messages, documents),
`memory.json`, `presets.json`, `uploads/`, `personal_docs/`, `chroma/`, `settings.json`.

To back up or restore everything in `data/`, see the
[Backup & Restore guide](docs/backup-restore.md).
