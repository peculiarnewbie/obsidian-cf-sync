import type { DashboardResponse, PairingKeyResponse } from "@obsidian-cf-sync/protocol";

function dashboardClient() {
  const element = (id: string) => document.getElementById(id)!;
  const form = element("select-vault") as HTMLFormElement;
  const vaultInput = element("vault") as HTMLInputElement;
  const message = element("message");
  let credentials: { key: string; vault: string } | undefined;
  let generation = 0;
  let pending = false;
  let controller = new AbortController();
  const text = (tag: string, value: string) => {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  };
  const date = (value: number | null) =>
    value === null ? "Not reported" : new Date(value).toLocaleString();
  const bytes = (value: number) =>
    value < 1024
      ? `${value} B`
      : value < 1024 * 1024
        ? `${(value / 1024).toFixed(1)} KiB`
        : `${(value / 1024 / 1024).toFixed(1)} MiB`;
  async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
    if (!credentials) throw new Error("Dashboard is still loading");
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${credentials.key}`,
        "X-Vault-Id": credentials.vault,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Pairing key not accepted"
          : `Request failed (${response.status})`,
      );
    return (await response.json()) as T;
  }
  async function refresh() {
    if (!credentials || pending) return;
    pending = true;
    const current = generation;
    try {
      const data: DashboardResponse = await api<DashboardResponse>("/admin/dashboard");
      if (current !== generation) return;
      element("dashboard").hidden = false;
      element("vault-name").textContent = credentials.vault;
      element("files").textContent = data.fileCount.toLocaleString();
      element("file-bytes").textContent = bytes(data.fileBytes);
      element("chunk-bytes").textContent = bytes(data.registeredChunkBytes);
      element("conflict-count").textContent = data.unresolvedConflictCount.toLocaleString();
      element("version").textContent = `Server change ${data.globalVersion}`;
      element("updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
      element("device-count").textContent = `${data.devices.length} of ${data.deviceCount} devices`;
      const rows = element("devices");
      rows.replaceChildren();
      for (const device of data.devices) {
        const row = document.createElement("tr");
        const identity = document.createElement("td");
        for (const node of [
          text("strong", device.name),
          text("small", device.deviceId),
          text("small", device.platform),
        ])
          identity.appendChild(node);
        const access = text(
          "td",
          device.revoked ? "Revoked" : device.connected ? "WebSocket connected" : "No WebSocket",
        );
        const activity = text("td", date(device.lastSeen));
        const progress = document.createElement("td");
        progress.appendChild(
          text(
            "span",
            device.reportedVersion === null
              ? "No progress report"
              : `Applied through ${device.reportedVersion} · ${Math.max(0, data.globalVersion - device.reportedVersion)} changes behind`,
          ),
        );
        progress.appendChild(
          text(
            "small",
            device.state === null
              ? "Older clients may not report progress"
              : `${device.state} · ${device.pendingOperations ?? 0} queued`,
          ),
        );
        progress.appendChild(text("small", date(device.reportedAt)));
        const action = document.createElement("td");
        const revoke = text("button", "Revoke") as HTMLButtonElement;
        revoke.type = "button";
        revoke.disabled = device.revoked;
        revoke.className = "quiet danger";
        revoke.addEventListener("click", async () => {
          if (
            !confirm(
              `Revoke access for ${device.name}? This closes its connections and requires pairing again.`,
            )
          )
            return;
          revoke.disabled = true;
          try {
            await api("/devices/revoke", { deviceId: device.deviceId });
            if (current !== generation) return;
            message.textContent = "Device access revoked";
            await refresh();
          } catch (error) {
            if (current !== generation) return;
            message.textContent = error instanceof Error ? error.message : "Revocation failed";
            revoke.disabled = false;
          }
        });
        action.appendChild(revoke);
        for (const node of [identity, access, activity, progress, action]) row.appendChild(node);
        rows.appendChild(row);
      }
      element("devices-empty").hidden = data.devices.length !== 0;
      const conflicts = element("conflicts");
      conflicts.replaceChildren();
      for (const conflict of data.conflicts) {
        const item = document.createElement("li");
        item.appendChild(text("strong", conflict.path));
        item.appendChild(text("small", `${date(conflict.createdAt)} · ${conflict.deviceId}`));
        conflicts.appendChild(item);
      }
      element("conflicts-empty").hidden = data.conflicts.length !== 0;
      message.textContent = "";
    } catch (error) {
      if (current === generation)
        message.textContent = error instanceof Error ? error.message : "Could not load dashboard";
    } finally {
      if (current === generation) pending = false;
    }
  }
  async function openVault() {
    generation++;
    const current = generation;
    controller.abort();
    controller = new AbortController();
    pending = false;
    credentials = undefined;
    element("dashboard").hidden = true;
    message.textContent = "Loading dashboard…";
    try {
      const response = await fetch("/admin/pairing-key", { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load pairing key (${response.status})`);
      const { key } = (await response.json()) as PairingKeyResponse;
      if (current !== generation) return;
      credentials = { key, vault: vaultInput.value.trim() || "default" };
      await refresh();
    } catch (error) {
      if (current === generation)
        message.textContent = error instanceof Error ? error.message : "Could not load dashboard";
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void openVault();
  });
  element("refresh").addEventListener("click", () => {
    void refresh();
  });
  element("copy-key").addEventListener("click", async () => {
    if (!credentials) return;
    const current = generation;
    try {
      await navigator.clipboard.writeText(credentials.key);
      if (current === generation) message.textContent = "Pairing key copied";
    } catch {
      if (current === generation)
        message.textContent =
          "Clipboard access failed. Use the original pairing key from your deployment.";
    }
  });
  setInterval(() => {
    if (!element("dashboard").hidden) void refresh();
  }, 15_000);
  void openVault();
}

dashboardClient();
