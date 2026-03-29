import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type WebDAVSyncPlugin from "main";

export interface WebDAVSyncSettings {
	serverUrl: string;
	username: string;
	password: string;
	excludedPaths: string[];
	pollIntervalSec: number;
	requestTimeoutMs: number;
}

export const DEFAULT_SETTINGS: WebDAVSyncSettings = {
	serverUrl: "",
	username: "",
	password: "",
	excludedPaths: [".git/", "_Attachments/", ".obsidian/"],
	pollIntervalSec: 10,
	requestTimeoutMs: 8000,
};

const LOG_PATH = ".obsidian/plugins/obsidian-webdav-sync/sync-log.txt";
const LOG_TAIL_LINES = 50;

export class WebDAVSyncSettingTab extends PluginSettingTab {
	plugin: WebDAVSyncPlugin;
	private logEl: HTMLPreElement | null = null;

	constructor(app: App, plugin: WebDAVSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Pause / Resume ───────────────────────────────────────────────────

		new Setting(containerEl)
			.setName("Sync")
			.setDesc(this.plugin.paused ? "Sync is paused. Click Resume to start syncing." : "Sync is active.")
			.addButton(btn => {
				btn
					.setButtonText(this.plugin.paused ? "Resume" : "Pause")
					.setCta()
					.onClick(() => {
						this.plugin.togglePause();
						this.display(); // re-render to update label
					});
			});

		// ── Connection ───────────────────────────────────────────────────────

		containerEl.createEl("h3", { text: "Connection" });

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("WebDAV server base URL (e.g. http://100.x.x.x:8080)")
			.addText(text =>
				text
					.setPlaceholder("http://100.x.x.x:8080")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Username")
			.addText(text =>
				text
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Password")
			.addText(text => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.plugin.settings.password = value;
						await this.plugin.saveSettings();
					});
			});

		// ── Sync ─────────────────────────────────────────────────────────────

		containerEl.createEl("h3", { text: "Sync" });

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc("How often to check for remote changes when the app is visible.")
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.pollIntervalSec))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.pollIntervalSec = n;
							await this.plugin.saveSettings();
							this.plugin.resetPollInterval();
						}
					})
			);

		new Setting(containerEl)
			.setName("Request timeout (ms)")
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.requestTimeoutMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.requestTimeoutMs = n;
							await this.plugin.saveSettings();
						}
					})
			);

		// ── Excluded paths ───────────────────────────────────────────────────

		containerEl.createEl("h3", { text: "Excluded paths" });
		containerEl.createEl("p", {
			text: "Folder/ excludes a top-level folder. **/name excludes any folder named name anywhere in the tree.",
		});

		this.renderExcludedList(containerEl);

		// ── Danger zone ──────────────────────────────────────────────────────

		containerEl.createEl("h3", { text: "Danger zone" });

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc("Wipes the local sync baseline. Next sync will re-bootstrap all files from scratch (no conflict merges).")
			.addButton(btn =>
				btn
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await this.plugin.syncEngine.resetState();
						new Notice("Sync state reset. Next sync will re-bootstrap from scratch.");
					})
			);

		new Setting(containerEl)
			.setName("Clean up encoding artifacts")
			.setDesc("Deletes all local files whose path contains '%' (URL-encoded duplicates from a sync bug). Removes from remote too if present.")
			.addButton(btn =>
				btn
					.setButtonText("Clean up")
					.setWarning()
					.onClick(async () => {
						const count = await this.plugin.syncEngine.deleteEncodingArtifacts();
						new Notice(`Deleted ${count} encoding artifact${count === 1 ? "" : "s"}.`);
						await this.refreshLog();
					})
			);

		// ── Sync log ──────────────────────────────────────────────────────────

		const details = containerEl.createEl("details");
		details.setAttribute("open", "");
		details.createEl("summary", { text: "Sync log" });

		new Setting(details)
			.addButton(btn =>
				btn
					.setButtonText("Sync now")
					.onClick(async () => {
						await this.plugin.syncEngine.requestSync();
						await this.refreshLog();
					})
			)
			.addButton(btn =>
				btn
					.setButtonText("Refresh")
					.onClick(() => this.refreshLog())
			)
			.addButton(btn =>
				btn
					.setButtonText("Clear")
					.setWarning()
					.onClick(async () => {
						await this.plugin.app.vault.adapter.write(LOG_PATH, "");
						await this.refreshLog();
					})
			);

		this.logEl = details.createEl("pre", {
			attr: {
				style: [
					"font-size: 11px",
					"line-height: 1.4",
					"max-height: 300px",
					"overflow-y: auto",
					"padding: 8px",
					"border-radius: 4px",
					"white-space: pre-wrap",
					"word-break: break-all",
					"background: var(--background-secondary)",
					"color: var(--text-muted)",
					"margin-top: 4px",
				].join(";"),
			},
		});

		this.refreshLog();
	}

	private renderExcludedList(containerEl: HTMLElement): void {
		const listEl = containerEl.createEl("div");

		const renderRow = (rule: string, index: number): void => {
			const row = listEl.createEl("div", {
				attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:4px;" },
			});
			row.createEl("span", {
				text: rule,
				attr: { style: "font-family:monospace;flex:1;font-size:13px;" },
			});
			const removeBtn = row.createEl("button", { text: "×" });
			removeBtn.addEventListener("click", async () => {
				this.plugin.settings.excludedPaths.splice(index, 1);
				await this.plugin.saveSettings();
				row.remove();
				// Re-index remaining rows by re-rendering (list is typically short)
				listEl.empty();
				this.plugin.settings.excludedPaths.forEach((r, i) => renderRow(r, i));
				listEl.appendChild(addRow);
			});
		};

		this.plugin.settings.excludedPaths.forEach((rule, i) => renderRow(rule, i));

		const addRow = listEl.createEl("div", {
			attr: { style: "display:flex;align-items:center;gap:8px;margin-top:8px;" },
		});
		const input = addRow.createEl("input", {
			attr: {
				type: "text",
				placeholder: "e.g. Folder/ or **/__pycache__",
				style: "flex:1;",
			},
		}) as HTMLInputElement;
		const addBtn = addRow.createEl("button", { text: "Add" });

		const addRule = async (): Promise<void> => {
			const value = input.value.trim();
			if (!value || this.plugin.settings.excludedPaths.includes(value)) {
				input.value = "";
				return;
			}
			this.plugin.settings.excludedPaths.push(value);
			await this.plugin.saveSettings();
			listEl.empty();
			this.plugin.settings.excludedPaths.forEach((r, i) => renderRow(r, i));
			listEl.appendChild(addRow);
			input.value = "";
		};

		addBtn.addEventListener("click", addRule);
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") addRule();
		});
	}

	private async refreshLog(): Promise<void> {
		if (!this.logEl) return;

		let text = "";
		try {
			text = await this.plugin.app.vault.adapter.read(LOG_PATH);
		} catch {
			text = "(no log yet)";
		}

		const lines = text.split("\n").filter(l => l.trim().length > 0);
		const tail = lines.slice(-LOG_TAIL_LINES);

		// Colour ERROR lines red, CONFLICT orange
		this.logEl.empty();
		for (const line of tail) {
			const span = this.logEl.createEl("span");
			if (line.includes(" ERROR ")) {
				span.style.color = "var(--text-error)";
			} else if (line.includes(" CONFLICT ")) {
				span.style.color = "var(--color-orange)";
			}
			span.setText(line + "\n");
		}

		// Scroll to bottom
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}
}
