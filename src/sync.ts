import { TFile, normalizePath, FileSystemAdapter } from "obsidian";
import type WebDAVSyncPlugin from "main";
import { WebDAVClient, PropfindEntry } from "webdav";
import { SyncStateManager } from "sync-state";
import { mergeConflict } from "conflict";
import type { WebDAVSyncSettings } from "settings";
import { isSymlink } from "symlink";

const LOG_MAX_LINES = 50000;
const LOG_PATH = ".obsidian/plugins/obsidian-webdav-sync/sync-log.txt";

const ALLOWED_EXTENSIONS = new Set([
	".md", ".canvas", ".css", ".js", ".json", ".txt", ".yaml", ".yml",
]);

export class SyncEngine {
	stateManager: SyncStateManager;
	suppressNextModifyTrigger = false;

	private cycleCount = 0;
	private client: WebDAVClient;
	private syncing = false;
	private pendingSync = false;
	private currentRemoteFiles: Map<string, PropfindEntry> = new Map();

	constructor(
		private plugin: WebDAVSyncPlugin,
		clientOverride?: WebDAVClient
	) {
		this.stateManager = new SyncStateManager(plugin);
		this.client = clientOverride ?? this.buildClient();
	}

	private get settings(): WebDAVSyncSettings {
		return this.plugin.settings;
	}

	private buildClient(): WebDAVClient {
		return new WebDAVClient(
			this.settings.serverUrl,
			this.settings.username,
			this.settings.password,
			this.settings.requestTimeoutMs
		);
	}

	rebuildClient(): void {
		this.client = this.buildClient();
	}

	async resetState(): Promise<void> {
		// Cancel any queued sync and wait for a running sync to finish before
		// resetting. Without this, runSync()'s final stateManager.save() (line ~119)
		// would overwrite the empty state written here, silently undoing the reset.
		this.pendingSync = false;
		while (this.syncing) {
			await new Promise<void>(r => setTimeout(r, 100));
		}
		this.stateManager.reset();
		await this.stateManager.save();
	}

	async init(): Promise<void> {
		await this.stateManager.load();
	}

	setStatus(text: string): void {
		this.plugin.statusBarItem?.setText("WebDAV: " + text);
	}

	async requestSyncFile(path: string): Promise<void> {
		if (this.syncing) return; // full sync already in progress — it will cover this file
		this.syncing = true;
		try {
			if (!this.settings.serverUrl) {
				this.setStatus("No server configured");
				return;
			}
			this.setStatus("Syncing…");
			// Fetch just this file's remote state
			this.currentRemoteFiles = new Map();
			try {
				const entries = await this.client.propfind(path, "0");
				for (const entry of entries) {
					if (!entry.isDir) this.currentRemoteFiles.set(entry.path, entry);
				}
			} catch {
				// file absent on server — currentRemoteFiles stays empty for this path
			}
			await this.decideFile(path);
			await this.stateManager.save();
			this.setStatus("Synced " + new Date().toLocaleTimeString());
		} catch (e) {
			const msg = (e as Error).message ?? String(e);
			this.setStatus("Error: " + msg);
			this.log("ERROR " + msg);
		} finally {
			this.syncing = false;
			if (this.pendingSync) {
				this.pendingSync = false;
				this.requestSync();
			}
		}
	}

	async requestSync(force = false): Promise<void> {
		// Check paused first: debounce timers and pendingSync fire requestSync()
		// directly (bypassing the paused guard in the vault.on("modify") handler),
		// so a stale debounce from a conflict storm would relaunch a sync even after
		// the user paused — perpetuating the storm.
		if (!force && this.plugin.paused) return;
		if (this.syncing) {
			this.pendingSync = true;
			return;
		}
		this.syncing = true;
		try {
			await this.runSync();
		} catch (e) {
			const msg = (e as Error).message ?? String(e);
			this.setStatus("Error: " + msg);
			this.log("ERROR " + msg);
		} finally {
			this.syncing = false;
			if (this.pendingSync) {
				this.pendingSync = false;
				this.requestSync();
			}
		}
	}

