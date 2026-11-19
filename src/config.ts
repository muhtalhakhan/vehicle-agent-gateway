import { randomBytes } from "node:crypto";

export type ClientConfig = { secret: string; scopes: string[] };

export const SCOPES = {
  "vehicle:read": "Read vehicle status (battery, doors, climate, location)",
  "vehicle:control": "Change vehicle state (climate, locks, navigation)",
} as const;
export type Scope = keyof typeof SCOPES;

export type Config = {
  port: number;
  publicUrl: string;
  jwtSecret: Uint8Array;
  tokenTtlSeconds: number;
  clients: Record<string, ClientConfig>;
  /** True when the built-in demo clients are active (no CLIENTS_JSON). Enables the home page demo. */
  demoClients: boolean;
};

/** Demo clients for local use only. In production, pass CLIENTS_JSON. */
const DEMO_CLIENTS: Record<string, ClientConfig> = {
  "assistant-readonly": { secret: "readonly-demo-secret", scopes: ["vehicle:read"] },
  "assistant-full": { secret: "full-demo-secret", scopes: ["vehicle:read", "vehicle:control"] },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  const production = env.NODE_ENV === "production";

  if (production && (!env.JWT_SECRET || !env.CLIENTS_JSON)) {
    throw new Error("In production, JWT_SECRET and CLIENTS_JSON must be set.");
  }
  if (!env.JWT_SECRET) console.warn("[config] JWT_SECRET not set: using a random per-process key (dev only).");

  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    jwtSecret: env.JWT_SECRET ? new TextEncoder().encode(env.JWT_SECRET) : randomBytes(32),
    tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 900),
    clients: env.CLIENTS_JSON ? JSON.parse(env.CLIENTS_JSON) : DEMO_CLIENTS,
    demoClients: !env.CLIENTS_JSON,
  };
}
