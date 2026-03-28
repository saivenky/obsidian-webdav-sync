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

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
