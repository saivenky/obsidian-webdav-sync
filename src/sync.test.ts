/**
 * Unit tests for sync.ts mtime feedback loop bugs.
 *
 * Run with: npm test
 *
 * The sync state machine uses stateEntry.mtime as the baseline for two comparisons:
 *   localMtime > stateEntry.mtime  → "local changed since last sync"
 *   remoteMtime > stateEntry.mtime → "remote changed since last sync"
 *
 * After any write operation (vault.modify, vault.create, client.put), the OS and
 * server independently assign their own mtimes. If stateEntry.mtime doesn't match
 * what adapter.stat() or PROPFIND returns on the next cycle, spurious operations fire.
 *
 * These tests verify the invariants as pure state-machine logic without Obsidian mocks.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { isSymlink } from "./symlink.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${(e as Error).message}`);
		failed++;
	}
}

// ─── Decision logic (mirrors decideFile in sync.ts) ──────────────────────────
// These pure functions replicate the case-detection logic so we can test
// which case fires for a given (localMtime, remoteMtime, stateMtime) triple.

type Case =
	| "SKIP"
	| "REMOTE-DELETE"
	| "LOCAL-DELETE"
	| "PULL-NEW"
	| "PUSH-NEW"
	| "PULL"
	| "PUSH"
	| "CONFLICT";

function decide(
	localMtime: number | null,
	remoteMtime: number | null,
	stateMtime: number | undefined,
	deleted = false
): Case {
	const stateExists = stateMtime !== undefined;
	const stateBase = stateMtime ?? 0;

	if (!remoteMtime && stateExists && !deleted) return "REMOTE-DELETE";
	if (deleted) return "SKIP"; // tombstone handled separately
	if (localMtime === null && stateExists && !deleted) return "LOCAL-DELETE";
	if (remoteMtime && !stateExists && localMtime === null) return "PULL-NEW";
	if (localMtime !== null && !stateExists && !remoteMtime) return "PUSH-NEW";

	// Both exist, no state → bootstrap (Case 5.5)
	if (remoteMtime && !stateExists && localMtime !== null) {
		if (localMtime === remoteMtime) return "SKIP";
		return remoteMtime > localMtime ? "PULL" : "PUSH";
	}

	// Case 6: in sync
	if (localMtime !== null && remoteMtime !== null &&
		localMtime === stateMtime && remoteMtime === stateMtime) return "SKIP";

	// Case 7: remote newer, local unchanged
	if (remoteMtime !== null && remoteMtime > stateBase && localMtime === stateMtime) return "PULL";

	// Case 8: local newer, remote unchanged
	if (localMtime !== null && localMtime > stateBase && remoteMtime === stateMtime) return "PUSH";

	// Case 9: both changed
	if (localMtime !== null && remoteMtime !== null &&
		localMtime > stateBase && remoteMtime > stateBase) return "CONFLICT";

	return "SKIP";
}

// ─── Bug 1: conflict() stored Date.now() causing sync freeze ─────────────────

console.log("\nconflict() mtime bug: Date.now() causes sync freeze");

test("conflict fires on first sync (both sides changed since baseline)", () => {
	// stateEntry.mtime = 900, localMtime = 1000, remoteMtime = 1100
	assert.equal(decide(1000, 1100, 900), "CONFLICT");
});

test("Date.now() baseline: if Date.now() > OS mtime and server mtime → file frozen forever", () => {
	// Buggy: conflict() stored Date.now() = 9999
	// OS assigned localMtime = 1050, server assigned remoteMtime = 1150
	// Next cycle: both 1050 and 1150 are LESS than stateEntry.mtime = 9999
	// → neither localMtime > 9999 nor remoteMtime > 9999 → no case matches → SKIP
	assert.equal(decide(1050, 1150, 9999), "SKIP"); // Bug: permanently frozen
});

test("fix: actual OS stat (1050) as baseline → Case 7 fires (one harmless pull)", () => {
	// Fixed: conflict() stored afterStat.mtime = 1050
	// Next cycle: localMtime (1050) === stateEntry (1050) → local clean
	//             remoteMtime (1150) > stateEntry (1050) → Case 7
	assert.equal(decide(1050, 1150, 1050), "PULL");
});

test("fix: after one Case 7 pull, state = max(newLocalMtime, remoteMtime) → quiescent", () => {
	// Case 7 pulled and stored Math.max(1180, 1150) = 1180
	// Next cycle: localMtime = 1180 (post-modify), remoteMtime = 1150 (unchanged)
	// Both ≤ stateEntry.mtime = 1180 → no case fires → SKIP
	assert.equal(decide(1180, 1150, 1180), "SKIP");
});

test("Date.now() baseline: if Date.now() < both OS mtime and server mtime → immediate re-conflict", () => {
	// Buggy: Date.now() = 1075 (captured before async writes completed)
	// vault.modify() assigned OS mtime = 1090 (completes after Date.now() call)
	// client.put() caused server to assign mtime = 1120 (arrives after Date.now() call)
	// Both 1090 and 1120 exceed stateEntry.mtime = 1075 → Case 9 fires again!
	assert.equal(decide(1090, 1120, 1075), "CONFLICT"); // infinite loop confirmed
});

// ─── Bug 2: Case 7 (pull) storing remoteMtime → spurious PUSH next cycle ─────

console.log("\nCase 7 (pull) mtime bug: remoteMtime baseline causes Case 7→Case 8 oscillation");

test("Case 7 fires: remote updated, local unchanged", () => {
	// stateEntry = 900, localMtime = 900 (unchanged), remoteMtime = 1000
	assert.equal(decide(900, 1000, 900), "PULL");
});

test("buggy: storing remoteMtime (1000) → local (1050 post-modify) looks changed → PUSH", () => {
	// vault.modify() assigned OS mtime = 1050
	// Buggy code stored { mtime: 1000 } (remoteMtime)
	// Next cycle: localMtime (1050) > stateEntry (1000) AND remoteMtime (1000) === stateEntry → Case 8
	assert.equal(decide(1050, 1000, 1000), "PUSH"); // spurious PUSH
});

test("fix: storing Math.max(1050, 1000) = 1050 → no case fires next cycle", () => {
	// Fixed code stored { mtime: 1050 } = Math.max(afterStat.mtime, remoteMtime)
	// Next cycle: localMtime (1050) === stateEntry (1050) → local clean
	//             remoteMtime (1000) < stateEntry (1050) → no case fires
	assert.equal(decide(1050, 1000, 1050), "SKIP");
});

test("fix: if remote mtime > local mtime, Math.max stores remoteMtime → still quiescent", () => {
	// vault.modify() at T=1000, server mtime = 1100
	// Math.max(1000, 1100) = 1100 stored in state
	// Next cycle: localMtime (1000) < stateEntry (1100) → no case fires
	//             remoteMtime (1100) === stateEntry (1100) → remote clean
	assert.equal(decide(1000, 1100, 1100), "SKIP");
});

// ─── Bug 3: Case 4 (pull new) storing remoteMtime → spurious PUSH ─────────────

console.log("\nCase 4 (pull new) mtime bug: remoteMtime baseline causes spurious PUSH");

test("Case 4 fires: remote-only file pulled and created locally", () => {
	assert.equal(decide(null, 1000, undefined), "PULL-NEW");
});

test("buggy: storing remoteMtime (1000) after vault.create() → local (1050) looks changed → PUSH", () => {
	// vault.create() assigned OS mtime = 1050 ≠ remoteMtime = 1000
	// Buggy code stored { mtime: 1000 }
	// Next cycle: localMtime (1050) > stateEntry (1000) AND remoteMtime (1000) === stateEntry → Case 8
	assert.equal(decide(1050, 1000, 1000), "PUSH"); // spurious
});

test("fix: Math.max(1050, 1000) = 1050 stored → quiescent on next cycle", () => {
	assert.equal(decide(1050, 1000, 1050), "SKIP");
});

// ─── Case 8 (push): one-time Case 7 bounce is acceptable ─────────────────────

console.log("\nCase 8 (push) mtime: server assigns higher mtime → one-time PULL (acceptable)");

test("Case 8 fires: local updated, remote unchanged", () => {
	assert.equal(decide(1000, 900, 900), "PUSH");
});

test("after push, server assigns mtime 1100 > localMtime 1000 → one Case 7 bounce", () => {
	// Current code stores { mtime: localMtime = 1000 }
	// Server assigned 1100. Next cycle: remoteMtime (1100) > stateEntry (1000) → Case 7
	assert.equal(decide(1000, 1100, 1000), "PULL"); // one bounce
});

test("after that one Case 7 bounce with fix, system quiesces", () => {
	// Case 7 stores Math.max(newLocalMtime=1150, remoteMtime=1100) = 1150
	// Next: localMtime (1150) === 1150, remoteMtime (1100) < 1150 → SKIP
	assert.equal(decide(1150, 1100, 1150), "SKIP");
});

// ─── Convergence: conflict → pull → stable ────────────────────────────────────

console.log("\nConvergence: three-cycle sequence conflict → pull → stable");

test("cycle 1: both changed → CONFLICT", () => {
	assert.equal(decide(1000, 1100, 900), "CONFLICT");
});

test("cycle 2: after conflict fix, state=1050, remote=1150 → PULL (one harmless pull)", () => {
	// conflict() wrote merged to both. OS assigned 1050. Server assigned 1150.
	// Fixed code stored afterStat.mtime = 1050.
	assert.equal(decide(1050, 1150, 1050), "PULL");
});

test("cycle 3: after Case 7 pull with fix, Math.max(1180, 1150)=1180 → SKIP", () => {
	// Case 7 pulled and vault.modify() set localMtime = 1180. Math.max(1180, 1150) = 1180.
	// Both 1180 ≤ 1180 and 1150 < 1180 → SKIP.
	assert.equal(decide(1180, 1150, 1180), "SKIP");
});

// ─── Multi-cycle stability: after any operation, a single-device second cycle must not CONFLICT ─────
//
// Invariant: after any sync operation stores state S, decide(nextLocal, remote, S) must never
// return "CONFLICT" on a single device (no concurrent writes from another device).

console.log("\nMulti-cycle stability: no CONFLICT on second cycle (single device)");

// Test 1: Case 7 PULL — afterStat exactly equals remoteMtime (boundary of Math.max)
test("Case 7 PULL: afterStat=remoteMtime boundary → Math.max picks same value → SKIP next cycle", () => {
	// Cycle 1: state=1000, local=1000 (unchanged), remote=1100 → Case 7 PULL
	assert.equal(decide(1000, 1100, 1000), "PULL");
	// vault.modify() happens to assign OS mtime = 1100 (same as remoteMtime)
	// Math.max(1100, 1100) = 1100 → state = 1100
	// Cycle 2: local=1100=state, remote=1100=state → Case 6 SKIP
	assert.equal(decide(1100, 1100, 1100), "SKIP");
});

// Test 2: Case 7 PULL — afterStat > remoteMtime; wrong formula (remoteMtime-only) causes PUSH
test("Case 7 PULL: afterStat > remoteMtime; storing remoteMtime-only causes spurious PUSH; Math.max fix gives SKIP", () => {
	// Cycle 1: state=1000, local=1000, remote=1100 → PULL
	assert.equal(decide(1000, 1100, 1000), "PULL");
	// vault.modify() assigns OS mtime = 1150 (> remoteMtime=1100)
	// Bug path: state = remoteMtime = 1100 → local(1150) > state(1100) AND remote(1100)=state → Case 8 PUSH
	assert.equal(decide(1150, 1100, 1100), "PUSH"); // confirms the regression
	// Fix path: state = Math.max(1150, 1100) = 1150 → SKIP
	assert.equal(decide(1150, 1100, 1150), "SKIP");
});

// Test 3: Case 8 PUSH — server mtime equals localMtime (no bounce needed)
test("Case 8 PUSH: server assigns T_server=localMtime → state=localMtime → SKIP immediately", () => {
	// Cycle 1: state=900, local=1000, remote=900 → PUSH. State = localMtime = 1000.
	assert.equal(decide(1000, 900, 900), "PUSH");
	// Server happens to assign T_server = 1000 (same as localMtime)
	// Cycle 2: local=1000=state=1000, remote=1000=state → Case 6 SKIP
	assert.equal(decide(1000, 1000, 1000), "SKIP");
});

// Test 4: Case 8 PUSH → Case 7 bounce → SKIP (three-cycle stability)
test("Case 8 PUSH → server assigns higher mtime → one PULL bounce → SKIP (Math.max breaks oscillation)", () => {
	// Cycle 1: state=900, local=1000, remote=900 → PUSH. State = 1000.
	assert.equal(decide(1000, 900, 900), "PUSH");
	// Server assigns T_server = 1100 > localMtime = state = 1000
	// Cycle 2: remote(1100) > state(1000) AND local(1000)=state → Case 7 bounce
	assert.equal(decide(1000, 1100, 1000), "PULL");
	// vault.modify() assigns OS mtime = 1120. Math.max(1120, 1100) = 1120 → state = 1120
	// Cycle 3: local=1120=state, remote=1100 < state → SKIP
	assert.equal(decide(1120, 1100, 1120), "SKIP");
});

// Test 5: Case 9 CONFLICT — server mtime > afterStat → one PULL bounce → SKIP
test("Case 9 CONFLICT: server mtime > afterStat → state=afterStat → one PULL bounce → SKIP", () => {
	// Cycle 1: state=900, local=1000, remote=1100 → CONFLICT
	assert.equal(decide(1000, 1100, 900), "CONFLICT");
	// vault.modify() assigns afterStat=1050. client.put() → server mtime=1200. State = 1050.
	// Cycle 2: remote(1200) > state(1050) AND local(1050)=state → Case 7 bounce
	assert.equal(decide(1050, 1200, 1050), "PULL");
	// vault.modify() assigns afterStat2=1250. Math.max(1250, 1200) = 1250 → state = 1250
	// Cycle 3: local=1250=state, remote=1200 < state → SKIP
	assert.equal(decide(1250, 1200, 1250), "SKIP");
});

// Test 6: Case 9 CONFLICT — server mtime < afterStat → SKIP immediately (no bounce)
test("Case 9 CONFLICT: afterStat > server mtime → state=afterStat → SKIP immediately", () => {
	// Cycle 1: state=900, local=1000, remote=1100 → CONFLICT
	assert.equal(decide(1000, 1100, 900), "CONFLICT");
	// vault.modify() assigns afterStat=1300 (> server's 1150). State = 1300.
	// Cycle 2: local=1300=state, remote=1150 < state → no case fires → SKIP
	assert.equal(decide(1300, 1150, 1300), "SKIP");
});

// Test 7: Case 5.5 bootstrap PULL — Math.max(afterStat, remoteMtime) keeps SKIP on cycle 2
test("Bootstrap PULL (5.5): Math.max(afterStat, remoteMtime) ≥ both sides → SKIP on cycle 2", () => {
	// No state, local=800, remote=1000 → remote newer → PULL bootstrap
	// vault.modify() assigns afterStat=1050. Math.max(1050, 1000) = 1050 → state = 1050
	// Cycle 2: local=1050=state, remote=1000 < state → SKIP
	assert.equal(decide(1050, 1000, 1050), "SKIP");
	// Bug path: storing only remoteMtime(1000) → local(1050) > state(1000) → PUSH
	assert.equal(decide(1050, 1000, 1000), "PUSH"); // confirms the regression
});

// Test 8: Case 5.5 bootstrap PUSH — state=localMtime; server assigns higher mtime → one bounce → SKIP
test("Bootstrap PUSH (5.5): state=localMtime → server assigns higher mtime → one PULL bounce → SKIP", () => {
	// No state, local=1000, remote=800 → local newer → PUSH bootstrap. State = localMtime = 1000.
	// Server assigns T_server = 1100 > localMtime = state = 1000
	// Cycle 2: remote(1100) > state(1000) AND local(1000)=state → Case 7 bounce
	assert.equal(decide(1000, 1100, 1000), "PULL");
	// vault.modify() assigns afterStat=1150. Math.max(1150, 1100) = 1150 → state = 1150
	// Cycle 3: local=1150=state, remote=1100 < state → SKIP
	assert.equal(decide(1150, 1100, 1150), "SKIP");
	// Bug path: bootstrap PUSH storing remoteMtime(800) → both 1000 > 800 AND 1100 > 800 → CONFLICT
	assert.equal(decide(1000, 1100, 800), "CONFLICT"); // confirms regression if wrong formula
});

// ─── isSymlink: symlinked files must be skipped to avoid infinite conflict loop ─
//
// CLAUDE.md → symlink to AGENTS.md in vault root.
// Writing to CLAUDE.md modifies AGENTS.md's inode, so AGENTS.md appears changed
// on the next cycle. Both paths then conflict indefinitely every 5s (debounce).
// Fix: detect symlinks via lstatSync and skip them in decideFile.

console.log("\nisSymlink: symlinked vault files must be skipped");

test("isSymlink returns true for a symbolic link", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-sym-"));
	try {
		const target = path.join(tmpDir, "target.md");
		const link = path.join(tmpDir, "link.md");
		fs.writeFileSync(target, "content");
		fs.symlinkSync(target, link);
		assert.equal(isSymlink(link), true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true });
	}
});

test("isSymlink returns false for a regular file", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-sym-"));
	try {
		const file = path.join(tmpDir, "file.md");
		fs.writeFileSync(file, "content");
		assert.equal(isSymlink(file), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true });
	}
});

test("isSymlink returns false for a missing path (no throw)", () => {
	assert.equal(isSymlink("/nonexistent/__no_such_file__.md"), false);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
