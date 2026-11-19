import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { parseText } from "../src/a2a.js";

const VIN = "WDEMO000000000001";
let server: Server;
let cfg: Config;
let app: ReturnType<typeof createApp>["app"];
let runner: ReturnType<typeof createApp>["runner"];

beforeAll(async () => {
  // Bind first so PUBLIC_URL (JWT issuer/audience) matches the real port.
  const probe = (await import("node:http")).createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  cfg = loadConfig({ PORT: String(port), JWT_SECRET: "test-secret-test-secret-test-secret" });
  ({ app, runner } = createApp(cfg));
  server = app.listen(port);
});
afterAll(() => new Promise((r) => server.close(r)));

async function token(client: "assistant-readonly" | "assistant-full", scope?: string) {
  const secret = client === "assistant-full" ? "full-demo-secret" : "readonly-demo-secret";
  const res = await request(app).post("/oauth/token").type("form")
    .send({ grant_type: "client_credentials", client_id: client, client_secret: secret, ...(scope ? { scope } : {}) });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "test-assistant", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${cfg.publicUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

describe("OAuth 2.0 client credentials", () => {
  it("issues a scoped bearer token", async () => {
    const res = await request(app).post("/oauth/token")
      .auth("assistant-full", "full-demo-secret")
      .type("form").send({ grant_type: "client_credentials", scope: "vehicle:read" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: "Bearer", scope: "vehicle:read" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a wrong secret and scopes the client was not granted", async () => {
    const bad = await request(app).post("/oauth/token").type("form")
      .send({ grant_type: "client_credentials", client_id: "assistant-full", client_secret: "nope" });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("invalid_client");

    const over = await request(app).post("/oauth/token").type("form").send({
      grant_type: "client_credentials", client_id: "assistant-readonly",
      client_secret: "readonly-demo-secret", scope: "vehicle:control",
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe("invalid_scope");
  });

  it("publishes discovery metadata (RFC 8414 / RFC 9728)", async () => {
    const as = await request(app).get("/.well-known/oauth-authorization-server");
    expect(as.body.token_endpoint).toBe(`${cfg.publicUrl}/oauth/token`);
    const pr = await request(app).get("/.well-known/oauth-protected-resource");
    expect(pr.body.authorization_servers).toEqual([cfg.publicUrl]);
  });
});

describe("MCP server", () => {
  it("refuses requests without a valid token and points to resource metadata", async () => {
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata=");

    const forged = await request(app).post("/mcp").set("Authorization", "Bearer abc.def.ghi")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(forged.status).toBe(401);
  });

  it("lists every vehicle tool with annotations", async () => {
    const client = await mcpClient(await token("assistant-full"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_vehicle_status", "list_vehicles", "lock_vehicle", "send_destination", "set_climate", "unlock_vehicle"]);
    expect(tools.find((t) => t.name === "unlock_vehicle")?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it("reads status and changes climate with the right scopes", async () => {
    const client = await mcpClient(await token("assistant-full"));
    const status = await client.callTool({ name: "get_vehicle_status", arguments: { vin: VIN } });
    expect(status.isError).toBe(false);
    expect(JSON.parse(text(status)).batteryPercent).toBe(78);

    const climate = await client.callTool({ name: "set_climate", arguments: { vin: VIN, on: true, targetCelsius: 22 } });
    expect(JSON.parse(text(climate)).climate).toEqual({ on: true, targetCelsius: 22 });
    await client.close();
  });

  it("denies control actions to a read-only token", async () => {
    const client = await mcpClient(await token("assistant-readonly"));
    const res = await client.callTool({ name: "lock_vehicle", arguments: { vin: VIN } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("lacks scope 'vehicle:control'");
    await client.close();
  });

  it("requires explicit confirmation before unlocking", async () => {
    const client = await mcpClient(await token("assistant-full"));
    const first = await client.callTool({ name: "unlock_vehicle", arguments: { vin: VIN } });
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("confirm=true");

    const second = await client.callTool({ name: "unlock_vehicle", arguments: { vin: VIN, confirm: true } });
    expect(JSON.parse(text(second)).locked).toBe(false);
    await client.close();
  });

  it("validates arguments and audits every call", async () => {
    const client = await mcpClient(await token("assistant-full"));
    const res = await client.callTool({ name: "get_vehicle_status", arguments: { vin: "NOPE0000000000000" } });
    expect(res.isError).toBe(true);
    await client.close();
    const outcomes = runner.audit.map((a) => a.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(["ok", "denied", "needs_confirmation", "error"]));
    expect(runner.audit.every((a) => a.clientId && a.via)).toBe(true);
  });
});

describe("A2A", () => {
  const send = (tok: string, message: Record<string, unknown>) =>
    request(app).post("/a2a").set("Authorization", `Bearer ${tok}`)
      .send({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", ...message } } });

  it("serves an agent card with OAuth security and one skill per action", async () => {
    const res = await request(app).get("/.well-known/agent-card.json");
    expect(res.body.url).toBe(`${cfg.publicUrl}/a2a`);
    expect(res.body.securitySchemes.oauth2.flows.clientCredentials.tokenUrl).toBe(`${cfg.publicUrl}/oauth/token`);
    expect(res.body.skills).toHaveLength(6);
  });

  it("requires a bearer token", async () => {
    const res = await request(app).post("/a2a").send({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} });
    expect(res.status).toBe(401);
  });

  it("runs a structured DataPart request", async () => {
    const res = await send(await token("assistant-full"),
      { parts: [{ kind: "data", data: { action: "send_destination", args: { vin: VIN, destination: "Olympiapark, Munich" } } }] });
    expect(res.body.result.status.state).toBe("completed");
    expect(res.body.result.artifacts[0].parts[0].data.result.navigationDestination).toBe("Olympiapark, Munich");
  });

  it("handles plain text and the confirmation round-trip for unlock", async () => {
    const tok = await token("assistant-full");
    const lock = await send(tok, { parts: [{ kind: "text", text: `lock ${VIN}` }] });
    expect(lock.body.result.status.state).toBe("completed");

    const ask = await send(tok, { parts: [{ kind: "text", text: `please unlock ${VIN}` }] });
    expect(ask.body.result.status.state).toBe("input-required");

    const ok = await send(tok, { taskId: ask.body.result.id, parts: [{ kind: "text", text: "yes" }] });
    expect(ok.body.result.status.state).toBe("completed");
    expect(ok.body.result.artifacts[0].parts[0].data.result.locked).toBe(false);

    const got = await request(app).post("/a2a").set("Authorization", `Bearer ${tok}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: ask.body.result.id } });
    expect(got.body.result.status.state).toBe("completed");
  });

  it("rejects actions outside the token's scopes and hides other clients' tasks", async () => {
    const ro = await token("assistant-readonly");
    const res = await send(ro, { parts: [{ kind: "data", data: { action: "lock_vehicle", args: { vin: VIN } } }] });
    expect(res.body.result.status.state).toBe("rejected");

    const full = await token("assistant-full");
    const ask = await send(full, { parts: [{ kind: "text", text: `unlock ${VIN}` }] });
    const steal = await send(ro, { taskId: ask.body.result.id, parts: [{ kind: "text", text: "yes" }] });
    expect(steal.body.error.message).toBe("Task not found");
  });
});

describe("text intent parser", () => {
  it.each([
    [`what's the battery of ${VIN}`, "get_vehicle_status"],
    [`set climate to 21 degrees for ${VIN}`, "set_climate"],
    [`navigate to Erfurt Hbf`, "send_destination"],
    [`unlock my car`, "unlock_vehicle"],
    [`which vehicles do I have`, "list_vehicles"],
  ])("%s -> %s", (input, action) => {
    expect(parseText(input)?.action).toBe(action);
  });
});

describe("home page", () => {
  it("lists endpoints and offers the demo panel in demo mode", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("/.well-known/agent-card.json");
    expect(res.text).toContain("Try it");
  });

  it("never shows demo credentials when real clients are configured", async () => {
    const prod = createApp(loadConfig({
      JWT_SECRET: "x".repeat(40), CLIENTS_JSON: JSON.stringify({ real: { secret: "s3cret", scopes: ["vehicle:read"] } }),
    })).app;
    const res = await request(prod).get("/");
    expect(res.text).not.toContain("Try it");
    expect(res.text).not.toContain("demo-secret");
    expect(res.text).not.toContain("s3cret");
  });
});
