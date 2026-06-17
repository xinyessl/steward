# Steward · Multi-Project Dev Hub

**English** | [简体中文](README.zh-CN.md)

> A **blank tool** like VSCode: clone it, point it at your own projects, and go. The core idea is **spec-driven**: every project keeps a uniform spec at `docs/specs/<ID>.md` as the single source of truth, so different people/AIs can work on the same project by following the spec instead of guessing.

Zero third-party dependencies (one Node script runs the server), a single-page console, all your projects managed and viewed in one place.

---

## What it solves

- **One place for many projects**: register any project (frontend / backend / any stack), then switch, track progress, and dispatch work from a single console.
- **Auto-generate specs for existing projects**: `/scan` reverse-reads your current code and builds a `docs/specs/*.md` baseline **by feature module** (cheap model, incremental, flags `NEEDS-HUMAN`), so legacy projects become "documented and traceable" too.
- **Spec-driven development**: new requirements/changes are first broken down + run through **impact analysis** (touch one thing → auto-find which specs are affected) → edit spec → implement → accept on the board.
- **Solve it once, never again**: every non-obvious problem you fix together with the AI (a style glitch, a filter that doesn't apply, a wrong field mapping…) is distilled into a lesson in a **shared, cross-project knowledge base** (`~/.steward/lessons.md`). The dev agent of **every** managed project **reads it before each task** to avoid repeating past mistakes and **writes a new lesson after** solving one — a pitfall hit in one project is avoided in all the others.
- **Embedded terminal**: open multiple claude windows per project (persisted via ttyd + tmux, survives refresh/reconnect), with a live tri-color status: working / needs-confirmation / idle.
- **Tool/data isolation**: the tool itself holds no project data; the project registry lives in `~/.steward/`, each project's artifacts stay in its own directory — updating the tool never touches your data.

## Feature overview

- **Left**: a task list **grouped by feature module** (progress lights + priority + status); pending items can be **approved / rejected in one click**; click an item to read the full spec.
- **Right**: multi-window embedded terminal (with a "commands" panel, history, draggable splitter).
- **Top**: project switcher (dropdown / spread-all), 🔔 to-do inbox (click to locate & highlight, dismissable).

---

## Install

Requirements: **Node.js** (runs the console), **ttyd + tmux** (embedded terminal + session persistence), and the **claude CLI**.

```bash
# macOS
brew install ttyd tmux

# Linux (Debian/Ubuntu)
sudo apt update
sudo apt install -y tmux
sudo apt install -y ttyd      # available on Ubuntu 22.04+; on older releases grab a static binary from ttyd releases
```

### Windows
This tool relies on Unix-style components (`ttyd` / `tmux` / `lsof` / `pkill`), so it is **not supported on native Windows**. Use **WSL2** (Windows Subsystem for Linux):

1. Install WSL2 + a distro (admin PowerShell): `wsl --install -d Ubuntu`, then reboot and open Ubuntu.
2. **Inside WSL**, install the dependencies:
   ```bash
   sudo apt update && sudo apt install -y nodejs npm tmux ttyd
   # install the claude CLI inside WSL too (per its official instructions)
   ```
3. **Clone the repo into the WSL Linux filesystem** (e.g. `~/steward`), **not under `/mnt/c/...`** — `fs.watch` is unreliable across the Windows mount, so the board won't auto-refresh there.
4. Run `bash tools/start.sh` inside WSL, then open http://127.0.0.1:5178 in your **Windows browser** (WSL2 forwards localhost automatically).

## Run

```bash
git clone https://github.com/xinyessl/steward.git
cd steward
bash tools/start.sh          # → http://127.0.0.1:5178
```

## Quick start

1. In the console click **"Add project"**, then pick the **project type**:
   - **Existing project (has code)** → point the path at your current repo (only team files are added; your code is untouched).
   - **New project (greenfield)** → set the path to a new directory and directly select a **PRD file** + a **prototype folder**; on creation they're copied into `docs/PRD.*` and `docs/prototype/`.
   - **Git repo** → paste a clone URL (https / git@ / ssh); it's `git clone`d to a local dir using your machine's git credentials, then imported as existing code.
2. Open a **terminal window** for the project and follow your starting point (the console offers to run it for you after creation):
   - **Existing** → `/scan` reverse-reads the source and generates a `docs/specs/*.md` baseline by feature module (draft, awaiting review).
   - **Greenfield** → `/init` picks the stack + scaffolds a minimal skeleton, then `/spec` decomposes the PRD into a spec tree (here **PRD + prototype = source of truth**).
3. For later requirements/changes use `/spec`·`/build`·`/fix`: break down + impact analysis → edit spec → implement → approve / reject on the board.

## Slash commands (bundled into every project)

| Command | Purpose |
|---|---|
| `/init` | Greenfield startup: pick stack + scaffold minimal skeleton + .gitignore (PRD+prototype start; run before the first `/build`) |
| `/scan [module]` | Reverse-read existing code, generate/update the spec baseline by feature module |
| `/spec <requirement>` | Turn requirements (one or many at once) into verifiable specs, with breakdown + impact analysis |
| `/build <id>` | Implement one feature per spec (dev agent: implement + test + real-DB smoke) |
| `/fix <bug/change>` | Close the loop on a bug/change (breakdown + impact → edit spec/test → edit code → regress) |
| `/accept <id>` | Acceptance loop (produce acceptance materials + spec-diff confirmation; rejection auto-drives the fix) |
| `/lesson [pitfall]` | Distill a just-solved pitfall into the shared lessons base (`~/.steward/lessons.md`, cross-project) |
| `/autopilot [scope]` | Autopilot: parallelize across modules, drive each feature to "pending acceptance" |

---

## Architecture & layout

```
steward/                     # the tool itself (shareable, contains no project data)
├─ tools/server.mjs          #   console server (zero deps)
├─ tools/start.sh            #   launch
├─ tools/new-project.sh      #   register a project from the CLI
├─ dashboard/index.html      #   console UI
└─ templates/                #   new-project scaffold (copied wholesale into a new project)
   ├─ CLAUDE.md              #     the managed project's orchestration manual (the methodology)
   ├─ .claude/agents/dev.md  #     dev agent
   ├─ .claude/commands/      #     /init /scan /spec /build /fix /accept /autopilot
   ├─ docs/specs/_TEMPLATE.md#     uniform spec template
   └─ tools/board.mjs        #     derives the board from specs

~/.steward/projects.json     # user data: the project registry (isolated from the tool; override with STEWARD_DATA)
<your-project>/docs/specs/*.md  # per-project artifact: specs (source of truth, commit to git)
<your-project>/docs/board.json  # auto-derived by board.mjs (do not commit, gitignored)
```

### What to commit (project side)
- **Commit**: `docs/specs/*` (the source, incl. status), `docs/changes`, `docs/reviews`, `CLAUDE.md`, `.claude/agents`+`commands`, `tools/board.mjs`. (The lessons base lives in `~/.steward/lessons.md` — global/per-user, not committed per project.)
- **Don't commit** (generated / runtime / local): `docs/board.json`, `docs/board.md`, `docs/tasks.json`, `docs/.state/`, `.claude/plan.md`, `.claude/settings.local.json`.
  > Newly imported projects ship with `docs/.gitignore` / `.claude/.gitignore` that enforce this boundary automatically.

## Methodology TL;DR

- **Single source of truth = `docs/specs/*`**; no spec, no development; code/tests/commits link back to a spec.
- **Spec-first**: change the spec before the code for any requirement/bug.
- **Feature-module organization**: specs are grouped by feature module (product-facing); each spec = one full-stack feature.
- **Impact analysis**: before touching anything, break it down and trace dependencies / shared tables / shared interfaces to compute the blast radius, then confirm with a human.
- **Humans guard only the gates**: spec review, acceptance, release, and ambiguity rulings; everything else is document-driven and flows automatically.

See `templates/CLAUDE.md` (the orchestration manual bundled into every managed project).

---

## License

[MIT](LICENSE) © xinyessl
