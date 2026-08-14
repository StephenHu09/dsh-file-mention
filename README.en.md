# @hucj/dsh-file-mention

English | [中文](README.md)

A **`@` workspace file mention** plugin for the DSH (DeepSeek Harness) Web GUI: type `@` in the chat input, filter workspace files in real time, pick one, and it inserts `@relative/path` — the model can then read the file directly. The same `@file` reference experience as Codex CLI / Claude Code CLI.

> npm package `@hucj/dsh-file-mention` (personal scoped package); plugin composition row id: `file-mention`.

- **Git-tracked files only**: natively respects `.gitignore` — build artifacts and untracked files are excluded automatically
- **`.aiinclude` re-inclusion**: files that are ignored/untracked but needed by AI (e.g. project docs) can be explicitly added back to the scan scope
- **Zero external dependencies**: both Host and Client halves are hand-written code with a hand-written build script

## Features

| Feature | Description |
|---------|-------------|
| `@` input trigger | Same `inputTriggers` mechanism as the `/` skill menu, `@pluginId`, `@subagent` — multiple sources coexist |
| Real-time filter | Matches basename or full path (case-insensitive), up to 100 results shown |
| Match ranking | **Exact match** (path/basename equal) → **prefix match** → substring match (within group: changed-first, then alphabetical) |
| Default ordering | **Uncommitted changes first** (git status: staged/unstaged/deleted/untracked) → non-hidden dirs → hidden dirs (alphabetical within group) |
| Git-tracked filtering | Via `git ls-files`; automatically skips `.gitignore`-ignored items, build artifacts, untracked files |
| `.aiinclude` | gitignore syntax, re-includes ignored files/dirs (dir rules inherit to children; nested per-directory config supported) |
| Fallback mode | When git is unavailable / not a repo: falls back to `.gitignore` parsing + full scan |
| Caching | Client: shared per workspace **cwd** + **stale-while-revalidate** (30s TTL: old list shown instantly, background refresh — `@` never waits); Host: layered git cache (repo root 60s / tracked 15s / dirty 5s); warm prefetch on session creation |
| Pruned traversal | `.aiinclude` only walks dirs that may match (measured: 16ms for `doc/` vs 822ms full tree) |
| Safety bounds | 10,000 file cap, depth 32, heavy dirs skipped |

## Installation

### Option 1: from npm (recommended, after publish)

```bash
dsh plugin --profile web add @hucj/dsh-file-mention
```

> ⚠️ Not yet published to the npm registry (`npm view @hucj/dsh-file-mention` currently returns 404);
> once published this option works — for now use Option 2.

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
npm test        # matcher unit tests (node:test)
npm run check   # build + test
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
  → Host: git ls-files (tracked) ∪ .aiinclude scan (re-included)
  → returns relative-path list → filter & display → pick inserts @path
  → model receives the path text and reads the file with its file tools
```

See [docs/architecture.md](docs/architecture.md) for details.

## Publishing

### GitHub (repo already has full history — just push)

```bash
git remote add origin git@github.com:StephenHu09/dsh-file-mention.git
git branch -M main
git push -u origin main
git tag v0.1.8 && git push origin v0.1.8
```

### npm

```bash
npm login                  # first time: register at npmjs.com and enable 2FA
npm publish                # publish current version (versioning policy: see AGENTS.md)
npm view @hucj/dsh-file-mention   # verify

# Update: bump version → npm run check → npm publish
# Unpublish (within 72h): npm unpublish @hucj/dsh-file-mention@<version> --force
# Deprecate instead (recommended over unpublish): npm deprecate @hucj/dsh-file-mention@<version> "note"
```

## Known limitations

- Path only, no content attached: the model reads the file by path (unlike Claude Code attaching content directly)
- Nested `.aiinclude` discovery requires a root config; nested configs inside heavy dirs are not read
- Host rule cache 60s, git result cache 5–60s (layered), client list 30s (SWR shows stale first) — config edits converge within ~90s
- Git-tracked filtering depends on local git; without git, fallback mode includes untracked non-ignored files
- Cold start (first request) includes a full nested-discovery scan, ~1–2s; after warm prefetch it's effectively zero-wait

## Recovery: what if the plugin breaks dsh web startup

`dsh web` composes the profile config and runs each plugin's `apply()` at startup; if any plugin throws during boot, the whole startup fails.
Recovery idea: **keep the broken plugin out of the composition before starting** (config files are editable anytime — dsh doesn't need to be running).

Three approaches (fastest → most thorough):

1. **Temporarily disable (fastest, no config change)**: `dsh web --patch disable.yml`, where:
   ```yaml
   - id: file-mention    # the broken plugin's composition row id (see the startup error)
     disabled: true
   ```
2. **Permanently remove (preferred)**: edit `~/.dsh/profiles/web/package.json`, delete the package row from `dsh.profile.bundles`, restart
3. **Full cleanup**: `dsh plugin --profile web remove @hucj/dsh-file-mention`

Full tutorial (principles, verification, FAQ, dynamic-plugin comparison): **[docs/recovery.md](docs/recovery.md)**

> Tip: dynamic plugins (cordis_define/run) are injected at runtime and never touch the profile config — on failure just `cordis_undefine`; they can never break dsh startup.

## License

[MIT](LICENSE) © 2026 hucj
