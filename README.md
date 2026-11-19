# vehicle-agent-gateway

An integration layer that lets **external AI assistants and agents** use vehicle services safely.
It exposes one set of vehicle actions through two agent protocols:

- **MCP** (Model Context Protocol, Streamable HTTP) for assistants such as Claude, ChatGPT or IDE agents
- **A2A** (Agent2Agent, JSON-RPC) for other agents that delegate tasks

Both sit behind **OAuth 2.0** (client credentials, scoped JWTs) and one shared action layer that
enforces permissions, asks for confirmation on security-sensitive actions, and writes an audit log.

The vehicle backend is a **mock** (in-memory demo fleet). The point of the project is the integration
architecture, not the vehicle.

```
 AI assistant ──MCP──┐                        ┌──────────────────────────────┐
                     ├─► OAuth bearer check ─►│ Action layer                 │──► Vehicle services
 Other agent ──A2A───┘   (scoped JWT)         │  • scope check per action    │    (mock backend)
                                              │  • zod argument validation   │
       POST /oauth/token ◄── client creds     │  • confirm for unlock        │
                                              │  • audit log (JSON lines)    │
                                              └──────────────────────────────┘
```

## Actions

| Action | Scope | Notes |
|---|---|---|
| `list_vehicles` | `vehicle:read` | |
| `get_vehicle_status` | `vehicle:read` | battery, range, locks, climate, location, destination |
| `set_climate` | `vehicle:control` | 16–28 °C, validated |
| `lock_vehicle` | `vehicle:control` | |
| `unlock_vehicle` | `vehicle:control` | **sensitive**: refused until `confirm=true` after the user confirms |
| `send_destination` | `vehicle:control` | |

## Design decisions

- **One action layer, many protocols.** MCP and A2A are thin adapters over `src/actions.ts`. Scope checks,
  validation, confirmation and auditing live there, so adding a third protocol cannot bypass them.
- **Least privilege by scope.** A read-only assistant gets `vehicle:read` and can never change state,
  even if the model is prompt-injected into trying.
- **Human-in-the-loop for sensitive actions.** In MCP, `unlock_vehicle` returns an error asking for
  confirmation and is annotated `destructiveHint`. In A2A, the task goes to `input-required` and only
  completes when the caller replies on the same task.
- **Standard discovery.** `/.well-known/oauth-protected-resource` (RFC 9728),
  `/.well-known/oauth-authorization-server` (RFC 8414), and the A2A Agent Card at
  `/.well-known/agent-card.json`. A 401 from `/mcp` carries `WWW-Authenticate: ... resource_metadata=...`.
- **Stateless MCP.** A fresh server and transport per request, so it scales horizontally on App Runner.
- **Task isolation.** A2A tasks belong to the client that created them; others get "Task not found".

## Run locally

```bash
npm install
npm run dev            # http://localhost:8080
npm test               # 21 end-to-end tests: OAuth, MCP via the official SDK client, A2A
```

Open http://localhost:8080 for a page that lists the endpoints and, in demo mode, has a **Try it** panel
that runs the real flow (token → MCP tool call → A2A task) from the browser. With real clients configured,
the panel and any credentials are hidden.

Or with Docker: `docker build -t vehicle-agent-gateway . && docker run -p 8080:8080 -e NODE_ENV=development vehicle-agent-gateway`

Without `CLIENTS_JSON`, two demo clients exist: `assistant-readonly` / `readonly-demo-secret`
(`vehicle:read`) and `assistant-full` / `full-demo-secret` (both scopes). Never use them in production.

```bash
# 1. Get a token
TOKEN=$(curl -s -u assistant-full:full-demo-secret -d grant_type=client_credentials \
  localhost:8080/oauth/token | jq -r .access_token)

# 2. MCP: call a tool
curl -s localhost:8080/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_vehicle_status","arguments":{"vin":"WDEMO000000000001"}}}'

# 3. A2A: send a task (structured)
curl -s localhost:8080/a2a -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"1",
       "parts":[{"kind":"data","data":{"action":"send_destination","args":{"vin":"WDEMO000000000001","destination":"Olympiapark, Munich"}}}]}}}'
```

Any MCP client that supports Streamable HTTP with a bearer header can connect to `http://localhost:8080/mcp`.

## Deploy (AWS App Runner)

`apprunner.yaml` builds from source on the managed Node.js runtime; `Dockerfile` works for an image-based
service (ECR) instead. Put `JWT_SECRET` and `CLIENTS_JSON` in AWS Secrets Manager and set `PUBLIC_URL`
to the service URL. The service refuses to start in production without both secrets.

## Limits (on purpose, for a demo)

- Mock vehicle data in memory; A2A tasks are in memory too, so use one instance or add a store.
- Client credentials only (machine-to-machine). Acting on behalf of a signed-in driver would need the
  authorization code flow with PKCE.
- HS256 with a shared secret. With an external identity provider, switch to RS256 and its JWKS.
- The A2A text matcher is keyword-based; agents should send structured DataParts.

## Stack

TypeScript · Node.js · Express · `@modelcontextprotocol/sdk` · A2A protocol 0.3 · OAuth 2.0 · `jose` (JWT) ·
zod · Vitest · Docker · AWS App Runner
