/**
 * A2A (Agent2Agent) adapter: publishes an Agent Card and serves JSON-RPC `message/send` and
 * `tasks/get`, so other agents can delegate vehicle tasks to this gateway.
 *
 * A message can carry a structured DataPart {action, args} (preferred for agents) or plain text,
 * which is matched against a few simple intents. Sensitive actions return a task in state
 * `input-required`; the caller confirms by replying on the same taskId.
 */
import { randomUUID } from "node:crypto";
import express, { type Router } from "express";
import { ACTIONS, type ActionName, type ActionResult, type ActionRunner } from "./actions.js";
import { SCOPES, type Config } from "./config.js";

type Part = { kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> };
type Message = { kind?: "message"; role: "user" | "agent"; parts: Part[]; messageId: string; taskId?: string; contextId?: string };
type TaskState = "completed" | "failed" | "rejected" | "input-required";
type Task = {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string; message?: Message };
  artifacts?: { artifactId: string; name: string; parts: Part[] }[];
  history: Message[];
};

const PROTOCOL_VERSION = "0.3.0";

export function agentCard(cfg: Config) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: "Vehicle Agent Gateway",
    description: "Lets external AI agents read vehicle status and run vehicle actions (climate, locks, navigation) " +
      "behind OAuth 2.0 scopes, with confirmation for security-sensitive actions.",
    url: `${cfg.publicUrl}/a2a`,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    securitySchemes: {
      oauth2: {
        type: "oauth2",
        flows: { clientCredentials: { tokenUrl: `${cfg.publicUrl}/oauth/token`, scopes: SCOPES } },
      },
    },
    security: [{ oauth2: ["vehicle:read"] }],
    skills: (Object.keys(ACTIONS) as ActionName[]).map((id) => ({
      id,
      name: ACTIONS[id].title,
      description: `${ACTIONS[id].description} Requires scope ${ACTIONS[id].scope}.`,
      tags: ["vehicle", ACTIONS[id].scope],
      examples: [`{"action":"${id}","args":${JSON.stringify(exampleArgs(id))}}`],
    })),
  };
}

function exampleArgs(id: ActionName): Record<string, unknown> {
  const vin = "WDEMO000000000001";
  return ({
    list_vehicles: {},
    get_vehicle_status: { vin },
    set_climate: { vin, on: true, targetCelsius: 21 },
    lock_vehicle: { vin },
    unlock_vehicle: { vin, confirm: true },
    send_destination: { vin, destination: "Olympiapark, Munich" },
  } as Record<ActionName, Record<string, unknown>>)[id];
}

const VIN_RE = /\b[A-Z0-9]{17}\b/i; // demo VINs; real VINs exclude I, O, Q

/** Very small text-intent matcher, so a human-style message also works. Agents should send DataParts. */
export function parseText(text: string): { action: ActionName; args: Record<string, unknown> } | null {
  const t = text.toLowerCase();
  const vin = text.match(VIN_RE)?.[0]?.toUpperCase();
  const withVin = (args: Record<string, unknown> = {}) => (vin ? { vin, ...args } : args);
  if (/\b(list|which|my)\b.*\b(vehicles|cars)\b/.test(t)) return { action: "list_vehicles", args: {} };
  if (/\bunlock\b/.test(t)) return { action: "unlock_vehicle", args: withVin() };
  if (/\block\b/.test(t)) return { action: "lock_vehicle", args: withVin() };
  const nav = text.match(/\b(?:navigate|drive|directions|route)\s+to\s+(.+)$/i);
  if (nav) return { action: "send_destination", args: withVin({ destination: nav[1].replace(VIN_RE, "").replace(/\s+for\s*$/i, "").trim() }) };
  if (/\b(climate|heat|cool|precondition|temperature|ac)\b/.test(t)) {
    const deg = t.match(/(\d{2})\s*(?:°|degrees|c\b)/)?.[1];
    const off = /\b(off|stop|disable)\b/.test(t);
    return { action: "set_climate", args: withVin({ on: !off, ...(deg ? { targetCelsius: Number(deg) } : {}) }) };
  }
  if (/\b(status|battery|range|charge|where)\b/.test(t)) return { action: "get_vehicle_status", args: withVin() };
  return null;
}

