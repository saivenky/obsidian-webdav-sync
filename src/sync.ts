import { TFile, normalizePath } from "obsidian";
import type WebDAVSyncPlugin from "main";
import { WebDAVClient, PropfindEntry } from "webdav";
import { SyncStateManager } from "sync-state";
import { mergeConflict } from "conflict";
import type { WebDAVSyncSettings } from "settings";

const LOG_MAX_LINES = 1000;
const LOG_PATH = ".obsidian/plugins/obsidian-webdav-sync/sync-log.txt";

export class SyncEngine {
	stateManager: SyncStateManager;
	suppressNextModifyTrigger = false;

	private client: WebDAVClient;
	private syncing = false;
	private pendingSync = false;
	private currentRemoteFiles: Map<string, PropfindEntry> = new Map();

	constructor(
		private plugin: WebDAVSyncPlugin
	) {
		this.stateManager = new SyncStateManager(plugin);
		this.client = this.buildClient();
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

	async init(): Promise<void> {
		await this.stateManager.load();
	}

	setStatus(text: string): void {
		this.plugin.statusBarItem?.setText("WebDAV: " + text);
	}

	async requestSync(): Promise<void> {
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

		// Recursively scan dirs whose mtime changed
		for (const dir of dirsToScan) {
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
		this.setStatus("Synced " + new Date().toLocaleTimeString());
	}

	private async scanDir(dirPath: string): Promise<void> {
		const entries = await this.client.propfind(dirPath, "1");
		for (const entry of entries) {
			if (entry.path === dirPath) continue; // dir itself
			if (entry.isDir) {
				this.stateManager.setDirMtime(entry.path, entry.mtime);
				await this.scanDir(entry.path);
			} else {
				this.currentRemoteFiles.set(entry.path, entry);
			}
		}
	}

	private async decideFile(path: string): Promise<void> {
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
			this.stateManager.setFile(path, { mtime: remoteMtime! });
			this.log("PULL " + path);
			return;
		}

		// Case 5: Local only, no state, no remote → new locally → push
		if (localMtime !== null && !stateEntry && !remote) {
			const content = await this.plugin.app.vault.adapter.read(normalizePath(path));
			await this.ensureParentDirs(path);
			await this.client.put(path, content);
			this.stateManager.setFile(path, { mtime: localMtime });
			this.log("PUSH " + path);
			return;
		}

		// Case 6: In sync — skip
		if (
			localMtime !== null &&
			remoteMtime !== null &&
			localMtime === stateEntry?.mtime &&
			remoteMtime === stateEntry?.mtime
		) {
			return;
		}

		// Case 7: Remote newer, local unchanged → pull
		if (
			remoteMtime !== null &&
			remoteMtime > (stateEntry?.mtime ?? 0) &&
			localMtime === stateEntry?.mtime
		) {
			const content = await this.client.get(path);
			const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
			if (file instanceof TFile) {
				this.suppressNextModifyTrigger = true;
				await this.plugin.app.vault.modify(file, content);
			}
			this.stateManager.setFile(path, { mtime: remoteMtime });
			this.log("PULL " + path);
			return;
		}

		// Case 8: Local newer, remote unchanged → push
		if (
			localMtime !== null &&
			localMtime > (stateEntry?.mtime ?? 0) &&
			remoteMtime === stateEntry?.mtime
		) {
			const content = await this.plugin.app.vault.adapter.read(normalizePath(path));
			await this.client.put(path, content);
			this.stateManager.setFile(path, { mtime: localMtime });
			this.log("PUSH " + path);
			return;
		}

		// Case 9: Both changed → conflict
		if (
			localMtime !== null &&
			remoteMtime !== null &&
			localMtime > (stateEntry?.mtime ?? 0) &&
			remoteMtime > (stateEntry?.mtime ?? 0)
		) {
			await this.conflict(path, localMtime, remoteMtime);
		}
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
		this.stateManager.setFile(path, { mtime: Date.now() });
		this.log("CONFLICT " + path + " — merged");
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

	private isExcluded(path: string): boolean {
		if (
			path === ".sync-state.json" ||
			path.startsWith(".obsidian/plugins/obsidian-webdav-sync/")
		) {
			return true;
		}
		return this.settings.excludedPaths.some(p => path.startsWith(p));
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
