export class App {}

export class Notice {
  constructor(_message: string) {}
}

export class TFile {
  path = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}
