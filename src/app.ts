import express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ActionRunner } from "./actions.js";
import { a2aRouter } from "./a2a.js";
import { authRouter, tokenVerifier } from "./auth.js";
import type { Config } from "./config.js";
import { mcpHandler } from "./mcp.js";
import { VehicleService } from "./vehicles.js";

export function createApp(cfg: Config, svc = new VehicleService()) {
  const app = express();
  const runner = new ActionRunner(svc);
  const bearer = requireBearerAuth({
    verifier: tokenVerifier(cfg),
    resourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource`,
  });

  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(authRouter(cfg));

  app.post("/mcp", bearer, express.json({ limit: "100kb" }), mcpHandler(runner));
  // Stateless server: no SSE stream or session to resume/delete.
  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Method not allowed" }));

  app.post("/a2a", bearer);
  app.use(a2aRouter(cfg, runner));

  return { app, runner };
}