	private async runSync(): Promise<void> {
		if (!this.settings.serverUrl) {
			this.setStatus("No server configured");
			return;
		}

		this.cycleCount++;
		const cycle = this.cycleCount;
		this.log(`CYCLE-START #${cycle} state-entries=${this.stateManager.entries().length}`);
		this.setStatus("Syncing…");
		this.currentRemoteFiles = new Map();

		// PROPFIND root depth:1 to get top-level entries
		const topEntries = await this.client.propfind("/", "1");

		// Separate dirs and files at root level
		const dirsToScan: PropfindEntry[] = [];
		for (const entry of topEntries) {
			if (entry.path === "" || entry.path === "/") continue; // root itself
			if (entry.isDir) {
				dirsToScan.push(entry);
			} else {
				this.currentRemoteFiles.set(entry.path, entry);
			}
		}

		// Recursively scan dirs whose mtime changed (skip excluded dirs entirely)
		for (const dir of dirsToScan) {
			if (this.isDirExcluded(dir.path)) continue;
			this.stateManager.setDirMtime(dir.path, dir.mtime);
			await this.scanDir(dir.path);
		}

		// Union of all paths to consider
		const allPaths = new Set<string>([
			...this.currentRemoteFiles.keys(),
			...this.stateManager.entries().map(([p]) => p),
		]);

		for (const path of allPaths) {
			if (this.isExcluded(path)) continue;
			await this.decideFile(path);
		}

		await this.stateManager.save();
		this.log(`CYCLE-END #${cycle} state-entries=${this.stateManager.entries().length} saved`);
		this.setStatus("Synced " + new Date().toLocaleTimeString());
	}

	private async scanDir(dirPath: string): Promise<void> {
		const entries = await this.client.propfind(dirPath, "1");
		for (const entry of entries) {
			if (entry.path === dirPath) continue; // dir itself
			if (entry.isDir) {
				if (this.isDirExcluded(entry.path)) continue;
				this.stateManager.setDirMtime(entry.path, entry.mtime);
				await this.scanDir(entry.path);
			} else {
				this.currentRemoteFiles.set(entry.path, entry);
			}
		}
	}

