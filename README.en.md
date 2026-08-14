# @hucj/dsh-file-mention

English | [中文](README.md)

A **`@` workspace file mention** plugin for the DSH (DeepSeek Harness) Web GUI: type `@` in the chat input, filter workspace files in real time, pick one, and it inserts `@relative/path` — the model can then read the file directly. The same `@file` reference experience as Codex CLI / Claude Code CLI.

> npm package `@hucj/dsh-file-mention` (personal scoped package); plugin composition row id: `file-mention`.

- **Git-driven filtering**: tracked files + untracked non-ignored files (new files are `@`-mentionable without `git add`); natively respects `.gitignore` — build artifacts are excluded automatically
- **`.aiinclude` re-inclusion**: files that are ignored but needed by AI (e.g. project docs) can be explicitly added back to the scan scope
- **Zero external dependencies**: both Host and Client halves are hand-written code with a hand-written build script

## Features

| Feature | Description |
|---------|-------------|
| `@` input trigger | Same `inputTriggers` mechanism as the `/` skill menu, `@pluginId`, `@subagent` — multiple sources coexist |
| Real-time filter | Matches basename or full path (case-insensitive), up to 100 results shown |
| Match ranking | **Exact match** (path/basename equal) → **prefix match** → substring match (within group: changed-first, then alphabetical) |
| Default ordering | **Uncommitted changes first** (git status changeset + untracked new files) → non-hidden dirs → hidden dirs (alphabetical within group) |
| Git-tracked filtering | `git ls-files -c` tracked files ∪ `-o --exclude-standard` untracked non-ignored files; new files appear automatically, build artifacts stay out |
| Deleted/renamed | Deleted files hidden automatically (`git ls-files -d`); renamed files (git mv) ranked as uncommitted changes |
| `.aiinclude` | gitignore syntax, re-includes ignored files/dirs (dir rules inherit to children; nested per-directory config supported) |
| Fallback mode | When git is unavailable / not a repo: falls back to `.gitignore` parsing + full scan |
| Caching | Client: shared per workspace **cwd** + **stale-while-revalidate** (30s TTL: old list shown instantly, background refresh — `@` never waits); Host: layered git cache (repo root 60s / tracked 15s / dirty, untracked & deleted 5s); warm prefetch on session creation |
| Pruned traversal | `.aiinclude` only walks dirs that may match (measured: 16ms for `doc/` vs 822ms full tree) |
| Safety bounds | 10,000 file cap, depth 32, heavy dirs skipped |

### Demo

Type `@` in the input box to open the workspace file menu: real-time basename/path filtering, uncommitted changes (including new files) ranked first; picking a file inserts `@relative/path` so the model can read it directly:

![@ file mention demo](docs/images/example.png)

> Screenshot above shows the menu in action; newly created (untracked) files are `@`-mentionable without `git add` (v0.1.10+).

## Installation

### Option 1: from npm (recommended)

```bash
dsh plugin --profile web add @hucj/dsh-file-mention
```

### Option 2: local path (development)

First **build** from source (`lib/` is the build output shipped with the package — after changing source you must rebuild before installing):

```bash
git clone git@github.com:StephenHu09/dsh-file-mention.git   # or use your existing source dir
cd dsh-file-mention
npm install        # dev deps only (for build/test; the artifacts themselves are zero-dep)
npm run check      # build (src/ → lib/) + 30 unit tests
```

Then install:

```bash
dsh plugin --profile web add file:D:/path/to/dsh-file-mention
```

A `file:` install is a **one-time copy** (not a symlink): later source changes do not propagate to the install dir — **rebuild and reinstall** (or manually sync `lib/`, `package.json`, `README.md`, `cordis.patch.yml`).

After installing, **restart dsh web** (new bundles load only at next host start), hard-refresh the browser (**Ctrl+F5**), type `@` in the input box — the `file` group appears = install OK.

