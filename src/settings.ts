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

		new Setting(containerEl)
			.setName("Excluded paths")
			.setDesc("One prefix per line. E.g. '_Attachments/' excludes that top-level folder.")
			.addTextArea(text =>
				text
					.setValue(this.plugin.settings.excludedPaths.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedPaths = value
							.split("\n")
							.map(s => s.trim())
							.filter(s => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

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

		// ── Danger zone ──────────────────────────────────────────────────────

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

		// ── Sync log ──────────────────────────────────────────────────────────

		new Setting(containerEl)
			.setName("Sync log")
			.setDesc(`Last ${LOG_TAIL_LINES} entries`)
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

		this.logEl = containerEl.createEl("pre", {
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
