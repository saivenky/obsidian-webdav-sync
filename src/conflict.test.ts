/**
 * Unit tests for conflict.ts — mergeConflict and parseFile.
 *
 * Run with: npm test
 *
 * Tests are structured around the bugs that caused vault explosions:
 *   Bug 1: output.join("\n\n") adds blank lines when section content has trailing \n
 *   Bug 2: mergeConflict(A, A) !== A (idempotency broken)
 *   Bug 3: parseFile fidelity losses
 */

import assert from "node:assert/strict";
import { mergeConflict, parseFile, FRONTMATTER_SENTINEL } from "./conflict.js";

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

// ─── parseFile ────────────────────────────────────────────────────────────────

console.log("\nparseFile");

test("no content → empty sections", () => {
	assert.deepEqual(parseFile(""), []);
});

test("only whitespace → empty sections", () => {
	assert.deepEqual(parseFile("   \n  \n"), []);
});

test("plain body with no headings", () => {
	const secs = parseFile("Just some text\n");
	assert.equal(secs.length, 1);
	assert.equal(secs[0]!.header, "");
	assert.equal(secs[0]!.content, "Just some text\n");
});

test("single ## heading with content", () => {
	const secs = parseFile("## Notes\ncontent here\n");
	assert.equal(secs.length, 1);
	assert.equal(secs[0]!.header, "## Notes");
	assert.equal(secs[0]!.content, "content here\n");
});

test("frontmatter + heading section", () => {
	const input = "---\ndate: 2026-01-01\n---\n\n## Notes\ncontent\n";
	const secs = parseFile(input);
	assert.equal(secs.length, 2);
	assert.equal(secs[0]!.header, FRONTMATTER_SENTINEL);
	assert.equal(secs[0]!.content, "---\ndate: 2026-01-01\n---");
	assert.equal(secs[1]!.header, "## Notes");
	assert.equal(secs[1]!.content, "content\n");
});

test("frontmatter only (no body sections)", () => {
	const input = "---\ndate: 2026-01-01\n---\n";
	const secs = parseFile(input);
	assert.equal(secs.length, 1);
	assert.equal(secs[0]!.header, FRONTMATTER_SENTINEL);
});

test("unclosed frontmatter treated as plain body", () => {
	const input = "---\ntitle: Broken\n";
	const secs = parseFile(input);
	// No closing --- so it falls through as a plain body section
	assert.ok(secs.some(s => s.header === ""));
});

test("multiple heading sections preserve order", () => {
	const input = "## A\nfirst\n\n## B\nsecond\n\n## C\nthird\n";
	const secs = parseFile(input);
	assert.equal(secs.length, 3);
	assert.equal(secs[0]!.header, "## A");
	assert.equal(secs[1]!.header, "## B");
	assert.equal(secs[2]!.header, "## C");
});

test("section content does not start with \\n (leading \\n stripped)", () => {
	const input = "## A\ncontent\n";
	const secs = parseFile(input);
	assert.ok(!secs[0]!.content.startsWith("\n"));
});

// ─── Idempotency: mergeConflict(A, A) === A ───────────────────────────────────

console.log("\nIdempotency: mergeConflict(A, A, t, t) must equal A");

function idempotency(label: string, A: string): void {
	test(label, () => {
		const result = mergeConflict(A, A, 1000, 1000);
		assert.equal(
			result, A,
			`\nExpected:\n${JSON.stringify(A)}\nGot:\n${JSON.stringify(result)}`
		);
	});
}

idempotency(
	"plain body only",
	"Just some plain text content\n"
);

idempotency(
	"single section, trailing \\n",
	"## Notes\nsome content\n"
);

idempotency(
	"two sections with blank line between",
	"## Schedule\nMeeting at 9am\n\n## Notes\nBought groceries\n"
);

idempotency(
	"three sections",
	"## A\nline1\n\n## B\nline2\n\n## C\nline3\n"
);

idempotency(
	"frontmatter + one section",
	"---\ndate: 2026-01-01\n---\n\n## Notes\ncontent\n"
);

idempotency(
	"frontmatter + multiple sections (realistic daily note)",
	"---\ntitle: 2026-03-27\ndate: 2026-03-27\ntags: [daily]\n---\n\n## Schedule\n- 09:00 Meeting\n- 14:00 Gym\n\n## Notes\n- Bought groceries\n- Called mom\n\n## Email Briefing\n- Archived 12 newsletters\n"
);

idempotency(
	"section with single trailing newline only",
	"## Section A\n\n## Section B\n"
);

idempotency(
	"empty file",
	""
);

