export class App {}

export class Notice {
  constructor(_message: string) {}
}

export class TFile {
  path = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class Plugin {
  private data: unknown;
  constructor(readonly app: unknown) {}
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(data: unknown): Promise<void> {
    this.data = structuredClone(data);
  }
  addSettingTab(_tab: unknown): void {}
  addCommand(_command: unknown): void {}
}

export class PluginSettingTab {
  constructor(_app: unknown, _plugin: unknown) {}
}

export class Setting {}
