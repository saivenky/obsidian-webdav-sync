/**
 * Integration tests for SyncEngine.
 *
 * These tests instantiate a real SyncEngine with mock plugin/vault/adapter/client,
 * and assert what mtime gets stored in state after each sync operation.
 * This catches bugs that the pure decide() unit tests cannot — specifically where
 * the implementation stores the wrong mtime value after a vault or WebDAV write.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { SyncEngine } from "./sync.js";
import { WebDAVError } from "./webdav.js";
import type { PropfindEntry } from "./webdav.js";
import { TFile } from "obsidian";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${(e as Error).message}`);
		failed++;
	}
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMocks(opts: {
	localMtimeBefore: number;
	/** mtime returned after client.put() — simulates same-filesystem WebDAV updating the inode */
	localMtimeAfter: number;
	initialState?: Record<string, { mtime: number }>;
	/** Paths returned by vault.getFiles(). Default []: existing tests assume no local-only files. */
	localFiles?: string[];
}) {
	let putCallCount = 0;

	const adapter = {
		stat: async (_path: string) => ({
			type: "file" as const,
			ctime: 0,
			mtime: putCallCount > 0 ? opts.localMtimeAfter : opts.localMtimeBefore,
			size: 0,
		}),
		read: async (_path: string) => "file content",
		write: async (_path: string, _content: string) => {},
		exists: async (_path: string) => true,
		mkdir: async (_path: string) => {},
	};

	const vault = {
		adapter,
		getAbstractFileByPath: (_path: string) => null,
		create: async (_path: string, _content: string) => {},
		modify: async (_file: unknown, _content: string) => {},
		trash: async (_file: unknown, _system: boolean) => {},
		getFiles: () => (opts.localFiles ?? []).map(p => ({ path: p })),
	};

	const pluginData: Record<string, unknown> = opts.initialState
		? { syncState: { version: 1, files: opts.initialState, dirs: {} } }
		: {};

	const plugin = {
		app: { vault },
		settings: {
			serverUrl: "http://localhost:1234",
			username: "",
			password: "",
			requestTimeoutMs: 5000,
			excludedPaths: [] as string[],
		},
		paused: false,
		pluginData,
		saveData: async (data: Record<string, unknown>) => {
			Object.assign(pluginData, data);
		},
		statusBarItem: { setText: (_: string) => {} },
	};

	const incrementPut = () => { putCallCount++; };

	return { adapter, vault, plugin, incrementPut };
}

