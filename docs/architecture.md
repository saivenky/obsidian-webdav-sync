# Architecture

## Overview

WebDAV Sync replaces Obsidian Sync with two components:

1. **Caddy WebDAV server** — runs as a macOS launchd daemon on your Mac, serves the vault directory over HTTP WebDAV on port 8080, reachable only via Tailscale.
2. **This plugin** — runs inside Obsidian on every device, pushes and pulls files via raw `fetch()` using WebDAV verbs (PROPFIND, GET, PUT, DELETE). No npm runtime dependencies.

```
 Mac (server + client)               iPad / Android (client only)
 ┌──────────────────────┐            ┌──────────────────────┐
 │ Obsidian + plugin    │            │ Obsidian + plugin    │
 │       ↕ vault API    │            │       ↕ vault API    │
 │ ~/obsidian/          │            │  <vault root>/       │
 │       ↕ loopback     │            │       ↕ Tailscale    │
 │ Caddy :8080          │◄──────────►│                      │
 └──────────────────────┘  WebDAV    └──────────────────────┘
         ↑
   Tailscale WireGuard
   (encrypted, LAN-speed)
```

---

## Sync Triggers

Sync runs are queued (never dropped, never concurrent):

| Trigger | When | What it scans |
|---|---|---|
| App open | `onLayoutReady` | Full PROPFIND |
| File save | `vault.on("modify")`, debounced 5s | Full PROPFIND |
| Foreground poll | Every N seconds while `document.visibilityState === "visible"` | Hierarchical PROPFIND |
| Manual | Ribbon icon or status bar click | Full PROPFIND |

Concurrency: a `syncing` boolean prevents overlapping runs. If a trigger fires while a sync is in progress, `pendingSync` is set to `true`; the engine runs one more cycle immediately after the current one completes.

---

## Hierarchical PROPFIND

Scanning every file on every poll would be expensive. Instead:

1. `PROPFIND /` with `Depth: 1` fetches only top-level entries (files + directories).
2. For each directory, compare its `getlastmodified` against the stored `dirMtime`.
3. Only recurse into directories whose mtime has changed.
4. Files in unchanged directories are assumed unchanged.

Cost when nothing has changed: one tiny XML request. This relies on macOS updating directory mtime when a child file is written — Caddy serves the filesystem directly so this propagates faithfully. See the Phase 1b validation checklist in `server-setup.md` to confirm this before relying on it.

---

## Sync State

Stored inside `data.json` (the standard Obsidian plugin data file, written via `plugin.saveData()`). Never committed to git — `data.json` is in `.gitignore`.

```json
{
  "settings": { ... },
  "syncState": {
    "version": 1,
    "files": {
      "Daily/2026-03-27.md": { "mtime": 1743091200000 },
      "Daily/2026-03-10.md": { "mtime": 0, "deleted": true, "deletedAt": 1743100000000 }
    },
    "dirs": {
      "Daily": 1743091200000
    }
  }
}
```

`mtime` values are Unix milliseconds, matching what `vault.adapter.stat()` and WebDAV `getlastmodified` (parsed via `Date.parse`) return.

Tombstones (`deleted: true`) are pruned after 30 days. This assumes all devices sync at least once per month — any device that goes more than 30 days offline may re-pull remotely deleted files.

---

## Per-file Decision Logic

For each path in the union of (remote file list) ∪ (sync state entries):

```
remote missing + state exists + no tombstone  →  deleted remotely  →  trash local
state is tombstone                             →  re-DELETE remote if still there
local missing + state exists + no tombstone   →  deleted locally   →  tombstone + DELETE remote
remote only, no state                         →  new on server     →  PULL + add to state
local only, no state                          →  new locally       →  PUSH + add to state
both exist, both mtimes == state.mtime        →  in sync           →  skip
remote newer, local unchanged                 →  PULL + update state
local newer, remote unchanged                 →  PUSH + update state
both changed since last sync                  →  CONFLICT          →  merge
```

---

## Exclusion Patterns

Before any per-file decision is made, the plugin checks each path against the configured exclusion list. Two pattern types are supported:

- **Prefix** (`Folder/`) — matches any path that starts with that string. Applies only at the top level.
- **Glob** (`**/name`) — matches any path component named `name` at any depth.

Hidden directories (any path segment starting with `.`) are always excluded regardless of the configured list. The plugin also unconditionally excludes its own data directory (`.obsidian/plugins/obsidian-webdav-sync/`).

---

## Conflict Resolution: Fuzzy Section Merge

When both the local and remote versions of a file have changed since the last synced mtime, the plugin merges them automatically without user intervention.

### Algorithm

1. **Parse** both versions into sections: YAML frontmatter block, then each `## Heading` + its content.

2. **Match sections** across the two versions:
   - Pass 1: exact header string match.
   - Pass 2: Jaccard similarity of body words (lowercased, >3 chars) ≥ 0.6, with a positional tiebreaker. Sections under 30 words are skipped for fuzzy matching.

3. **Merge matched pairs:**
   - Similarity ≥ 0.6 → keep the newer mtime's version of that section.
   - Similarity < 0.6 → both versions kept (newer first).

4. **Unmatched sections** (exist in only one version) → included as-is.

5. **Document order** follows the newer file's section sequence. Unmatched sections from the older file are inserted after their nearest matched predecessor.

6. **Frontmatter special case:** if similarity < 0.6, union of lines from both blocks (deduplicated, newer first) wrapped in `---`.

### Trade-offs

- **No base version required.** No server-side storage, no extra round trips.
- **Flat notes** (no `##` headers) degrade to "newer mtime wins for the whole body" — acceptable for a single-user PKM.
- **`###` nesting** is bundled into the parent `##` section; mtime wins at `##` granularity.
- **Git is the backstop.** The vault is in a private git repo. Any merge the plugin gets wrong can be reverted via `git checkout`.

---

## Credentials Storage

Credentials (server URL, username, password) are stored in `.obsidian/plugins/obsidian-webdav-sync/data.json`, which is:
- Listed in `.gitignore` — never committed.
- Excluded from WebDAV sync (the plugin explicitly skips `.obsidian/plugins/obsidian-webdav-sync/`).
- Protected by Tailscale — never transmitted over a public network.

Each device configures its own copy of the settings after installing the plugin.

---

## Sync Log

Written to `.obsidian/plugins/obsidian-webdav-sync/sync-log.txt`. Not in the vault root — keeps it out of Obsidian's graph and search index. Capped at 1000 lines. Format:

```
2026-03-27T22:15:00.000Z PULL Daily/2026-03-27.md
2026-03-27T22:16:01.000Z CONFLICT Projects/goals.md — merged
2026-03-27T22:16:01.000Z ERROR Request timed out: /Daily/2026-03-27.md
```

Entry types: `PULL`, `PUSH`, `LOCAL-DELETE`, `REMOTE-DELETE`, `CONFLICT`, `ERROR`.
