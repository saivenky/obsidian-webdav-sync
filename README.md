# WebDAV Sync for Obsidian

Sync your Obsidian vault with a self-hosted WebDAV server over Tailscale. No subscription, no third-party cloud, no npm runtime dependencies.

**Status:** Alpha — tested on Mac, iPad, Android.

---

## How it works

- A Caddy WebDAV server runs as a daemon on your Mac and serves your vault over HTTP on port 8080.
- Tailscale makes that port reachable on your phone and tablet without any port forwarding.
- This plugin talks to Caddy via raw `fetch()` using WebDAV verbs (PROPFIND, GET, PUT, DELETE).
- Conflicts are resolved automatically using a fuzzy section-merge algorithm (see [docs/architecture.md](docs/architecture.md)).

See [docs/architecture.md](docs/architecture.md) for internals.
See [docs/server-setup.md](docs/server-setup.md) for Caddy setup.

---

## Requirements

- macOS as the server (the vault must live here)
- Tailscale on every device (Mac, iPhone/iPad, Android)
- BRAT plugin on mobile devices for installation

**Alpha quality** — tested on Mac, iPad, Android. Back up your vault before relying on this. In exchange for no subscription fee, you maintain your own server and accept that conflict resolution is automatic but imperfect.

---

## Part 1 — Disable Obsidian Sync

Do this before installing the new plugin to avoid both sync systems running simultaneously.

### Step 1a — Disconnect the vault from Obsidian Sync

On **every device**:

1. Open Obsidian → **Settings** → **Core plugins**.
2. Find **Sync** and turn it **off**.
3. If the Sync plugin is still listed under **Core plugins → Sync**, open it and click **Disconnect** (if that option appears) before disabling.

On **Mac** (primary vault device):

1. Settings → **Sync** (if the core plugin was enabled).
2. Click the vault name under "Connected vault."
3. Click **Disconnect vault**.
4. Confirm. The vault files stay on disk — only the Obsidian Sync connection is removed.

### Step 1b — Cancel the Obsidian Sync subscription

1. Open Obsidian on any device.
2. Settings → **About** → scroll to **Commercial license** or **Sync subscription**.
3. Click **Manage subscription** (opens obsidian.md in your browser).
4. Log in, go to **Account → Subscriptions**, and cancel the Sync plan.

### Step 1c — Verify Sync is fully off

On each device, confirm:

- **Settings → Core plugins → Sync** is toggled **off**.
- The status bar shows no Obsidian Sync indicator (cloud icon with arrows).
- `.obsidian/sync.json` is absent from the vault root. If it exists:
  ```bash
  rm ~/obsidian/.obsidian/sync.json
  ```

---

## Part 2 — Set up the server (Mac)

Follow [docs/server-setup.md](docs/server-setup.md) in full, including the Phase 1b validation checklist. Do not skip the directory mtime propagation test — the plugin's performance depends on it.

At the end of server setup you should have:
- `~/bin/caddy-webdav` binary running
- `~/caddy/Caddyfile` with your username and bcrypt-hashed password
- `~/Library/LaunchAgents/com.yourname.caddy-webdav.plist` loaded and running
- A passing `curl` PROPFIND returning `207` from `http://$(tailscale ip -4):8080/`

---

## Part 3 — Install the plugin

### Mac (development install)

```bash
# Clone or locate the repo
cd ~/projects/obsidian-webdav-sync

# Install dev dependencies and do an initial build
npm install
npm run build

# Symlink into your vault's plugin directory
ln -s ~/projects/obsidian-webdav-sync \
  ~/obsidian/.obsidian/plugins/obsidian-webdav-sync
```

In Obsidian on Mac:

1. Settings → **Community plugins** → turn off **Restricted mode**.
2. Click **Reload plugins** (or restart Obsidian).
3. Find **WebDAV Sync** in the list and enable it.

For live reload during development:

```bash
npm run dev
```

### iPad / iPhone

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugin list.
2. Settings → **BRAT** → **Add beta plugin**.
3. Enter the GitHub repo URL for this plugin.
4. BRAT will download and install the latest release automatically.
5. Settings → **Community plugins** → enable **WebDAV Sync**.

### Android

Same as iPad — install BRAT, add this repo, enable the plugin.

---

## Part 4 — Configure the plugin

On **each device** separately, open Settings → **WebDAV Sync**.

The settings panel is divided into sections:

Use the **Pause / Resume** button at the top of the page to suspend all sync activity.

