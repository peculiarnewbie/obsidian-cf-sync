import { Notice, Plugin } from "obsidian";
import {
  DeviceEnrollmentResponse as DeviceEnrollmentResponseSchema,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";
import { DEFAULT_SETTINGS, type PluginSettings, SyncSettingTab } from "./settings";
import { SyncEngine } from "./sync-engine";

export default class ObsidianCfSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  syncEngine: SyncEngine | null = null;
  private loaded = false;
  private settingsPass: Promise<void> = Promise.resolve();
  private engineSettingsKey = "";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.loaded = true;

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
          `Sync: ${this.syncEngine?.active ? "active" : "inactive"}\nDevice: ${this.settings.deviceId}`,
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
    this.loaded = false;
    void this.syncEngine?.shutdown();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    const snapshot = {
      ...this.settings,
      workerUrl: this.settings.workerUrl.trim().replace(/\/+$/, ""),
    };
    const work = this.settingsPass.then(async () => {
      await this.saveData(snapshot);
      if (this.loaded) await this.applySettings(snapshot);
    });
    this.settingsPass = work.catch((error: unknown) => {
      console.error("Unable to apply sync settings", error);
      new Notice("Unable to apply sync settings; check the Worker URL and pairing");
    });
    await this.settingsPass;
  }

  private async applySettings(settings: PluginSettings): Promise<void> {
    const key = JSON.stringify([
      settings.workerUrl,
      settings.vaultId,
      settings.deviceId,
      settings.deviceToken,
      settings.enabled,
      settings.syncInterval,
    ]);
    if (key === this.engineSettingsKey && this.syncEngine?.active) return;
    await this.syncEngine?.shutdown();
    this.syncEngine = null;
    this.engineSettingsKey = key;
    if (
      !settings.enabled ||
      !settings.workerUrl ||
      !settings.vaultId ||
      !settings.deviceToken ||
      !this.loaded
    )
      return;
    this.syncEngine = new SyncEngine(this.app, settings);
    await this.syncEngine.start();
  }

  async enrollDevice(): Promise<void> {
    if (!this.settings.workerUrl || !this.settings.apiKey || !this.settings.vaultId) {
      new Notice("Configure worker URL, vault ID, and API key before pairing");
      return;
    }

    const pairing = { ...this.settings };
    const resp = await fetch(`${pairing.workerUrl.trim().replace(/\/+$/, "")}/devices/enroll`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pairing.apiKey}`,
        "X-Vault-Id": pairing.vaultId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceId: pairing.deviceId,
        name: this.app.vault.getName(),
        platform: navigator.userAgent.includes("Mobile") ? "mobile" : "desktop",
      }),
    });

    if (!resp.ok) {
      new Notice(`Device pairing failed: ${resp.status}`);
      return;
    }

    const enrollment = decodeUnknownSync(DeviceEnrollmentResponseSchema)(await resp.json());
    if (
      pairing.workerUrl !== this.settings.workerUrl ||
      pairing.vaultId !== this.settings.vaultId ||
      pairing.deviceId !== this.settings.deviceId ||
      !this.loaded
    ) {
      new Notice("Pairing settings changed; pair again using the current settings");
      return;
    }
    this.settings.apiKey = "";
    this.settings.deviceId = enrollment.deviceId;
    this.settings.deviceToken = enrollment.deviceToken;
    await this.saveSettings();
    new Notice("Device paired");
  }

  private async startSync(): Promise<void> {
    if (!this.settings.enabled) {
      new Notice("Enable sync in settings first");
      return;
    }
    if (!this.settings.workerUrl || !this.settings.vaultId || !this.settings.deviceToken) {
      new Notice("Configure worker URL and vault ID, then pair this device first");
      return;
    }
    await this.saveSettings();
    await this.syncEngine?.syncNow();
  }
}
