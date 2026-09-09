import { dashboardScript } from "./dashboard-script.generated";

export function dashboardResponse(): Response {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CF Sync · Vault dashboard</title>
<style nonce="${nonce}">
:root{font-family:system-ui,sans-serif;color:#e9edf2;background:#101419;color-scheme:dark}*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:0 auto;padding:44px 24px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #303840;padding-bottom:24px}.eyebrow{color:#dfbd7c;font-size:12px;letter-spacing:.16em;font-weight:700}h1{font-size:32px;letter-spacing:-.04em;margin:10px 0}h2{font-size:19px;margin:0}p,small{color:#aeb8c4;line-height:1.6}small{display:block;font-size:12px;overflow-wrap:anywhere}button,input{font:inherit;border-radius:7px;padding:10px 14px}button{background:#e8c484;color:#172027;border:1px solid transparent;cursor:pointer;font-weight:600}button:disabled{opacity:.45;cursor:default}.quiet{background:transparent;border-color:#46515d;color:#e9edf2}.danger{color:#ffb2a9}button:focus-visible,input:focus-visible{outline:2px solid #e8c484;outline-offset:3px}input{display:block;width:100%;background:#101419;border:1px solid #46515d;color:inherit;margin-top:8px}label{display:block;font-size:14px;margin-bottom:20px}form{max-width:460px;margin:52px auto;background:#181e25;padding:28px;border:1px solid #303840;border-radius:12px}form button{width:100%}.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.metric{padding:20px;background:#181e25;border:1px solid #303840;border-radius:10px}.metric strong{display:block;font-size:28px;margin:8px 0}.metric span{font-size:13px;color:#aeb8c4}section{margin-top:32px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.table-wrap{overflow:auto;border:1px solid #303840;border-radius:10px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:16px;border-bottom:1px solid #303840;vertical-align:top}th{color:#aeb8c4;font-size:12px;font-weight:500;white-space:nowrap}td:first-child{min-width:180px}td:nth-child(4){min-width:220px}tbody tr:last-child td{border-bottom:0}ul{padding:0;list-style:none}li{padding:14px 0;border-bottom:1px solid #303840}#message{min-height:24px;color:#e8c484}#vault-name{overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:700px){main{padding:24px 16px}.metrics{grid-template-columns:1fr 1fr}header{align-items:flex-start}h1{font-size:26px}}
</style></head><body><main>
<header><div><div class="eyebrow">CF SYNC / CONTROL ROOM</div><h1>Your vault, connected.</h1><small>Device access and synchronization activity</small></div><span class="eyebrow">SELF-HOSTED</span></header>
<p id="message" role="status" aria-live="polite"></p>
<form id="select-vault"><label>Vault ID<input id="vault" value="default" required maxlength="128" autocomplete="off"></label><button type="submit">Open vault</button></form>
<div id="dashboard" hidden><div class="section-head"><h2 id="vault-name"></h2><small id="version"></small></div><div class="toolbar"><button id="refresh" type="button">Refresh</button><button id="copy-key" type="button" class="quiet">Copy pairing key</button><small id="updated"></small></div>
<div class="metrics"><div class="metric"><span>Active files</span><strong id="files"></strong></div><div class="metric"><span>File content size</span><strong id="file-bytes"></strong></div><div class="metric"><span>Registered chunk storage</span><strong id="chunk-bytes"></strong></div><div class="metric"><span>Recorded unresolved conflicts</span><strong id="conflict-count"></strong></div></div>
<p><small>File size is logical content size. Registered chunks include retained and orphaned uploads for this vault; this is not your R2 bill or total account storage.</small></p>
<section><div class="section-head"><h2>Devices</h2><small id="device-count"></small></div><div class="table-wrap"><table><thead><tr><th>Device</th><th>Access / connection</th><th>Last server activity</th><th>Device-reported progress</th><th>Access</th></tr></thead><tbody id="devices"></tbody></table></div><p id="devices-empty">No devices paired with this vault yet.</p><p><small>Showing up to 200 devices. An open connection or recent request does not prove a device is caught up. Progress is the last report received, not a live guarantee. Refreshes every 15 seconds.</small></p></section>
<section><h2>Recorded conflicts</h2><ul id="conflicts"></ul><p id="conflicts-empty">No unresolved conflicts recorded by the server.</p><p><small>Latest 50 unresolved server records. This is not a complete inventory of local conflict copies; those must be reviewed in Obsidian.</small></p></section>
</div></main><script nonce="${nonce}">${dashboardScript}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
