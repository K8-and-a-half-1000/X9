<h1 align="center">AD</h1>

<p align="center">
  <em>Archdeamon</em>
</p>

<p align="center">
  A self-hosted AI workspace for chat, agents, research, documents, notes, and local model workflows.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/setup.md">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <img src="docs/odysseus-browser.jpg" alt="AD interface">
</p>

---

## Quick Start

> `dev` is the default branch and gets the newest changes first. Use [`main`](https://github.com/K8-and-a-half-1000/X9/tree/main) if you want the more curated branch.

```bash
git clone https://github.com/K8-and-a-half-1000/X9.git
cd AD
cp .env.example .env
python -m venv venv && . venv/bin/activate   # Windows: launch-windows.ps1 does all of this
pip install -r requirements.txt
python setup.py
uvicorn app:app --host 127.0.0.1 --port 7000
```

Open `http://localhost:7000`. On Windows, `launch-windows.ps1 -Port 7000` performs the venv, dependency, setup, and run steps in one go.

Native install details, GPU notes, Windows instructions, HTTPS, and configuration live in the [setup guide](docs/setup.md).

## Features

- **Chat + Agents** — local/API models, tools, MCP, files, shell, skills, and memory.
- **Cookbook** — hardware-aware model recommendations, downloads, and serving.
- **Deep Research** — multi-step web research with source reading and report generation.
- **Documents** — writing-first editor with AI edits, suggestions, Markdown, HTML, CSV, and syntax highlighting.
- **Extras** — gallery/image editor, themes, uploads, web search, presets, and sessions.

## Demo

A full hover-to-play tour lives on the landing page: [`docs/index.html`](docs/index.html).

## Contributing

Help is welcome. The best entry points are fresh-install testing, provider setup bugs, mobile/editor polish, docs, and small focused refactors. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## Security

AD is a self-hosted workspace with powerful local tools. Keep auth enabled, keep private data out of Git, and do not expose raw model/service ports publicly. Deployment details are in the [setup guide](docs/setup.md#security-notes).

## Star History

<a href="https://www.star-history.com/?repos=pewdiepie-archdaemon%2Fodysseus&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=K8-and-a-half-1000/X9&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=K8-and-a-half-1000/X9&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=K8-and-a-half-1000/X9&type=date&legend=top-left" />
 </picture>
</a>

## License

AGPL-3.0-or-later -- see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).
