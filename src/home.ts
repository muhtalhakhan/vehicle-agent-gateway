/**
 * GET / : a small landing page listing the endpoints. When the demo clients are active it also
 * offers a "Try it" panel that runs the real flow from the browser (token -> MCP -> A2A).
 * Never shows credentials when real clients are configured.
 */
import type { Config } from "./config.js";
import { ACTIONS, type ActionName } from "./actions.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function homePage(cfg: Config): string {
  const u = esc(cfg.publicUrl);
  const rows = (Object.keys(ACTIONS) as ActionName[]).map((n) =>
    `<tr><td><code>${n}</code></td><td><code>${ACTIONS[n].scope}</code></td><td>${esc(ACTIONS[n].description)}</td></tr>`).join("");

  const demo = cfg.demoClients ? `
  <section>
    <h2>Try it</h2>
    <p class="muted">Runs the real flow from this page with the built-in demo client. Demo mode only.</p>
    <div class="row">
      <label>Client
        <select id="client">
          <option value="assistant-full">assistant-full (read + control)</option>
          <option value="assistant-readonly">assistant-readonly (read only)</option>
        </select>
      </label>
      <label>Vehicle
        <select id="vin"><option>WDEMO000000000001</option><option>WDEMO000000000002</option></select>
      </label>
    </div>
    <div class="row">
      <button data-mcp="get_vehicle_status">MCP: get status</button>
      <button data-mcp="set_climate">MCP: climate on, 21 °C</button>
      <button data-mcp="lock_vehicle">MCP: lock</button>
      <button data-mcp="unlock_vehicle">MCP: unlock (no confirm)</button>
      <button data-mcp="unlock_vehicle" data-confirm="1">MCP: unlock (confirmed)</button>
      <button id="a2a">A2A: "navigate to Erfurt Hbf"</button>
    </div>
    <pre id="out" aria-live="polite">Pick an action.</pre>
  </section>
  <script>
    const DEMO = { "assistant-full": "full-demo-secret", "assistant-readonly": "readonly-demo-secret" };
    const out = document.getElementById("out");
    const $ = (id) => document.getElementById(id);
    async function token() {
      const c = $("client").value;
      const r = await fetch("/oauth/token", { method: "POST",
        headers: { Authorization: "Basic " + btoa(c + ":" + DEMO[c]), "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_description || r.status);
      return j;
    }
    function show(steps) { out.textContent = steps.join("\\n\\n"); }
    document.querySelectorAll("[data-mcp]").forEach((b) => b.onclick = async () => {
      const name = b.dataset.mcp, vin = $("vin").value;
      const args = name === "set_climate" ? { vin, on: true, targetCelsius: 21 } : { vin };
      if (b.dataset.confirm) args.confirm = true;
      try {
        const t = await token();
        const r = await fetch("/mcp", { method: "POST", headers: { Authorization: "Bearer " + t.access_token,
          "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        const j = await r.json(), res = j.result || {};
        const text = (res.content || []).map((c) => c.text).join("\\n");
        show(["1. POST /oauth/token -> scope: " + t.scope,
              "2. POST /mcp tools/call " + name + " " + JSON.stringify(args),
              "3. " + (res.isError ? "Refused: " : "Result:\\n") + (text || JSON.stringify(j, null, 2))]);
      } catch (e) { show(["Error: " + e.message]); }
    });
    $("a2a").onclick = async () => {
      try {
        const t = await token(), vin = $("vin").value;
        const r = await fetch("/a2a", { method: "POST", headers: { Authorization: "Bearer " + t.access_token,
          "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send",
          params: { message: { role: "user", messageId: crypto.randomUUID(),
            parts: [{ kind: "text", text: "navigate to Erfurt Hbf for " + vin }] } } }) });
        const task = (await r.json()).result;
        show(["1. POST /oauth/token -> scope: " + t.scope, "2. POST /a2a message/send \\"navigate to Erfurt Hbf\\"",
              "3. Task " + task.status.state + ": " + task.status.message.parts[0].text,
              task.artifacts ? JSON.stringify(task.artifacts[0].parts[0].data.result, null, 2) : ""]);
      } catch (e) { show(["Error: " + e.message]); }
    };
  </script>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vehicle Agent Gateway</title>
<style>
  :root { --bg:#fafaf9; --fg:#1c1917; --muted:#57534e; --line:#e7e5e4; --card:#fff; --accent:#1d4ed8; --code:#f5f5f4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0c0a09; --fg:#f5f5f4; --muted:#a8a29e; --line:#292524; --card:#1c1917; --accent:#93c5fd; --code:#292524; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 0 0 10px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; margin-top:16px; }
  .muted { color:var(--muted); margin-top:0; }
  a { color:var(--accent); }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background:var(--code); padding:1px 5px; border-radius:4px; }
  pre { background:var(--code); padding:12px; border-radius:8px; overflow:auto; white-space:pre-wrap; margin:12px 0 0; min-height:3em; }
  table { width:100%; border-collapse:collapse; } td, th { text-align:left; padding:7px 6px; border-top:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:13px; border-top:none; }
  .tbl { overflow-x:auto; }
  ul { margin:0; padding-left:18px; } li { margin:4px 0; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; align-items:end; }
  label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted); }
  select, button { font:inherit; font-size:14px; padding:7px 11px; border-radius:7px; border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  button { cursor:pointer; } button:hover { border-color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Vehicle Agent Gateway</h1>
  <p class="muted">Lets external AI assistants (MCP) and agents (A2A) call vehicle services behind OAuth 2.0 scopes,
  with confirmation for sensitive actions and an audit log. The vehicle backend is a mock.</p>

  <section>
    <h2>Endpoints</h2>
    <ul>
      <li><code>POST ${u}/mcp</code>: MCP server (Streamable HTTP, bearer token)</li>
      <li><code>POST ${u}/a2a</code>: A2A JSON-RPC (<code>message/send</code>, <code>tasks/get</code>, bearer token)</li>
      <li><a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>: A2A Agent Card</li>
      <li><code>POST ${u}/oauth/token</code>: OAuth 2.0 client credentials</li>
      <li><a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a> (RFC 8414)</li>
      <li><a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a> (RFC 9728)</li>
      <li><a href="/health">/health</a></li>
    </ul>
  </section>

  <section>
    <h2>Actions</h2>
    <div class="tbl"><table><tr><th>Name</th><th>Scope</th><th>What it does</th></tr>${rows}</table></div>
  </section>
  ${demo}
  <p class="muted" style="margin-top:20px">Source: <a href="https://github.com/muhtalhakhan/vehicle-agent-gateway">github.com/muhtalhakhan/vehicle-agent-gateway</a></p>
</main>
</body>
</html>`;
}