// ─── Blank line injection ─────────────────────────────────────────────────────

console.log("\nBlank line injection: output must not contain \\n\\n\\n");

test("two sections: no triple newline at boundary", () => {
	const A = "## Morning\nwoke up at 7\n\n## Evening\nhad dinner\n";
	const result = mergeConflict(A, A, 1000, 1000);
	assert.ok(
		!result.includes("\n\n\n"),
		`Got triple newline:\n${JSON.stringify(result)}`
	);
});

test("frontmatter + section: no triple newline", () => {
	const A = "---\ntags: [daily]\n---\n\n## Notes\ncontent\n";
	const result = mergeConflict(A, A, 1000, 1000);
	assert.ok(
		!result.includes("\n\n\n"),
		`Got triple newline:\n${JSON.stringify(result)}`
	);
});

test("small edit on one section: no triple newlines in output", () => {
	const local =
		"---\ndate: 2026-01-15\n---\n\n## Schedule\n- 09:00 Meeting\n- 14:30 Standup (moved)\n\n## Notes\n- Groceries\n";
	const remote =
		"---\ndate: 2026-01-15\n---\n\n## Schedule\n- 09:00 Meeting\n- 14:00 Standup\n\n## Notes\n- Groceries\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(!result.includes("\n\n\n"), `Got triple newline:\n${JSON.stringify(result)}`);
});

// ─── Newer wins ───────────────────────────────────────────────────────────────

console.log("\nNewer wins");

test("local newer, jaccard >= 0.6: local content kept", () => {
	const local = "## Notes\nWent for a morning run and had breakfast then worked on the project report today\n";
	const remote = "## Notes\nWent for a morning run and had breakfast then worked on the project report carefully\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("today"), "local word 'today' should appear");
	assert.ok(!result.includes("carefully"), "remote word 'carefully' should not appear");
});

test("remote newer, jaccard >= 0.6: remote content kept", () => {
	const local = "## Notes\nWent for a morning run and had breakfast then worked on the project report today\n";
	const remote = "## Notes\nWent for a morning run and had breakfast then worked on the project report carefully\n";
	const result = mergeConflict(local, remote, 1000, 2000);
	assert.ok(result.includes("carefully"), "remote word 'carefully' should appear");
	assert.ok(!result.includes("today"), "local word 'today' should not appear");
});

test("jaccard < 0.6: both sections emitted, newer first", () => {
	const local = "## Notes\nWent to gym did heavy squats deadlifts and bench press for strength training workout\n";
	const remote = "## Notes\nRead philosophy books wrote journal entries about stoicism daily reflection practice\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("squats"), "local content should appear");
	assert.ok(result.includes("stoicism"), "remote content should appear");
	// Newer (local) should appear first
	assert.ok(
		result.indexOf("squats") < result.indexOf("stoicism"),
		"local content should appear before remote content"
	);
});

test("equal mtime: local treated as newer (>= condition)", () => {
	const local = "## Notes\nlocal specific content only here in this section today thoroughly\n";
	const remote = "## Notes\nremote specific content only here in this section today thoroughly\n";
	const result = mergeConflict(local, remote, 1000, 1000);
	assert.ok(result.includes("local specific"), "local content should win when mtimes equal");
	assert.ok(!result.includes("remote specific"), "remote content should lose when mtimes equal");
});

// ─── Frontmatter handling ─────────────────────────────────────────────────────

console.log("\nFrontmatter handling");

test("same frontmatter (jaccard >= 0.6): kept once, not duplicated", () => {
	const fm = "---\ntitle: Daily\ndate: 2026-01-15\ntags: [daily]\n---\n\n";
	const body = "## Notes\ncontent\n";
	const result = mergeConflict(fm + body, fm + body, 1000, 1000);
	const fmCount = (result.match(/---/g) ?? []).length;
	assert.equal(fmCount, 2, "should have exactly one frontmatter block (2 --- markers)");
});

test("diverged frontmatter: union, newer first, no duplicate keys", () => {
	const local = "---\nstatus: done\ntitle: Daily\n---\n\n## Notes\nsome words here for jaccard testing purposes longer text\n";
	const remote = "---\nmood: good\ntitle: Daily\n---\n\n## Notes\nentirely different content nothing matches words here\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("status: done"), "local frontmatter field should appear");
	assert.ok(result.includes("mood: good"), "remote frontmatter field should appear");
	// title: Daily should appear exactly once
	const titleCount = (result.match(/title: Daily/g) ?? []).length;
	assert.equal(titleCount, 1, "duplicate frontmatter keys should not appear");
});

