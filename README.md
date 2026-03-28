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

On **each device** separately:

1. Settings → **WebDAV Sync**.
2. **Server URL**: `http://<tailscale-ip>:8080` (get your Mac's Tailscale IP with `tailscale ip -4`).
3. **Username** and **Password**: same credentials you set in the Caddyfile.
4. **Excluded paths**: defaults are `.git/`, `_Attachments/`, `.obsidian/`. Add any other prefixes you don't want synced (e.g. `_Archive/`).
5. **Poll interval**: 10 seconds is the default. Increase it to reduce battery use on mobile (e.g. 30).
6. Click the **refresh icon** in the ribbon or wait for the first poll.

The status bar will show `WebDAV: Synced HH:MM:SS` when the first sync completes.

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

In **Settings → WebDAV Sync → Excluded paths**, one prefix per line. The match is a simple string prefix against the vault-relative path:

- `_Attachments/` matches `_Attachments/image.png` but not `Projects/_Attachments/image.png`.
- To exclude a folder everywhere, add it with the subfolder path explicitly.

The plugin also always excludes:
- `.sync-state.json`
- `.obsidian/plugins/obsidian-webdav-sync/` (its own data files)

---

## License

GPL-3.0-only. See [LICENSE](LICENSE).
