import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidianCfSyncPlugin from "./main";

export interface PluginSettings {
  workerUrl: string;
  apiKey: string;
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  syncInterval: number;
  enabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  workerUrl: "",
  apiKey: "",
  vaultId: "default",
  deviceId: "",
  deviceToken: "",
  syncInterval: 2000,
  enabled: true,
};

export class SyncSettingTab extends PluginSettingTab {
  plugin: ObsidianCfSyncPlugin;

  constructor(app: App, plugin: ObsidianCfSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian CF Sync" });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("The Cloudflare Worker endpoint URL")
      .addText((text) =>
        text
          .setPlaceholder("https://obsidian-cf-sync.your-subdomain.workers.dev")
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (value) => {
            this.plugin.settings.workerUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Stable vault identifier used to isolate this vault on the Worker")
      .addText((text) =>
        text
          .setPlaceholder("personal-vault")
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc(
        "Bootstrap key used to enroll this device. Sync uses the device token after pairing.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Device token")
      .setDesc(
        this.plugin.settings.deviceToken
          ? "This device is paired and has a sync token."
          : "Pair this device to receive a sync token.",
      )
      .addButton((button) =>
        button
          .setButtonText(this.plugin.settings.deviceToken ? "Re-pair device" : "Pair device")
          .setCta()
          .onClick(async () => {
            await this.plugin.enrollDevice();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Sync enabled")
      .setDesc("Enable automatic vault synchronization")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (ms)")
      .setDesc("Debounce interval for rapid edits")
      .addText((text) =>
        text
          .setPlaceholder("2000")
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 500) {
              this.plugin.settings.syncInterval = num;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