const CONFIRM_RE = /^\s*(yes|y|confirm|confirmed|ok|okay|go ahead|do it)\b/i;

export function a2aRouter(cfg: Config, runner: ActionRunner): Router {
  const r = express.Router();
  const tasks = new Map<string, Task & { owner: string; pending?: { action: ActionName; args: Record<string, unknown> } }>();

  r.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard(cfg)));
  r.get("/.well-known/agent.json", (_req, res) => res.json(agentCard(cfg))); // pre-0.3 path

  r.post("/a2a", express.json(), (req, res) => {
    const { id = null, method, params } = req.body ?? {};
    const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
    const caller = { clientId: req.auth!.clientId, scopes: req.auth!.scopes, via: "a2a" as const };

    if (method === "tasks/get") {
      const task = tasks.get(params?.id);
      if (!task || task.owner !== caller.clientId) return fail(-32001, "Task not found");
      const { owner, pending, ...pub } = task;
      return reply(pub);
    }
    if (method !== "message/send") return fail(-32601, `Method not found: ${method}`);

    const msg: Message | undefined = params?.message;
    if (!msg || !Array.isArray(msg.parts)) return fail(-32602, "params.message with parts is required");

    // Follow-up on a task that is waiting for confirmation.
    if (msg.taskId) {
      const task = tasks.get(msg.taskId);
      if (!task || task.owner !== caller.clientId) return fail(-32001, "Task not found");
      if (task.status.state !== "input-required" || !task.pending) return fail(-32002, "Task is not waiting for input");
      task.history.push(msg);
      const data = msg.parts.find((p) => p.kind === "data")?.data;
      const text = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join(" ");
      const confirmed = data?.confirm === true || CONFIRM_RE.test(text);
      if (!confirmed) {
        finish(task, "rejected", "Not confirmed. Action cancelled.");
      } else {
        apply(task, runner.run(task.pending.action, { ...task.pending.args, confirm: true }, caller));
      }
      delete task.pending;
      const { owner, pending, ...pub } = task;
      return reply(pub);
    }

    const dataPart = msg.parts.find((p) => p.kind === "data")?.data;
    const textPart = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join(" ");
    const intent = dataPart && typeof dataPart.action === "string"
      ? { action: dataPart.action as ActionName, args: (dataPart.args ?? {}) as Record<string, unknown> }
      : parseText(textPart);

    const task: Task & { owner: string; pending?: { action: ActionName; args: Record<string, unknown> } } = {
      kind: "task", id: randomUUID(), contextId: msg.contextId ?? randomUUID(), owner: caller.clientId,
      status: { state: "failed", timestamp: new Date().toISOString() }, history: [msg],
    };
    tasks.set(task.id, task);

    if (!intent || !(intent.action in ACTIONS)) {
      finish(task, "failed", `Could not map the request to a skill. Send a DataPart {"action": one of ` +
        `${Object.keys(ACTIONS).join(", ")}, "args": {...}}.`);
    } else {
      const result = runner.run(intent.action, intent.args, caller);
      if (result.status === "needs_confirmation") task.pending = intent;
      apply(task, result);
    }
    const { owner, pending, ...pub } = task;
    reply(pub);
  });

  return r;
}

function agentMessage(task: Task, text: string): Message {
  return { kind: "message", role: "agent", messageId: randomUUID(), taskId: task.id, contextId: task.contextId,
           parts: [{ kind: "text", text }] };
}

function finish(task: Task, state: TaskState, text: string) {
  const message = agentMessage(task, text);
  task.status = { state, timestamp: new Date().toISOString(), message };
  task.history.push(message);
}

function apply(task: Task, result: ActionResult) {
  switch (result.status) {
    case "ok":
      task.artifacts = [{ artifactId: randomUUID(), name: "result", parts: [{ kind: "data", data: { result: result.data } }] }];
      return finish(task, "completed", "Done.");
    case "needs_confirmation":
      return finish(task, "input-required", result.message + " Reply on this task with 'yes' to confirm.");
    case "denied":
      return finish(task, "rejected", result.message);
    case "error":
      return finish(task, "failed", result.message);
  }
}
