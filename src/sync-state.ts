import type WebDAVSyncPlugin from "main";

export interface FileState {
	mtime: number;
	deleted?: true;
	deletedAt?: number;
}

interface SyncState {
	version: 1;
	files: Record<string, FileState>;
	dirs: Record<string, number>;
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function emptyState(): SyncState {
	return { version: 1, files: {}, dirs: {} };
}

export class SyncStateManager {
	private state: SyncState = emptyState();

	constructor(private plugin: WebDAVSyncPlugin) {}

	async load(): Promise<void> {
		// Read from in-memory canonical data — no disk read
		const raw = this.plugin.pluginData["syncState"] as Partial<SyncState> | undefined;

		if (!raw || raw.version !== 1) {
			this.state = emptyState();
		} else {
			this.state = {
				version: 1,
				files: (raw.files ?? {}) as Record<string, FileState>,
				dirs: (raw.dirs ?? {}) as Record<string, number>,
			};
		}

		this.pruneTombstones();
	}

	async save(): Promise<void> {
		// Write into canonical data object and flush to disk once
		this.plugin.pluginData["syncState"] = this.state;
		await this.plugin.saveData(this.plugin.pluginData);
	}

	private pruneTombstones(): void {
		const cutoff = Date.now() - TOMBSTONE_TTL_MS;
		for (const [path, state] of Object.entries(this.state.files)) {
			if (state.deleted && state.deletedAt !== undefined && state.deletedAt < cutoff) {
				delete this.state.files[path];
			}
		}
	}

	getFile(path: string): FileState | undefined {
		return this.state.files[path];
	}

	setFile(path: string, state: FileState): void {
		this.state.files[path] = state;
	}

	setTombstone(path: string): void {
		this.state.files[path] = { mtime: 0, deleted: true, deletedAt: Date.now() };
	}

	deleteEntry(path: string): void {
		delete this.state.files[path];
	}

	getDirMtime(path: string): number {
		return this.state.dirs[path] ?? 0;
	}

	setDirMtime(path: string, mtime: number): void {
		this.state.dirs[path] = mtime;
	}

	entries(): [string, FileState][] {
		return Object.entries(this.state.files);
	}
}
