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
import type { PropfindEntry } from "./webdav.js";

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
		// Default: no local-only files. Tests that exercise PUSH-NEW must use inline mocks.
		getFiles: () => [] as { path: string }[],
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
	onPut?: () => void
) {
	const client = {
		put: async (_path: string, _content: string) => { onPut?.(); },
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
	// Expected: vault.create called, state entry recorded with mtime >= 5000.
	let createdPath: string | undefined;
	let createdContent: string | undefined;

	// localFiles tracks what vault.create() has written so that adapter.stat()
	// returns null before creation (triggering Case 4) and a real stat after.
	// mtime=5000 matches remoteMtime so Math.max(afterStat, remote) = 5000.
	const localFiles = new Set<string>();
	const adapter = {
		stat: async (path: string) => {
			if (localFiles.has(path)) {
				return { type: "file" as const, ctime: 0, mtime: 5000, size: 0 };
			}
			return null;
		},
		read: async (_path: string) => "",
		write: async (_path: string, _content: string) => {},
		exists: async (_path: string) => false,
		mkdir: async (_path: string) => {},
	};

	const vault = {
		adapter,
		getAbstractFileByPath: (_path: string) => null,
		create: async (path: string, content: string) => {
			createdPath = path;
			createdContent = content;
			localFiles.add(path);
		},
		modify: async (_file: unknown, _content: string) => {},
		trash: async (_file: unknown, _system: boolean) => {},
		getFiles: () => [] as { path: string }[],
	};

	const pluginData: Record<string, unknown> = {};
	const plugin = {
		app: { vault },
		settings: { serverUrl: "http://localhost:1234", username: "", password: "", requestTimeoutMs: 5000, excludedPaths: [] as string[] },
		paused: false,
		pluginData,
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
	// BUG: allPaths is built from remote + state only — local-only files are never
	// added to allPaths, so decideFile() is never called for them and Case 5 never fires.
	let putPath: string | undefined;

	const adapter = {
		stat: async (path: string) => {
			if (path === "new-local.md") {
				return { type: "file" as const, ctime: 0, mtime: 1000, size: 0 };
			}
			return null;
		},
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
		getFiles: () => [{ path: "new-local.md" }] as { path: string }[],
	};

	const pluginData: Record<string, unknown> = {};
	const plugin = {
		app: { vault },
		settings: { serverUrl: "http://localhost:1234", username: "", password: "", requestTimeoutMs: 5000, excludedPaths: [] as string[] },
		paused: false,
		pluginData,
		saveData: async (data: Record<string, unknown>) => { Object.assign(pluginData, data); },
		statusBarItem: { setText: (_: string) => {} },
	};

	const client = {
		put: async (path: string, _content: string) => { putPath = path; },
		get: async (_path: string): Promise<string> => "",
		delete: async (_path: string) => {},
		propfind: async (path: string, _depth: string): Promise<PropfindEntry[]> => {
			if (path === "/" || path === "") return []; // nothing on remote
			return [];
		},
	};

	const engine = new SyncEngine(plugin as unknown as ConstructorParameters<typeof SyncEngine>[0], client as unknown as ConstructorParameters<typeof SyncEngine>[1]);
	await engine.init();
	await engine.requestSync();

	assert.equal(putPath, "new-local.md", "client.put must be called to push new local file to remote");
	const state = engine.stateManager.getFile("new-local.md");
	assert.ok(state, "state entry must be recorded after PUSH-NEW");
	assert.ok(state!.mtime >= 1000, `state mtime (${state?.mtime}) must be >= localMtime (1000)`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

})();