> Note: `dsh.client.inject` is empty; the plugin declares a hard dependency on `inject: ['inputTriggers']`, so the host must include `@deepseek-ai/dsh-client-ui-input-trigger` (bundled by default in standard web deployments).

## Uninstall

```bash
dsh plugin --profile web remove @hucj/dsh-file-mention
```

This command automatically (verified):
1. Removes the dependency from `dependencies`
2. Removes the bundle row from `dsh.profile.bundles`
3. Deletes the `node_modules/@hucj/dsh-file-mention` install dir

Then **restart dsh web**. For a full cleanup you can also remove the `@hucj` dir under `node_modules` and pnpm cache manually.

## `.aiinclude` configuration

Create an `.aiinclude` file in the **workspace root** (syntax identical to `.gitignore`):

```gitignore
# Files ignored by .gitignore but needed via @
doc/
.superpowers/sdd/**
.vscode/settings.json
build/generated/**
```

| Syntax | Meaning | Example |
|--------|---------|---------|
| `#` | Comment | `# note` |
| `dir/` | Dir rule: all files below (incl. children) are included | `doc/` |
| `path/**` | Any depth under a dir | `.codebuddy/**` |
| `*.ext` | Basename match at any level | `*.log` |
| `!pattern` | Negation (last match wins) | `!doc/private/` |
| `/pattern` | Anchored to workspace root | `/build` |

Changes converge within **~90s** (Host rule cache 60s + client list 30s); refreshing the page speeds up the client part.

### Nested per-directory config

Subdirectories can carry their own `.aiinclude` (gitignore layering: rules are relative to that dir and **override** the root config):

```gitignore
# doc/.aiinclude — only affects doc/
!private/            # excludes doc/private (overrides root doc/ inheritance)
*.md                 # additionally includes any-depth .md under doc/
```

Nested rules are flattened to root-relative rules and merged with the root set (later wins; `!` negation participates too).
Limitations: discovery requires a **root `.aiinclude`** to exist; nested configs inside heavy dirs (`node_modules` etc.) are not read.

### Typical use cases

- Docs dir not committed (`.gitignore: doc/`) but AI needs it for reviews → `.aiinclude: doc/`
- Local helper artifacts not committed but AI needs to read them → `.aiinclude: .superpowers/**`
- Don't want `.aiinclude` itself committed → append `.aiinclude` to `.gitignore`

## Development

```bash
npm run build   # build src/ → lib/ (zero-dep, inline + syntax check)
npm test        # matcher unit tests (node:test, 35 cases)
npm run test:it # host integration tests (real git + real fs, dev-scenario simulation, 18 cases)
npm run check   # build + unit + integration (full gate before release)
```

### Directory layout

```
src/
  core.js     # gitignore/.aiinclude rule matcher core (pure functions, unit-testable)
  host.js     # Host half: git ls-files + .aiinclude scan (/file-mention/list HTTP route)
  client.js   # Client half: @ input-trigger source (inputTriggers)
scripts/
  build.mjs   # build: inline core into lib/index.js (ESM) and lib/client.js (__ModuleLoader__ wrap)
test/
  core.test.js
lib/          # build output (shipped with the package, ready to use)
docs/
  architecture.md   # architecture & design notes
```

> Maintenance rules (versioning, build invariants, sync checklist, commit conventions): see **[AGENTS.md](AGENTS.md)**.

## Architecture summary

```
Type @ in the browser input
  → inputTriggers fires the file source
  → POST /file-mention/list ({ sessionId })
  → Host: git ls-files (tracked ∪ untracked non-ignored) ∪ .aiinclude scan (re-included)
  → returns relative-path list → filter & display → pick inserts @path
  → model receives the path text and reads the file with its file tools
```

See [docs/architecture.md](docs/architecture.md) for details.

## License

[MIT](LICENSE) © 2026 hucj

---

Detailed docs: [docs/architecture.md](docs/architecture.md) (architecture) · [docs/recovery.md](docs/recovery.md) (recovery) · [AGENTS.md](AGENTS.md) (maintenance rules & publishing workflow)
