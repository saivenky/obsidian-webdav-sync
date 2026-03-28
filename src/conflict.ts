export const FRONTMATTER_SENTINEL = "__frontmatter__";

export interface Section {
	header: string;
	content: string;
}

export function parseFile(text: string): Section[] {
	const sections: Section[] = [];

	let body = text;

	// Extract YAML frontmatter block
	if (body.startsWith("---\n")) {
		const end = body.indexOf("\n---", 4);
		if (end !== -1) {
			const fmContent = body.slice(0, end + 4);
			sections.push({ header: FRONTMATTER_SENTINEL, content: fmContent });
			// Do NOT strip the leading \n here — the whitespace after closing ---
			// belongs to the preamble section and preserves the gap before the first heading.
			body = body.slice(end + 4);
		}
	}

	// Split remainder on ## headings.
	// Keep parts[0] even when whitespace-only: it encodes the gap between
	// frontmatter and the first ## heading (e.g. "\n\n" = one blank line).
	const parts = body.split(/^(## .+)$/m);
	if (parts[0] !== undefined && parts[0].length > 0) {
		sections.push({ header: "", content: parts[0] });
	}

	for (let i = 1; i + 1 < parts.length; i += 2) {
		const header = parts[i] ?? "";
		const content = (parts[i + 1] ?? "").replace(/^\n/, "");
		sections.push({ header, content });
	}

	return sections;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/\W+/)
			.filter(t => t.length > 3)
	);
}

function jaccard(a: string, b: string): number {
	const ta = tokenize(a);
	const tb = tokenize(b);
	if (ta.size === 0 && tb.size === 0) return 1;
	if (ta.size === 0 || tb.size === 0) return 0;
	let intersection = 0;
	for (const t of ta) {
		if (tb.has(t)) intersection++;
	}
	return intersection / (ta.size + tb.size - intersection);
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(w => w.length > 0).length;
}

interface Pair {
	local: Section | null;
	remote: Section | null;
}

function matchSections(localSecs: Section[], remoteSecs: Section[]): Pair[] {
	const pairs: Pair[] = [];
	const unmatchedLocal = new Set(localSecs.map((_, i) => i));
	const unmatchedRemote = new Set(remoteSecs.map((_, i) => i));

	// Pass 1: exact header match
	for (const [li, ls] of localSecs.entries()) {
		for (const [ri, rs] of remoteSecs.entries()) {
			if (!unmatchedLocal.has(li) || !unmatchedRemote.has(ri)) continue;
			if (ls.header === rs.header) {
				pairs.push({ local: ls, remote: rs });
				unmatchedLocal.delete(li);
				unmatchedRemote.delete(ri);
			}
		}
	}

	// Pass 2: fuzzy match on remaining
	const localLeft = [...unmatchedLocal].map(i => ({ i, s: localSecs[i]! }));
	const remoteLeft = [...unmatchedRemote].map(i => ({ i, s: remoteSecs[i]! }));

	interface Candidate {
		li: number; ri: number; score: number; posDiff: number;
	}
	const candidates: Candidate[] = [];

	for (const { i: li, s: ls } of localLeft) {
		if (wordCount(ls.content) < 30) continue;
		for (const { i: ri, s: rs } of remoteLeft) {
			if (wordCount(rs.content) < 30) continue;
			const score = jaccard(ls.content, rs.content);
			if (score >= 0.6) {
				candidates.push({ li, ri, score, posDiff: Math.abs(li - ri) });
			}
		}
	}

	// Sort by score desc, then posDiff asc
	candidates.sort((a, b) => b.score - a.score || a.posDiff - b.posDiff);

	const usedLocal = new Set<number>();
	const usedRemote = new Set<number>();

	for (const { li, ri } of candidates) {
		if (usedLocal.has(li) || usedRemote.has(ri)) continue;
		pairs.push({ local: localSecs[li]!, remote: remoteSecs[ri]! });
		usedLocal.add(li);
		usedRemote.add(ri);
		unmatchedLocal.delete(li);
		unmatchedRemote.delete(ri);
	}

	// Remaining unmatched
	for (const i of unmatchedLocal) {
		pairs.push({ local: localSecs[i]!, remote: null });
	}
	for (const i of unmatchedRemote) {
		pairs.push({ local: null, remote: remoteSecs[i]! });
	}

	return pairs;
}

