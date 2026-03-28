import { App, PluginSettingTab, Setting } from "obsidian";
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

export class WebDAVSyncSettingTab extends PluginSettingTab {
	plugin: WebDAVSyncPlugin;

	constructor(app: App, plugin: WebDAVSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
	}
}
