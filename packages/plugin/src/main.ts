import { Notice, Plugin } from "obsidian";
import {
  DeviceEnrollmentResponse as DeviceEnrollmentResponseSchema,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";
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
      this.settings.vaultId &&
      this.settings.deviceToken
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

  async enrollDevice(): Promise<void> {
    if (!this.settings.workerUrl || !this.settings.apiKey || !this.settings.vaultId) {
      new Notice("Configure worker URL, vault ID, and API key before pairing");
      return;
    }

    const resp = await fetch(`${this.settings.workerUrl}/devices/enroll`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "X-Vault-Id": this.settings.vaultId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceId: this.settings.deviceId,
        name: this.app.vault.getName(),
        platform: navigator.userAgent.includes("Mobile") ? "mobile" : "desktop",
      }),
    });

    if (!resp.ok) {
      new Notice(`Device pairing failed: ${resp.status}`);
      return;
    }

    const enrollment = decodeUnknownSync(DeviceEnrollmentResponseSchema)(await resp.json());
    this.settings.deviceId = enrollment.deviceId;
    this.settings.deviceToken = enrollment.deviceToken;
    await this.saveSettings();
    new Notice("Device paired");
  }

  private async startSync(): Promise<void> {
    if (!this.settings.workerUrl || !this.settings.vaultId || !this.settings.deviceToken) {
      new Notice("Configure worker URL and vault ID, then pair this device first");
      return;
    }

    this.syncEngine?.stop();
    this.syncEngine = new SyncEngine(this.app, this.settings);
    await this.syncEngine.start();
    new Notice("Sync started");
  }
}
