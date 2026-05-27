import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings, SyncSettingTab } from "./settings";
import { SyncEngine } from "./sync-engine";

export default class ObsidianCfSyncPlugin extends Plugin {
  settings: PluginSettings;
  syncEngine: SyncEngine | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.startSync(),
    });

    this.addCommand({
      id: "sync-status",
      name: "Show sync status",
      callback: () => {
        new Notice(
          `Sync: ${this.syncEngine ? "active" : "inactive"}\nDevice: ${this.settings.deviceId}`,
        );
      },
    });

    if (
      this.settings.enabled &&
      this.settings.workerUrl &&
      this.settings.apiKey &&
      this.settings.vaultId
    ) {
      await this.startSync();
    }
  }

  onunload(): void {
    this.syncEngine?.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async startSync(): Promise<void> {
    if (!this.settings.workerUrl || !this.settings.apiKey || !this.settings.vaultId) {
      new Notice("Configure worker URL, vault ID, and API key in settings first");
      return;
    }

    this.syncEngine?.stop();
    this.syncEngine = new SyncEngine(this.app, this.settings);
    await this.syncEngine.start();
    new Notice("Sync started");
  }
}