function makeEngine(
	plugin: ReturnType<typeof makeMocks>["plugin"],
	remoteEntries: PropfindEntry[],
	onPut?: (path: string) => void
) {
	const client = {
		put: async (path: string, _content: string) => { onPut?.(path); },
		get: async (_path: string): Promise<string> => "remote content",
		delete: async (_path: string) => {},
		propfind: async (path: string, _depth: string): Promise<PropfindEntry[]> => {
			if (path === "/" || path === "") return remoteEntries;
			return [];
		},
	};
	return new SyncEngine(plugin as unknown as ConstructorParameters<typeof SyncEngine>[0], client as unknown as ConstructorParameters<typeof SyncEngine>[1]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async () => {

console.log("\nIntegration: PUSH re-stat after client.put() on same-filesystem WebDAV");

await test("PUSH-BOOT bug (confirmed): pre-PUT localMtime=5000 stored → cycle 2 sees local=9000 > state=5000 → CONFLICT", async () => {
	// local=5000 (old file), remote=3000 → local newer → PUSH-BOOT
	// client.put() writes through WebDAV → same inode → OS mtime becomes 9000
	// Without fix: state=5000. Cycle 2: local=9000 > 5000 AND remote=9000 > 5000 → CONFLICT.
	const { plugin, incrementPut } = makeMocks({ localMtimeBefore: 5000, localMtimeAfter: 9000 });
	const engine = makeEngine(plugin, [{ path: "test.md", mtime: 3000, isDir: false }], incrementPut);
	await engine.init();
	await engine.requestSync();

	const storedMtime = engine.stateManager.getFile("test.md")?.mtime;
	assert.equal(storedMtime, 9000, `expected state=9000 (post-PUT mtime) but got ${storedMtime}`);
});

await test("PUSH-BOOT fix: state=post-PUT mtime=9000 → cycle 2 local=9000=state, remote=9000=state → SKIP", async () => {
	const { plugin, incrementPut } = makeMocks({ localMtimeBefore: 5000, localMtimeAfter: 9000 });
	const engine = makeEngine(plugin, [{ path: "test.md", mtime: 3000, isDir: false }], incrementPut);
	await engine.init();
	await engine.requestSync();

	const storedMtime = engine.stateManager.getFile("test.md")?.mtime;
	assert.equal(storedMtime, 9000, `expected state=9000 but got ${storedMtime}`);

	// Cycle 2: local=9000 (stat unchanged after PUT), server reports 9000
	// state=9000 → Case 6: local===state AND remote===state → SKIP, no CONFLICT
	const engine2 = makeEngine(plugin, [{ path: "test.md", mtime: 9000, isDir: false }]);
	await engine2.init();
	let conflictFired = false;
	const origLog = (engine2 as unknown as { log(s: string): Promise<void> }).log.bind(engine2);
	(engine2 as unknown as { log(s: string): Promise<void> }).log = async (entry: string) => {
		if (entry.startsWith("CONFLICT")) conflictFired = true;
		return origLog(entry);
	};
	await engine2.requestSync();
	assert.equal(conflictFired, false, "cycle 2 must not fire CONFLICT after fix");
});

await test("Case 8 PUSH fix: state=post-PUT mtime=5000 → cycle 2 SKIP", async () => {
	// state=900, local=1000 (changed), remote=900 → Case 8 PUSH
	// client.put() → same inode → local mtime becomes 5000
	// Fix: state=5000. Cycle 2: local=5000=state, remote=5000=state → SKIP.
	const { plugin, incrementPut } = makeMocks({
		localMtimeBefore: 1000,
		localMtimeAfter: 5000,
		initialState: { "notes.md": { mtime: 900 } },
	});
	const engine = makeEngine(plugin, [{ path: "notes.md", mtime: 900, isDir: false }], incrementPut);
	await engine.init();
	await engine.requestSync();

	const storedMtime = engine.stateManager.getFile("notes.md")?.mtime;
	assert.equal(storedMtime, 5000, `expected state=5000 (post-PUT mtime) but got ${storedMtime}`);
});

// ─── Case 4 / Case 5: PULL-NEW and PUSH-NEW ──────────────────────────────────

console.log("\nCase 4 / Case 5: PULL-NEW and PUSH-NEW");

await test("PULL-NEW: new remote file is created locally", async () => {
	// File exists on remote (mtime=5000), no state, no local file.
	// adapter.stat() returns null (no local files), so Case 4 fires.
	// When afterStat is null, mtime4 = remoteMtime = 5000, satisfying the assertion.
	let createdPath: string | undefined;
	let createdContent: string | undefined;

	const adapter = {
		stat: async (_path: string) => null,
		read: async (_path: string) => "",
		write: async (_path: string, _content: string) => {},
		exists: async (_path: string) => false,
		mkdir: async (_path: string) => {},
	};
	const vault = {
		adapter,
		getAbstractFileByPath: (_path: string) => null,
		create: async (path: string, content: string) => { createdPath = path; createdContent = content; },
		modify: async (_file: unknown, _content: string) => {},
		trash: async (_file: unknown, _system: boolean) => {},
		getFiles: () => [] as { path: string }[],
	};
	const pluginData: Record<string, unknown> = {};
	const plugin = {
		app: { vault },
		settings: { serverUrl: "http://localhost:1234", username: "", password: "", requestTimeoutMs: 5000, excludedPaths: [] as string[] },
		paused: false, pluginData,
		saveData: async (data: Record<string, unknown>) => { Object.assign(pluginData, data); },
		statusBarItem: { setText: (_: string) => {} },
	};
	const client = {
		put: async (_path: string, _content: string) => {},
		get: async (_path: string): Promise<string> => "remote content",
		delete: async (_path: string) => {},
		propfind: async (path: string, _depth: string): Promise<PropfindEntry[]> => {
			if (path === "/" || path === "") return [{ path: "new-from-mobile.md", mtime: 5000, isDir: false }];
			return [];
		},
	};
	const engine = new SyncEngine(plugin as unknown as ConstructorParameters<typeof SyncEngine>[0], client as unknown as ConstructorParameters<typeof SyncEngine>[1]);
	await engine.init();
	await engine.requestSync();

	assert.equal(createdPath, "new-from-mobile.md", "vault.create must be called for new remote file");
	assert.equal(createdContent, "remote content", "vault.create must receive the remote file content");
	const state = engine.stateManager.getFile("new-from-mobile.md");
	assert.ok(state, "state entry must be recorded after PULL-NEW");
	assert.ok(state!.mtime >= 5000, `state mtime (${state!.mtime}) must be >= remoteMtime (5000)`);
});

await test("PUSH-NEW: new local file is pushed to remote", async () => {
	// File exists locally (mtime=1000), no state, nothing on remote.
	// Expected: client.put called, state entry recorded.
	let putPath: string | undefined;
	const { plugin, incrementPut } = makeMocks({
		localMtimeBefore: 1000,
		localMtimeAfter: 1000,
		localFiles: ["new-local.md"],
	});
	const engine = makeEngine(plugin, [], (path) => { putPath = path; incrementPut(); });
	await engine.init();
	await engine.requestSync();

	assert.equal(putPath, "new-local.md", "client.put must be called to push new local file to remote");
	const state = engine.stateManager.getFile("new-local.md");
	assert.ok(state, "state entry must be recorded after PUSH-NEW");
	assert.ok(state!.mtime >= 1000, `state mtime (${state?.mtime}) must be >= localMtime (1000)`);
});

// ─── requestSyncFile: error handling ─────────────────────────────────────────

console.log("\nrequestSyncFile: network error vs 404 handling");

function makeRequestSyncFileSetup(propfindError: Error) {
	const pluginData: Record<string, unknown> = {
		syncState: { version: 1, files: { "Daily/2026-03-31.md": { mtime: 5000 } }, dirs: {} },
	};
	const adapter = {
		stat: async (_path: string) => ({ type: "file" as const, ctime: 0, mtime: 5000, size: 0 }),
		read: async (_path: string) => "local content",
		write: async (_path: string, _content: string) => {},
		exists: async (_path: string) => false,
		mkdir: async (_path: string) => {},
	};
	const vault = {
		adapter,
		getAbstractFileByPath: (_path: string) => null,
		create: async (_path: string, _content: string) => {},
		modify: async (_file: unknown, _content: string) => {},
		trash: async (_file: unknown, _system: boolean) => {},
		getFiles: () => [] as { path: string }[],
	};
	const plugin = {
		app: { vault },
		settings: { serverUrl: "http://localhost:1234", username: "", password: "", requestTimeoutMs: 5000, excludedPaths: [] as string[] },
		paused: false, pluginData,
		saveData: async (data: Record<string, unknown>) => { Object.assign(pluginData, data); },
		statusBarItem: { setText: (_: string) => {} },
	};
	const client = {
		put: async (_path: string, _content: string) => {},
		get: async (_path: string): Promise<string> => "remote content",
		delete: async (_path: string) => {},
		propfind: async (_path: string, _depth: string): Promise<PropfindEntry[]> => {
			throw propfindError;
		},
	};
	const engine = new SyncEngine(
		plugin as unknown as ConstructorParameters<typeof SyncEngine>[0],
		client as unknown as ConstructorParameters<typeof SyncEngine>[1],
	);
	return engine;
}

await test("requestSyncFile: network error (no statusCode) does NOT REMOTE-DELETE", async () => {
	const engine = makeRequestSyncFileSetup(new WebDAVError("Network error: connection refused"));
	await engine.init();

	await engine.requestSyncFile("Daily/2026-03-31.md");

	// State entry must survive — server was unreachable, file was not deleted
	const state = engine.stateManager.getFile("Daily/2026-03-31.md");
	assert.ok(state, "state entry must still exist after a network error (server was unreachable, not file-absent)");
});

await test("requestSyncFile: 404 DOES REMOTE-DELETE (file genuinely gone from server)", async () => {
	const engine = makeRequestSyncFileSetup(new WebDAVError("PROPFIND failed: Daily/2026-03-31.md", 404));
	await engine.init();

	await engine.requestSyncFile("Daily/2026-03-31.md");

	// State entry must be deleted — server confirmed file is gone
	const state = engine.stateManager.getFile("Daily/2026-03-31.md");
	assert.equal(state, undefined, "state entry must be removed after a confirmed 404 (file deleted on server)");
});

// ─── Case 5.5 MERGE-BOOT ─────────────────────────────────────────────────────

console.log("\nCase 5.5 MERGE-BOOT: Bootstrap with local newer");

function makeMergeBootMocks(opts: {
	localContent: string;
	remoteContent: string;
	localMtimeBefore: number;
	localMtimeAfter: number;
	remoteMtime: number;
}) {
	let modifiedContent: string | undefined;
	let putContent: string | undefined;

	const adapter = {
		stat: async (_path: string) => ({
			type: "file" as const,
			ctime: 0,
			mtime: modifiedContent !== undefined ? opts.localMtimeAfter : opts.localMtimeBefore,
			size: 0,
		}),
		read: async (_path: string) => opts.localContent,
		write: async (_path: string, _content: string) => {},
		exists: async (_path: string) => true,
		mkdir: async (_path: string) => {},
	};

	const vault = {
		adapter,
		getAbstractFileByPath: (_path: string) => Object.assign(new TFile(), { path: _path }),
		create: async (_path: string, _content: string) => {},
		modify: async (_file: unknown, content: string) => { modifiedContent = content; },
		trash: async (_file: unknown, _system: boolean) => {},
		getFiles: () => [{ path: "test.md" }] as { path: string }[],
	};

	const pluginData: Record<string, unknown> = {};
	const plugin = {
		app: { vault },
		settings: { serverUrl: "http://localhost:1234", username: "", password: "", requestTimeoutMs: 5000, excludedPaths: [] as string[] },
		paused: false, pluginData,
		saveData: async (data: Record<string, unknown>) => { Object.assign(pluginData, data); },
		statusBarItem: { setText: (_: string) => {} },
	};

	const client = {
		put: async (_path: string, content: string) => { putContent = content; },
		get: async (_path: string): Promise<string> => opts.remoteContent,
		delete: async (_path: string) => {},
		propfind: async (path: string, _depth: string): Promise<PropfindEntry[]> => {
			if (path === "/" || path === "") return [{ path: "test.md", mtime: opts.remoteMtime, isDir: false }];
			return [];
		},
	};

	const engine = new SyncEngine(
		plugin as unknown as ConstructorParameters<typeof SyncEngine>[0],
		client as unknown as ConstructorParameters<typeof SyncEngine>[1],
	);

	return { engine, getModified: () => modifiedContent, getPut: () => putContent };
}

await test("MERGE-BOOT primary bug: template (empty sections, newer) vs schedule (older) → schedule preserved, no duplicate headers", async () => {
	const localTemplate = "## Schedule\n\n## Notes\n\n";
	const remoteSchedule = "## Schedule\n- 09:00 Meeting\n- 14:00 Standup\n\n## Notes\n- Called mom\n";
	const { engine, getModified, getPut } = makeMergeBootMocks({
		localContent: localTemplate,
		remoteContent: remoteSchedule,
		localMtimeBefore: 2000,
		localMtimeAfter: 3000,
		remoteMtime: 1000,
	});
	await engine.init();
	await engine.requestSync();

	const modified = getModified();
	const put = getPut();
	assert.ok(modified !== undefined, "vault.modify must be called");
	assert.ok(put !== undefined, "client.put must be called");
	assert.ok(modified!.includes("09:00 Meeting"), "schedule content must be in merged output");
	assert.ok(modified!.includes("Called mom"), "notes content must be in merged output");
	const scheduleHeaders = (modified!.match(/## Schedule/g) ?? []).length;
	assert.equal(scheduleHeaders, 1, "## Schedule must appear exactly once (no duplicate headers)");
	assert.equal(modified, put, "local and remote must both receive the same merged content");

	const state = engine.stateManager.getFile("test.md");
	assert.ok(state, "state entry must be recorded after MERGE-BOOT");
});

await test("MERGE-BOOT tradeoff A (flat notes): both sides have content → concatenated, neither lost", async () => {
	const localFlat = "Mobile note: picked up groceries and called dentist appointment.\n";
	const remoteFlat = "Desktop note: reviewed quarterly report and sent follow-up emails.\n";
	const { engine, getModified } = makeMergeBootMocks({
		localContent: localFlat,
		remoteContent: remoteFlat,
		localMtimeBefore: 2000,
		localMtimeAfter: 3000,
		remoteMtime: 1000,
	});
	await engine.init();
	await engine.requestSync();

	const modified = getModified();
	assert.ok(modified !== undefined, "vault.modify must be called");
	assert.ok(modified!.includes("groceries"), "local content must appear in merged output");
	assert.ok(modified!.includes("quarterly report"), "remote content must appear in merged output");
});

await test("MERGE-BOOT tradeoff B (empty local): empty local (newer) + filled remote (older) → remote content restored", async () => {
	const { engine, getModified } = makeMergeBootMocks({
		localContent: "",
		remoteContent: "## Notes\n- Important server content\n",
		localMtimeBefore: 2000,
		localMtimeAfter: 3000,
		remoteMtime: 1000,
	});
	await engine.init();
	await engine.requestSync();

	const modified = getModified();
	assert.ok(modified !== undefined, "vault.modify must be called");
	assert.ok(modified!.includes("Important server content"), "remote content must be restored when local is empty");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

})();