### Connection

- **Server URL**: `http://<tailscale-ip>:8080` (get your Mac's Tailscale IP with `tailscale ip -4`).
- **Username** and **Password**: same credentials you set in the Caddyfile.

### Sync

- **Poll interval (seconds)**: how often to check for remote changes while the app is visible. Default is 10. Increase to 30 on mobile to reduce battery use.
- **Request timeout (ms)**: time before a WebDAV request is abandoned. Default 8000.

### Excluded paths

A list of path patterns to skip during sync. Defaults are `.git/`, `_Attachments/`, `.obsidian/`. Hidden directories (dot-prefixed) are always excluded automatically.

- To add a rule: type in the text field and click **Add** (or press Enter).
- To remove a rule: click **×** next to it.

See [Excluding paths](#excluding-paths) below for pattern syntax.

### Danger zone

- **Reset sync state**: wipes the local sync baseline. The next sync will re-bootstrap all files from scratch with no conflict merges.
- **Clean up encoding artifacts**: deletes local files whose path contains `%` (URL-encoded duplicates from an old sync bug) and removes them from the remote too.

### Sync log

Collapsible section at the bottom of the settings page. Shows the last 50 log entries with **Sync now**, **Refresh**, and **Clear** buttons.

---

After configuring, sync starts automatically. The status bar shows `WebDAV: Synced HH:MM:SS` when the first cycle completes and `WebDAV: ↕ filename.md` while a file is transferring.

---

## Part 5 — Test the sync

Run through each scenario in order. For each one, wait up to the poll interval (default 10s) for the change to appear.

### 5a — New file: Mac → mobile

1. On Mac, create `_sync-test-1.md` in the vault root with some text.
2. On iPad/Android, wait for the poll. The file should appear.
3. Delete `_sync-test-1.md` on Mac. It should disappear on mobile.

### 5b — New file: mobile → Mac

1. On iPad, create `_sync-test-2.md`.
2. On Mac, wait for the poll. The file should appear.
3. Delete on iPad. Verify Mac copy is trashed.

### 5c — Edit propagation

1. Open `_sync-test-3.md` (create it first) on Mac and type a line.
2. Wait for sync. Open on iPad — the line should be there.
3. Edit the same line on iPad. Wait. Mac should show the updated version.

### 5d — Conflict merge

1. Take your Mac **offline** (disable Tailscale or `launchctl stop com.yourname.caddy-webdav`).
2. Edit a file on iPad — add a `## Mobile Edit` section.
3. Edit the same file on Mac — add a `## Mac Edit` section.
4. Bring Mac back online (start Caddy, re-enable Tailscale).
5. Wait for a sync cycle. The file should contain **both** sections.
6. Check `.obsidian/plugins/obsidian-webdav-sync/sync-log.txt` — you should see a `CONFLICT` entry.

### 5e — Mac offline graceful failure

1. Stop Caddy: `launchctl stop com.yourname.caddy-webdav`
2. On mobile, edit a file and wait for the poll interval.
3. The status bar should show `WebDAV: Error: ...` — not a crash, not data loss.
4. Restart Caddy: `launchctl start com.yourname.caddy-webdav`
5. The next poll should succeed and sync the change.

---

## Sync log

Stored at `.obsidian/plugins/obsidian-webdav-sync/sync-log.txt` (not in the vault root — excluded from graph and search). Capped at 1000 lines.

```
2026-03-27T22:15:00.000Z PULL Daily/2026-03-27.md
2026-03-27T22:16:01.000Z CONFLICT Projects/goals.md — merged
```

---

## Excluding paths

In **Settings → WebDAV Sync → Excluded paths**, add one rule per entry. Two pattern syntaxes are supported:

- `Folder/` — prefix match against the vault-relative path. Matches only that top-level folder.
  - `_Attachments/` matches `_Attachments/image.png` but **not** `Projects/_Attachments/image.png`.
- `**/name` — matches any folder named `name` anywhere in the tree.
  - `**/_Attachments` matches `_Attachments/`, `Projects/_Attachments/`, `Daily/2026/_Attachments/`, etc.

Hidden directories (any folder whose name starts with `.`) are always excluded automatically, regardless of what's in the list.

The plugin also always excludes its own data files:
- `.obsidian/plugins/obsidian-webdav-sync/` (settings, sync state, log)

---

## License

GPL-3.0-only. See [LICENSE](LICENSE).
