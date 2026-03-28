/**
 * Minimal runtime stub for the `obsidian` package, used only in tests.
 * The real obsidian package is types-only (no JS) and unavailable outside the plugin host.
 */

export class TFile {
	path: string = "";
}

export class FileSystemAdapter {}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/\/+/g, "/").replace(/\/$/, "") || "/";
}

// Used by webdav.ts at module load time; never called if the WebDAV client is injected.
export function requestUrl(_opts: unknown): Promise<unknown> {
	return Promise.reject(new Error("requestUrl stub called — inject a mock WebDAVClient"));
}

export type RequestUrlResponse = { status: number; text: string };