	private async decideFile(path: string): Promise<void> {
		// Skip symlinks: writing through one path would modify another path's inode,
		// causing both to appear changed on every cycle → infinite conflict loop.
		if (this.plugin.app.vault.adapter instanceof FileSystemAdapter) {
			const absPath = this.plugin.app.vault.adapter.getFullPath(normalizePath(path));
			if (isSymlink(absPath)) return;
		}

		const remote = this.currentRemoteFiles.get(path);
		const stateEntry = this.stateManager.getFile(path);
		const localStat = await this.plugin.app.vault.adapter.stat(normalizePath(path));
		const localMtime = localStat?.mtime ?? null;
		const remoteMtime = remote?.mtime ?? null;

		// Case 1: Remote missing, state exists, NOT a tombstone → deleted remotely → trash local
		if (!remote && stateEntry && !stateEntry.deleted) {
			const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
			if (file instanceof TFile) {
				await this.plugin.app.vault.trash(file, true);
			}
			this.stateManager.deleteEntry(path);
			this.log("REMOTE-DELETE " + path);
			return;
		}

		// Case 2: Tombstone — ensure remote is gone
		if (stateEntry?.deleted) {
			if (remote) {
				await this.client.delete(path);
			}
			return;
		}

		// Case 3: Local missing, state exists → deleted locally → propagate
		if (localMtime === null && stateEntry && !stateEntry.deleted) {
			this.stateManager.setTombstone(path);
			if (remote) await this.client.delete(path);
			this.log("LOCAL-DELETE " + path);
			return;
		}

		// Case 4: Remote only, no state, no local → new on server → pull
		if (remote && !stateEntry && localMtime === null) {
			const content = await this.client.get(path);
			await this.ensureParentDirs(path);
			await this.plugin.app.vault.create(normalizePath(path), content);
			// Re-stat after create: vault.create() causes the OS to assign its own mtime,
			// which differs from remoteMtime. Storing remoteMtime would make local look
			// changed on the next cycle, triggering a spurious PUSH.
			const afterStat4 = await this.plugin.app.vault.adapter.stat(normalizePath(path));
			const mtime4 = afterStat4 ? Math.max(afterStat4.mtime, remoteMtime!) : remoteMtime!;
			this.stateManager.setFile(path, { mtime: mtime4 });
			this.log(`PULL-NEW ${path} remote=${remoteMtime} after=${afterStat4?.mtime} →state=${mtime4}`);
			return;
		}

		// Case 5: Local only, no state, no remote → new locally → push
		if (localMtime !== null && !stateEntry && !remote) {
			const content = await this.plugin.app.vault.adapter.read(normalizePath(path));
			await this.ensureParentDirs(path);
			await this.client.put(path, content);
			// Re-stat: on same-filesystem WebDAV servers, client.put() writes to the
			// same inode, bumping local mtime to current wall clock. Storing the
			// pre-PUT localMtime would make local look changed on the next cycle.
			const afterStat5 = await this.plugin.app.vault.adapter.stat(normalizePath(path));
			const mtime5 = afterStat5 ? afterStat5.mtime : localMtime;
			this.stateManager.setFile(path, { mtime: mtime5 });
			this.log(`PUSH-NEW ${path} local=${localMtime} after=${afterStat5?.mtime} →state=${mtime5}`);
			return;
		}

		// Case 5.5: Both exist, no state → bootstrap. Never conflict-merge without a baseline.
		// Equal mtimes (same file on Mac) → just record. One newer → take it.
		if (remote && !stateEntry && localMtime !== null && remoteMtime !== null) {
			if (localMtime === remoteMtime) {
				this.stateManager.setFile(path, { mtime: localMtime });
				this.log(`SKIP-BOOT-EQUAL ${path} mtime=${localMtime}`);
				return;
			}
			if (remoteMtime > localMtime) {
				const content = await this.client.get(path);
				const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
				if (file instanceof TFile) {
					this.suppressNextModifyTrigger = true;
					await this.plugin.app.vault.modify(file, content);
				}
				const afterStat55 = await this.plugin.app.vault.adapter.stat(normalizePath(path));
				const mtime55 = afterStat55 ? Math.max(afterStat55.mtime, remoteMtime) : remoteMtime;
				this.stateManager.setFile(path, { mtime: mtime55 });
				this.log(`PULL-BOOT ${path} local=${localMtime} remote=${remoteMtime} after=${afterStat55?.mtime} →state=${mtime55}`);
			} else {
				const content = await this.plugin.app.vault.adapter.read(normalizePath(path));
				await this.client.put(path, content);
				const afterStat55p = await this.plugin.app.vault.adapter.stat(normalizePath(path));
				const mtime55p = afterStat55p ? afterStat55p.mtime : localMtime;
				this.stateManager.setFile(path, { mtime: mtime55p });
				this.log(`PUSH-BOOT ${path} local=${localMtime} remote=${remoteMtime} after=${afterStat55p?.mtime} →state=${mtime55p}`);
			}
			return;
		}

		// Case 6: Neither side changed since last sync — skip.
		// Use <= instead of === to tolerate server second-precision truncation
		// (remote may be up to 999ms less than state after a PUSH) and the case
		// where Math.max stored a state higher than remoteMtime after a PULL.
		if (
			localMtime !== null &&
			remoteMtime !== null &&
			localMtime <= (stateEntry?.mtime ?? -1) &&
			remoteMtime <= (stateEntry?.mtime ?? -1)
		) {
			return;
		}

		// Case 7: Remote newer, local unchanged → pull
		// Use <= for local: handles case where Math.max stored state > afterStat.
		if (
			remoteMtime !== null &&
			remoteMtime > (stateEntry?.mtime ?? 0) &&
			localMtime !== null &&
			localMtime <= (stateEntry?.mtime ?? 0)
		) {
			const content = await this.client.get(path);
			const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
			if (file instanceof TFile) {
				this.suppressNextModifyTrigger = true;
				await this.plugin.app.vault.modify(file, content);
			}
			// Re-stat after modify: vault.modify() causes the OS to assign its own mtime,
			// which is later than remoteMtime. Storing remoteMtime alone would make local
			// look changed on the next cycle, triggering a spurious Case 8 PUSH.
			// Math.max ensures neither side exceeds the baseline on the next comparison.
			const afterStat7 = await this.plugin.app.vault.adapter.stat(normalizePath(path));
			const mtime7 = afterStat7 ? Math.max(afterStat7.mtime, remoteMtime) : remoteMtime;
			this.stateManager.setFile(path, { mtime: mtime7 });
			this.log(`PULL ${path} remote=${remoteMtime} after=${afterStat7?.mtime} →state=${mtime7}`);
			return;
		}

		// Case 8: Local newer, remote unchanged → push
		// Use <= for remote: handles case where Math.max stored state > remoteMtime after a PULL.
		if (
			localMtime !== null &&
			localMtime > (stateEntry?.mtime ?? 0) &&
			remoteMtime !== null &&
			remoteMtime <= (stateEntry?.mtime ?? 0)
		) {
			const content = await this.plugin.app.vault.adapter.read(normalizePath(path));
			await this.client.put(path, content);
			const afterStat8 = await this.plugin.app.vault.adapter.stat(normalizePath(path));
			const mtime8 = afterStat8 ? afterStat8.mtime : localMtime;
			this.stateManager.setFile(path, { mtime: mtime8 });
			this.log(`PUSH ${path} local=${localMtime} remote=${remoteMtime} state=${stateEntry?.mtime} after=${afterStat8?.mtime} →state=${mtime8}`);
			return;
		}

		// Case 9: Both changed → conflict
		if (
			localMtime !== null &&
			remoteMtime !== null &&
			localMtime > (stateEntry?.mtime ?? 0) &&
			remoteMtime > (stateEntry?.mtime ?? 0)
		) {
			this.log(`CONFLICT-DIAG ${path} local=${localMtime} remote=${remoteMtime} state=${stateEntry?.mtime ?? 0}`);
			await this.conflict(path, localMtime, remoteMtime);
			return;
		}

		this.log(`SKIP-UNMATCHED ${path} local=${localMtime} remote=${remoteMtime} state=${stateEntry?.mtime}`);
	}

