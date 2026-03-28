import { Plugin } from "obsidian";
import { WebDAVSyncSettings, DEFAULT_SETTINGS, WebDAVSyncSettingTab } from "settings";
import { SyncEngine } from "sync";

export default class WebDAVSyncPlugin extends Plugin {
	settings: WebDAVSyncSettings = DEFAULT_SETTINGS;
	// Single canonical data object — loaded once from disk at startup.
	// All reads/writes go through this object; saveData() is the only disk write.
	pluginData: Record<string, unknown> = {};
	syncEngine!: SyncEngine;
	statusBarItem!: HTMLElement;
	private pollIntervalId: number | undefined;

	async onload() {
		// Single disk read
		this.pluginData = ((await this.loadData()) as Record<string, unknown>) ?? {};
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			this.pluginData["settings"] as Partial<WebDAVSyncSettings>
		);

		this.syncEngine = new SyncEngine(this);
		await this.syncEngine.init();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("WebDAV: Ready");
		this.statusBarItem.onClickEvent(() => this.syncEngine.requestSync());

		this.addRibbonIcon("refresh-cw", "Sync now", () => this.syncEngine.requestSync());

		this.addSettingTab(new WebDAVSyncSettingTab(this.app, this));

		// Sync on layout ready
		this.app.workspace.onLayoutReady(() => this.syncEngine.requestSync());

		// Sync on file modify (debounced 5s)
		let debounceTimer: number | undefined;
		this.registerEvent(
			this.app.vault.on("modify", () => {
				if (this.syncEngine.suppressNextModifyTrigger) {
					this.syncEngine.suppressNextModifyTrigger = false;
					return;
				}
				window.clearTimeout(debounceTimer);
				debounceTimer = window.setTimeout(() => this.syncEngine.requestSync(), 5000);
			})
		);

		// Foreground poll
		this.resetPollInterval();
	}

	resetPollInterval() {
		if (this.pollIntervalId !== undefined) {
			window.clearInterval(this.pollIntervalId);
		}
		this.pollIntervalId = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				this.syncEngine.requestSync();
			}
		}, this.settings.pollIntervalSec * 1000);
	}

	async onunload() {
		if (this.pollIntervalId !== undefined) {
			window.clearInterval(this.pollIntervalId);
		}
		await this.syncEngine.stateManager.save();
	}

	async saveSettings() {
		this.pluginData["settings"] = this.settings;
		await this.saveData(this.pluginData);
		this.syncEngine?.rebuildClient();
	}
}
