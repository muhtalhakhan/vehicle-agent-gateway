/**
 * MCP adapter: exposes every action as an MCP tool over Streamable HTTP (stateless mode).
 * The verified OAuth token arrives as extra.authInfo; scope checks happen in ActionRunner.
 */
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { ACTIONS, type ActionName, type ActionRunner } from "./actions.js";

export function buildMcpServer(runner: ActionRunner): McpServer {
  const server = new McpServer({ name: "vehicle-agent-gateway", version: "1.0.0" });

  for (const name of Object.keys(ACTIONS) as ActionName[]) {
    const def = ACTIONS[name];
    server.registerTool(
      name,
      {
        title: def.title,
        description: `${def.description} Requires scope ${def.scope}.`,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.scope === "vehicle:read",
          destructiveHint: def.sensitive,
          openWorldHint: false,
        },
      },
      async (args: unknown, extra: { authInfo?: AuthInfo }) => {
        const auth = extra.authInfo;
        const result = runner.run(name, args, {
          clientId: auth?.clientId ?? "anonymous", scopes: auth?.scopes ?? [], via: "mcp",
        });
        const text = result.status === "ok" ? JSON.stringify(result.data, null, 2) : result.message;
        return { content: [{ type: "text" as const, text }], isError: result.status !== "ok" };
      },
    );
  }
  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, as the SDK recommends. */
export function mcpHandler(runner: ActionRunner) {
  return async (req: Request, res: Response) => {
    const server = buildMcpServer(runner);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp]", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };
}