	private async conflict(path: string, localMtime: number, remoteMtime: number): Promise<void> {
		const localContent = await this.plugin.app.vault.adapter.read(normalizePath(path));
		const remoteContent = await this.client.get(path);
		const merged = mergeConflict(localContent, remoteContent, localMtime, remoteMtime);

		const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) {
			this.suppressNextModifyTrigger = true;
			await this.plugin.app.vault.modify(file, merged);
		}
		await this.client.put(path, merged);
		// Re-stat after vault.modify() to get the actual OS-assigned mtime.
		// Date.now() at call-site is captured before the async write completes and
		// will exceed both the local OS mtime and the server mtime, causing both sides
		// to look older than the baseline on the next sync → the file is permanently
		// frozen (neither Case 7 nor Case 8 fires, since both require mtime > baseline).
		const afterStat = await this.plugin.app.vault.adapter.stat(normalizePath(path));
		const mtimeConflict = afterStat ? afterStat.mtime : remoteMtime;
		this.stateManager.setFile(path, { mtime: mtimeConflict });
		this.log(`CONFLICT ${path} after=${afterStat?.mtime} →state=${mtimeConflict} — merged`);
	}

	private async ensureParentDirs(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dirPath = parts.slice(0, i).join("/");
			if (!dirPath) continue;
			const exists = await this.plugin.app.vault.adapter.exists(normalizePath(dirPath));
			if (!exists) {
				await this.plugin.app.vault.adapter.mkdir(normalizePath(dirPath));
			}
		}
	}

	private isDirExcluded(dirPath: string): boolean {
		// Skip directories that are .git components
		if (dirPath.split("/").some(part => part === ".git")) return true;
		// Skip directories matched by an excluded prefix
		return this.settings.excludedPaths.some(p => dirPath.startsWith(p) || (p.endsWith("/") && dirPath + "/" === p));
	}

	private isExcluded(path: string): boolean {
		if (
			path === ".sync-state.json" ||
			path.startsWith(".obsidian/plugins/obsidian-webdav-sync/")
		) {
			return true;
		}

		// Exclude any path containing a .git directory component
		if (path.split("/").some(part => part === ".git")) return true;

		// Exclude by configured prefix rules
		if (this.settings.excludedPaths.some(p => path.startsWith(p))) return true;

		// Only sync known text-safe file types
		const dot = path.lastIndexOf(".");
		const ext = dot !== -1 ? path.slice(dot).toLowerCase() : "";
		if (ext && !ALLOWED_EXTENSIONS.has(ext)) return true;

		return false;
	}

	private async log(entry: string): Promise<void> {
		const timestamp = new Date().toISOString();
		const line = timestamp + " " + entry;

		let existing = "";
		try {
			existing = await this.plugin.app.vault.adapter.read(LOG_PATH);
		} catch {
			// file doesn't exist yet
		}

		const lines = existing.length > 0 ? existing.split("\n") : [];
		lines.push(line);

		// Cap at LOG_MAX_LINES
		const trimmed = lines.length > LOG_MAX_LINES
			? lines.slice(lines.length - LOG_MAX_LINES)
			: lines;

		await this.plugin.app.vault.adapter.write(LOG_PATH, trimmed.join("\n"));
	}
}