test("only local has frontmatter: frontmatter preserved in output", () => {
	const local = "---\ntitle: Test\n---\n\n## Notes\ncontent\n";
	const remote = "## Notes\ncontent\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("---"), "frontmatter should be preserved");
	assert.ok(result.includes("title: Test"), "frontmatter content should be preserved");
});

// ─── Section matching ─────────────────────────────────────────────────────────

console.log("\nSection matching");

test("local-only new section: preserved in output", () => {
	const local = "## Notes\ncontent\n\n## New Idea\nnew and exciting addition\n";
	const remote = "## Notes\ncontent\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("## New Idea"), "local-only section should appear");
	assert.ok(result.includes("new and exciting"), "local-only content should appear");
});

test("remote-only new section: preserved in output", () => {
	const local = "## Notes\ncontent\n";
	const remote = "## Notes\ncontent\n\n## Remote Section\nremote addition here\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("## Remote Section"), "remote-only section should appear");
	assert.ok(result.includes("remote addition"), "remote-only content should appear");
});

test("both added different new sections: all sections appear", () => {
	const local = "## Notes\nshared content\n\n## Local New\nlocal addition\n";
	const remote = "## Notes\nshared content\n\n## Remote New\nremote addition\n";
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(result.includes("## Notes"), "shared section should appear");
	assert.ok(result.includes("## Local New"), "local-only section should appear");
	assert.ok(result.includes("## Remote New"), "remote-only section should appear");
});

test("section order follows newer (spine) file order", () => {
	// Local: Alpha then Beta. Remote: Beta then Alpha.
	const alpha = "went for a morning run and had breakfast then worked deeply focused ";
	const beta = "read philosophy books wrote journal entries about stoicism reflection ";
	const local = `## Alpha\n${alpha.repeat(2)}\n\n## Beta\n${beta.repeat(2)}\n`;
	const remote = `## Beta\n${beta.repeat(2)}\n\n## Alpha\n${alpha.repeat(2)}\n`;
	const result = mergeConflict(local, remote, 2000, 1000);
	assert.ok(
		result.indexOf("## Alpha") < result.indexOf("## Beta"),
		"spine (local/newer) order should be preserved"
	);
});

// ─── Realistic daily note ─────────────────────────────────────────────────────

console.log("\nRealistic daily note");

const BASE_NOTE =
	"---\ntitle: 2026-03-27\ndate: 2026-03-27\ntags: [daily]\n---\n\n" +
	"## Schedule\n- 09:00 Meeting with team\n- 10:00 Deep work\n- 14:00 Standup\n\n" +
	"## Notes\n- Bought groceries\n- Called mom\n\n" +
	"## Email Briefing\n- Replied to Sarah about project timeline\n- Archived 12 newsletters\n";

test("small local edit: local change preserved, no triple newlines", () => {
	const local = BASE_NOTE.replace("14:00 Standup", "14:00 Standup (moved to 14:30)");
	const result = mergeConflict(local, BASE_NOTE, 2000, 1000);
	assert.ok(result.includes("14:30"), "local edit should be preserved");
	assert.ok(!result.includes("\n\n\n"), "no triple newlines");
});

test("remote added new section: appears in output after existing sections", () => {
	const remote = BASE_NOTE + "\n## Workout Log\n- Squat 3x5 225lbs\n- Deadlift 1x5 315lbs\n";
	const result = mergeConflict(BASE_NOTE, remote, 2000, 1000);
	assert.ok(result.includes("## Workout Log"), "remote-added section should appear");
	assert.ok(result.includes("315lbs"), "remote section content should appear");
});

test("section order preserved in realistic note", () => {
	const result = mergeConflict(BASE_NOTE, BASE_NOTE, 1000, 1000);
	const scheduleIdx = result.indexOf("## Schedule");
	const notesIdx = result.indexOf("## Notes");
	const emailIdx = result.indexOf("## Email Briefing");
	assert.ok(scheduleIdx < notesIdx, "## Schedule before ## Notes");
	assert.ok(notesIdx < emailIdx, "## Notes before ## Email Briefing");
});

// ─── Stability: merge twice ───────────────────────────────────────────────────

console.log("\nMerge stability");

test("merge(A, B) applied again with B is stable", () => {
	const A = BASE_NOTE.replace("14:00 Standup", "14:00 Standup (moved to 14:30)");
	const B = BASE_NOTE;
	const merged1 = mergeConflict(A, B, 2000, 1000);
	const merged2 = mergeConflict(merged1, B, 2000, 1000);
	assert.equal(
		merged2, merged1,
		"second merge with same remote should produce identical output"
	);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
