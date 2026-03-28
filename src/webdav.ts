import { requestUrl, RequestUrlResponse } from "obsidian";

export interface PropfindEntry {
	path: string;   // vault-relative, e.g. "Daily/2026-03-27.md"
	mtime: number;  // Unix ms
	isDir: boolean;
}

export class WebDAVError extends Error {
	statusCode?: number;
	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "WebDAVError";
		this.statusCode = statusCode;
	}
}

export class WebDAVClient {
	constructor(
		private baseUrl: string,
		private username: string,
		private password: string,
		private timeoutMs: number
	) {}

	private authHeader(): string {
		return "Basic " + btoa(this.username + ":" + this.password);
	}

	private buildUrl(path: string): string {
		const base = this.baseUrl.replace(/\/$/, "");
		const encoded = path
			.split("/")
			.map(seg => encodeURIComponent(seg))
			.join("/");
		return base + "/" + encoded;
	}

	private async request(
		method: string,
		path: string,
		body?: string,
		extraHeaders?: Record<string, string>
	): Promise<RequestUrlResponse> {
		const url = this.buildUrl(path);

		const timeout = new Promise<never>((_, reject) =>
			window.setTimeout(
				() => reject(new WebDAVError("Request timed out: " + path)),
				this.timeoutMs
			)
		);

		try {
			const res = await Promise.race([
				requestUrl({
					url,
					method,
					headers: {
						Authorization: this.authHeader(),
						...extraHeaders,
					},
					body,
					throw: false,
				}),
				timeout,
			]);
			return res;
		} catch (e) {
			if (e instanceof WebDAVError) throw e;
			throw new WebDAVError("Network error: " + (e as Error).message);
		}
	}

	async propfind(path: string, depth: "0" | "1"): Promise<PropfindEntry[]> {
		const res = await this.request(
			"PROPFIND",
			path,
			`<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/><D:resourcetype/></D:prop></D:propfind>`,
			{
				"Depth": depth,
				"Content-Type": "application/xml",
			}
		);

		if (res.status !== 207) {
			throw new WebDAVError("PROPFIND failed: " + path, res.status);
		}

		const xml = res.text;
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		const NS = "DAV:";
		const responses = Array.from(doc.getElementsByTagNameNS(NS, "response"));
		const basePrefix = this.baseUrl.replace(/\/$/, "");

		return responses.map(r => {
			const href = r.getElementsByTagNameNS(NS, "href")[0]?.textContent ?? "";
			let vaultPath = href.startsWith(basePrefix)
				? href.slice(basePrefix.length)
				: href;
			vaultPath = vaultPath.replace(/^\//, "");
			try {
				vaultPath = decodeURIComponent(vaultPath);
			} catch {
				// malformed URI — use as-is
			}

			const lastModified = r.getElementsByTagNameNS(NS, "getlastmodified")[0]?.textContent ?? "";
			const mtime = lastModified ? Date.parse(lastModified) : 0;
			const isDir = r.getElementsByTagNameNS(NS, "collection").length > 0;

			return { path: vaultPath, mtime, isDir };
		}).filter(e => e.path.length > 0);
	}

	async get(path: string): Promise<string> {
		const res = await this.request("GET", path);
		if (res.status < 200 || res.status >= 300) {
			throw new WebDAVError("GET failed: " + path, res.status);
		}
		return res.text;
	}

	async put(path: string, content: string): Promise<void> {
		const res = await this.request("PUT", path, content, {
			"Content-Type": "text/plain; charset=utf-8",
		});
		if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
			throw new WebDAVError("PUT failed: " + path, res.status);
		}
	}

	async delete(path: string): Promise<void> {
		const res = await this.request("DELETE", path);
		if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
			throw new WebDAVError("DELETE failed: " + path, res.status);
		}
	}

	async mkcol(path: string): Promise<void> {
		const res = await this.request("MKCOL", path);
		// 405 Method Not Allowed usually means it already exists
		if (res.status !== 200 && res.status !== 201 && res.status !== 405) {
			throw new WebDAVError("MKCOL failed: " + path, res.status);
		}
	}
}
