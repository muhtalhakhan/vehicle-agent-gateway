/**
 * Minimal OAuth 2.0 authorization server (client credentials grant, RFC 6749 §4.4) issuing
 * short-lived HS256 JWTs, plus the verifier the MCP bearer middleware uses.
 * Machine-to-machine on purpose: the callers are AI assistants/agents, not end users.
 */
import { timingSafeEqual } from "node:crypto";
import express, { type Router } from "express";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { SCOPES, type Config } from "./config.js";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Reads client_id/secret from HTTP Basic auth or the request body (RFC 6749 §2.3.1). */
function clientCredentials(req: express.Request): { id?: string; secret?: string } {
  const h = req.headers.authorization;
  if (h?.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(h.slice(6), "base64").toString().split(":");
    return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
  }
  return { id: req.body?.client_id, secret: req.body?.client_secret };
}

export function authRouter(cfg: Config): Router {
  const r = express.Router();
  const oauthError = (res: express.Response, status: number, error: string, description: string) =>
    res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });

  r.post("/oauth/token", express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    if (req.body?.grant_type !== "client_credentials") {
      return oauthError(res, 400, "unsupported_grant_type", "Only client_credentials is supported.");
    }
    const { id, secret } = clientCredentials(req);
    const client = id ? cfg.clients[id] : undefined;
    if (!client || !secret || !safeEqual(secret, client.secret)) {
      return oauthError(res, 401, "invalid_client", "Unknown client or wrong secret.");
    }
    const requested = typeof req.body.scope === "string" ? req.body.scope.split(" ").filter(Boolean) : client.scopes;
    const denied = requested.filter((s: string) => !client.scopes.includes(s));
    if (denied.length) return oauthError(res, 400, "invalid_scope", `Not allowed for this client: ${denied.join(" ")}`);

    const token = await new SignJWT({ scope: requested.join(" "), client_id: id })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(cfg.publicUrl)
      .setAudience(cfg.publicUrl)
      .setSubject(id!)
      .setIssuedAt()
      .setExpirationTime(`${cfg.tokenTtlSeconds}s`)
      .sign(cfg.jwtSecret);
    res.set("Cache-Control", "no-store").json({
      access_token: token, token_type: "Bearer", expires_in: cfg.tokenTtlSeconds, scope: requested.join(" "),
    });
  });

  // RFC 8414: lets clients discover the token endpoint and supported scopes.
  r.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: cfg.publicUrl,
      token_endpoint: `${cfg.publicUrl}/oauth/token`,
      grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: Object.keys(SCOPES),
    });
  });

  // RFC 9728: tells MCP clients which authorization server protects this resource.
  r.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: cfg.publicUrl,
      authorization_servers: [cfg.publicUrl],
      scopes_supported: Object.keys(SCOPES),
      bearer_methods_supported: ["header"],
    });
  });

  return r;
}

export function tokenVerifier(cfg: Config): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, cfg.jwtSecret, {
          issuer: cfg.publicUrl, audience: cfg.publicUrl, algorithms: ["HS256"], typ: "at+jwt",
        });
        return {
          token,
          clientId: String(payload.client_id ?? payload.sub),
          scopes: String(payload.scope ?? "").split(" ").filter(Boolean),
          expiresAt: payload.exp,
        };
      } catch (e) {
        const msg = e instanceof joseErrors.JWTExpired ? "Token expired" : "Invalid token";
        throw new InvalidTokenError(msg);
      }
    },
  };
}
