# Server Setup: Caddy WebDAV on macOS

The plugin talks to a self-hosted WebDAV server running on your Mac and reachable via Tailscale. This document covers building the server binary, writing the config, and wiring it up as a persistent daemon.

---

## Prerequisites

- macOS (tested on Sequoia)
- [Tailscale](https://tailscale.com) installed and logged in on all devices
- [Go](https://go.dev/dl/) installed (`brew install go` if needed)
- `xcaddy` for building Caddy with the WebDAV module

---

## Step 1 — Build xcaddy and the custom Caddy binary

Standard Caddy does not ship with WebDAV. You need to build a custom binary using `xcaddy`.

```bash
# Install xcaddy
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest

# Build Caddy with WebDAV support
cd ~/projects
xcaddy build --with github.com/mholt/caddy-webdav --output ~/bin/caddy-webdav
```

Verify it built correctly:

```bash
~/bin/caddy-webdav version
~/bin/caddy-webdav list-modules | grep webdav
```

---

## Step 2 — Write the Caddyfile

Create `~/caddy/Caddyfile`:

```
:8080 {
    basicauth {
        YOUR_USERNAME YOUR_BCRYPT_HASH
    }
    root * /Users/YOUR_USERNAME/obsidian
    webdav
}
```

Generate a bcrypt hash for your password:

```bash
~/bin/caddy-webdav hash-password --plaintext 'your-password-here'
```

Replace `YOUR_USERNAME` with your macOS username and `YOUR_BCRYPT_HASH` with the output of the hash command.

**Security note:** Caddy serves only on `:8080` with no public exposure. Tailscale's WireGuard tunnel encrypts traffic in transit, so HTTP (not HTTPS) is acceptable here. Do not open port 8080 in your router — keep it Tailscale-only.

---

## Step 3 — Test the server manually

```bash
# Start Caddy interactively to verify config
~/bin/caddy-webdav run --config ~/caddy/Caddyfile
```

In another terminal, run the Phase 1b validation checklist:

```bash
export DAV_URL="http://$(tailscale ip -4):8080"
export DAV_AUTH="-u YOUR_USERNAME:YOUR_PASSWORD"

# Auth check — expect 401
curl -s -o /dev/null -w "%{http_code}" http://$(tailscale ip -4):8080/

# Authenticated PROPFIND — expect 207
curl -s -X PROPFIND $DAV_AUTH \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  --data '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/><D:resourcetype/></D:prop></D:propfind>' \
  "$DAV_URL/" | head -40

# Upload a test file — expect 201 or 204
curl -s -X PUT $DAV_AUTH \
  -H "Content-Type: text/plain" \
  --data "hello from curl" \
  "$DAV_URL/test-webdav.md"

# Verify it landed on disk
cat ~/obsidian/test-webdav.md

# Delete it — expect 204
curl -s -X DELETE $DAV_AUTH "$DAV_URL/test-webdav.md"

# CRITICAL: directory mtime propagation test
# Record Daily/ mtime
curl -s -X PROPFIND $DAV_AUTH \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  --data '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/></D:prop></D:propfind>' \
  "$DAV_URL/" | grep -A2 "Daily"

# Write a file into Daily/
curl -s -X PUT $DAV_AUTH \
  -H "Content-Type: text/plain" \
  --data "mtime test" \
  "$DAV_URL/Daily/mtime-test.md"

# Re-check Daily/ mtime — it must have changed
curl -s -X PROPFIND $DAV_AUTH \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  --data '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/></D:prop></D:propfind>' \
  "$DAV_URL/" | grep -A2 "Daily"

# Clean up
curl -s -X DELETE $DAV_AUTH "$DAV_URL/Daily/mtime-test.md"
```

If directory mtime does **not** update after a child write, the hierarchical PROPFIND optimization will not work. In that case, open an issue — the fallback is a full `Depth:infinity` scan on every poll.

---

## Step 4 — Install as a launchd daemon

Create `~/Library/LaunchAgents/com.yourname.caddy-webdav.plist` (replace `yourname` with any identifier you choose — it just needs to be unique on your machine):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourname.caddy-webdav</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/bin/caddy-webdav</string>
        <string>run</string>
        <string>--config</string>
        <string>/Users/YOUR_USERNAME/caddy/Caddyfile</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/caddy/caddy.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/caddy/caddy-error.log</string>
</dict>
</plist>
```

Replace `YOUR_USERNAME` with your macOS username.

Load and start the daemon:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.caddy-webdav.plist
launchctl start com.yourname.caddy-webdav
```

Verify it's running:

```bash
launchctl list | grep caddy
# Should show a PID (non-zero) in the first column

curl -s -o /dev/null -w "%{http_code}" -u YOUR_USERNAME:YOUR_PASSWORD \
  -X PROPFIND http://localhost:8080/
# Should return 207
```

To stop or restart:

```bash
launchctl stop com.yourname.caddy-webdav
launchctl start com.yourname.caddy-webdav
```

To unload permanently (e.g. during testing):

```bash
launchctl unload ~/Library/LaunchAgents/com.yourname.caddy-webdav.plist
```

---

## Step 5 — Find your Tailscale IP

```bash
tailscale ip -4
# e.g. 100.x.x.x
```

This is the IP you will enter as the Server URL in the plugin settings on all devices. It is stable as long as your Tailscale account is connected.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `curl` returns connection refused | `launchctl list \| grep caddy` — is it running? Check `caddy-error.log` |
| `401` from authenticated request | Re-generate bcrypt hash — bcrypt is sensitive to trailing whitespace |
| Mobile can't reach server | Open Tailscale on both devices; check `tailscale status` on Mac |
| Directory mtime not updating | macOS updates directory mtime; verify `stat ~/obsidian/Daily` before/after a write |
