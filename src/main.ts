import { Plugin } from "obsidian";
import { WebDAVSyncSettings, DEFAULT_SETTINGS, WebDAVSyncSettingTab } from "settings";
import { SyncEngine } from "sync";

export default class WebDAVSyncPlugin extends Plugin {
	settings: WebDAVSyncSettings = DEFAULT_SETTINGS;
	pluginData: Record<string, unknown> = {};
	syncEngine!: SyncEngine;
	statusBarItem!: HTMLElement;
	paused = true; // start paused — user must explicitly resume
	private pollIntervalId: number | undefined;

	async onload() {
		this.pluginData = ((await this.loadData()) as Record<string, unknown>) ?? {};
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			this.pluginData["settings"] as Partial<WebDAVSyncSettings>
		);
		// Restore paused state across reloads; default true
		this.paused = (this.pluginData["paused"] as boolean) ?? true;

		this.syncEngine = new SyncEngine(this);
		await this.syncEngine.init();

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();
		this.statusBarItem.onClickEvent(() => this.togglePause());

		this.addRibbonIcon("refresh-cw", "Sync now", () => {
			if (!this.paused) this.syncEngine.requestSync();
		});

		this.addSettingTab(new WebDAVSyncSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (!this.paused) this.syncEngine.requestSync();
		});

		let debounceTimer: number | undefined;
		this.registerEvent(
			this.app.vault.on("modify", () => {
				if (this.paused) return;
				if (this.syncEngine.suppressNextModifyTrigger) {
					this.syncEngine.suppressNextModifyTrigger = false;
					return;
				}
				window.clearTimeout(debounceTimer);
				debounceTimer = window.setTimeout(() => this.syncEngine.requestSync(), 5000);
			})
		);

		this.resetPollInterval();
	}

	togglePause() {
		this.paused = !this.paused;
		this.pluginData["paused"] = this.paused;
		this.updateStatusBar();
		if (!this.paused) {
			// Don't call saveData here: the sync will call stateManager.save() at the
			// end, which persists pluginData (including the updated paused flag).
			// Calling saveData() here before the sync runs races with stateManager.save()
			// and can overwrite fresh syncState with a stale snapshot on disk.
			this.syncEngine.requestSync();
		} else {
			// When pausing, no new sync starts, so explicitly persist the paused flag.
			this.saveData(this.pluginData);
		}
	}

	updateStatusBar() {
		if (this.paused) {
			this.statusBarItem.setText("WebDAV: Paused");
		} else {
			this.syncEngine.setStatus("Ready");
		}
	}

	resetPollInterval() {
		if (this.pollIntervalId !== undefined) {
			window.clearInterval(this.pollIntervalId);
		}
		this.pollIntervalId = window.setInterval(() => {
			if (!this.paused && document.visibilityState === "visible") {
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
