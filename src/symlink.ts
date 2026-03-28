import fs from "fs";

/**
 * Returns true if absPath is a symbolic link, false otherwise.
 * Safe to call on missing paths (returns false, no throw).
 *
 * Used in decideFile to skip symlinked vault files.
 * Without this check, a symlink (e.g. CLAUDE.md → AGENTS.md) causes an
 * infinite conflict loop: writing through one path modifies the other's inode,
 * so both paths appear changed every cycle.
 */
export function isSymlink(absPath: string): boolean {
	try {
		return fs.lstatSync(absPath).isSymbolicLink();
	} catch {
		return false;
	}
}
