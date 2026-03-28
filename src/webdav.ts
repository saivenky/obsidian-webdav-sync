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

	private async request(
		method: string,
		path: string,
		body?: string,
		extraHeaders?: Record<string, string>
	): Promise<Response> {
		const url = this.baseUrl.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const res = await fetch(url, {
				method,
				headers: {
					Authorization: this.authHeader(),
					...extraHeaders,
				},
				body,
				signal: controller.signal,
			});
			return res;
		} catch (e) {
			if ((e as Error).name === "AbortError") {
				throw new WebDAVError("Request timed out: " + path);
			}
			throw new WebDAVError("Network error: " + (e as Error).message);
		} finally {
			window.clearTimeout(timer);
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

		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("xml") && !ct.includes("multistatus")) {
			throw new WebDAVError("PROPFIND unexpected content-type: " + ct);
		}

		const xml = await res.text();
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		const NS = "DAV:";
		const responses = Array.from(doc.getElementsByTagNameNS(NS, "response"));
		const basePrefix = this.baseUrl.replace(/\/$/, "");

		return responses.map(r => {
			const href = r.getElementsByTagNameNS(NS, "href")[0]?.textContent ?? "";
			// Strip base URL prefix and leading slash to get vault-relative path
			let vaultPath = href.startsWith(basePrefix)
				? href.slice(basePrefix.length)
				: href;
			vaultPath = vaultPath.replace(/^\//, "");

			const lastModified = r.getElementsByTagNameNS(NS, "getlastmodified")[0]?.textContent ?? "";
			const mtime = lastModified ? Date.parse(lastModified) : 0;
			const isDir = r.getElementsByTagNameNS(NS, "collection").length > 0;

			return { path: vaultPath, mtime, isDir };
		}).filter(e => e.path.length > 0);
	}

	async get(path: string): Promise<string> {
		const res = await this.request("GET", path);
		if (!res.ok) throw new WebDAVError("GET failed: " + path, res.status);
		return res.text();
	}

	async put(path: string, content: string): Promise<void> {
		const res = await this.request("PUT", path, content, {
			"Content-Type": "text/plain; charset=utf-8",
		});
		if (!res.ok && res.status !== 201 && res.status !== 204) {
			throw new WebDAVError("PUT failed: " + path, res.status);
		}
	}

	async delete(path: string): Promise<void> {
		const res = await this.request("DELETE", path);
		// 404 is acceptable — idempotent delete
		if (!res.ok && res.status !== 404) {
			throw new WebDAVError("DELETE failed: " + path, res.status);
		}
	}

	async mkcol(path: string): Promise<void> {
		const res = await this.request("MKCOL", path);
		// 405 Method Not Allowed usually means it already exists
		if (!res.ok && res.status !== 405) {
			throw new WebDAVError("MKCOL failed: " + path, res.status);
		}
	}
}