export function mergeConflict(
	local: string,
	remote: string,
	localMtime: number,
	remoteMtime: number
): string {
	const localSecs = parseFile(local);
	const remoteSecs = parseFile(remote);
	const pairs = matchSections(localSecs, remoteSecs);
	const newerIsLocal = localMtime >= remoteMtime;
	const spine = newerIsLocal ? localSecs : remoteSecs;

	// Build a lookup from section object to its pair
	const pairBySection = new Map<Section, Pair>();
	for (const pair of pairs) {
		if (pair.local) pairBySection.set(pair.local, pair);
		if (pair.remote) pairBySection.set(pair.remote, pair);
	}

	// Track which remote/local sections have been emitted
	const emitted = new Set<Section>();
	const output: string[] = [];

	for (const spineSection of spine) {
		const pair = pairBySection.get(spineSection);

		if (!pair) {
			// Unmatched in newer — keep as-is
			emitSection(spineSection, output, emitted);
			continue;
		}

		const other = newerIsLocal ? pair.remote : pair.local;

		if (!other) {
			// Only in newer file
			emitSection(spineSection, output, emitted);
		} else if (spineSection.header === FRONTMATTER_SENTINEL) {
			// Frontmatter merge
			if (jaccard(spineSection.content, other.content) >= 0.6) {
				emitSection(spineSection, output, emitted);
				emitted.add(other);
			} else {
				const merged = mergeFrontmatter(spineSection.content, other.content, newerIsLocal);
				output.push(merged);
				emitted.add(spineSection);
				emitted.add(other);
			}
		} else {
			const score = jaccard(spineSection.content, other.content);
			if (score >= 0.6) {
				// Similar enough — keep newer
				emitSection(spineSection, output, emitted);
				emitted.add(other);
			} else {
				// Diverged — emit both (newer first)
				emitSection(spineSection, output, emitted);
				emitSection(other, output, emitted);
			}
		}
	}

	// Emit unmatched sections from older file that weren't emitted yet
	const older = newerIsLocal ? remoteSecs : localSecs;
	for (const sec of older) {
		if (!emitted.has(sec)) {
			emitSection(sec, output, emitted);
		}
	}

	// join("") — section content's own trailing newlines are the separators.
	// No fixed separator is added; spacing is preserved exactly as parsed.
	return output.join("");
}

function emitSection(sec: Section, output: string[], emitted: Set<Section>): void {
	if (emitted.has(sec)) return;
	emitted.add(sec);
	// Do NOT strip trailing newlines — section content's trailing whitespace
	// IS the separator before the next section. join("") preserves it exactly.
	if (sec.header === FRONTMATTER_SENTINEL || sec.header === "") {
		output.push(sec.content);
	} else {
		output.push(sec.header + "\n" + sec.content);
	}
}

function mergeFrontmatter(newer: string, older: string, _newerIsLocal: boolean): string {
	const extractLines = (block: string): string[] =>
		block
			.split("\n")
			.filter(l => l !== "---")
			.map(l => l.trim())
			.filter(l => l.length > 0);

	const newerLines = extractLines(newer);
	const olderLines = extractLines(older);

	// Union, deduped, newer first
	const seen = new Set<string>(newerLines);
	const combined = [...newerLines];
	for (const l of olderLines) {
		if (!seen.has(l)) {
			combined.push(l);
			seen.add(l);
		}
	}

	return "---\n" + combined.join("\n") + "\n---";
}
