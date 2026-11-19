/**
 * One action layer shared by every protocol adapter (MCP, A2A). Permission checks,
 * confirmation for sensitive actions and auditing live here, not in the adapters,
 * so a new protocol can't skip them.
 */
import { z } from "zod";
import type { Scope } from "./config.js";
import { VehicleService } from "./vehicles.js";

export type Caller = { clientId: string; scopes: string[]; via: "mcp" | "a2a" };

export type AuditEntry = {
  at: string;
  clientId: string;
  via: Caller["via"];
  action: string;
  args: unknown;
  outcome: "ok" | "denied" | "needs_confirmation" | "error";
  detail?: string;
};

export type ActionResult =
  | { status: "ok"; data: unknown }
  | { status: "denied"; message: string }
  | { status: "needs_confirmation"; message: string }
  | { status: "error"; message: string };

const vin = z.string().min(11).max(17).describe("Vehicle identification number");

export const ACTIONS = {
  list_vehicles: {
    title: "List vehicles",
    description: "List the vehicles this client may access.",
    scope: "vehicle:read",
    sensitive: false,
    input: {},
    run: (svc: VehicleService) => svc.list(),
  },
  get_vehicle_status: {
    title: "Get vehicle status",
    description: "Battery, range, lock state, climate, location and navigation destination of a vehicle.",
    scope: "vehicle:read",
    sensitive: false,
    input: { vin },
    run: (svc: VehicleService, a: { vin: string }) => svc.status(a.vin),
  },
  set_climate: {
    title: "Set climate",
    description: "Turn pre-conditioning on or off and optionally set the target temperature (16-28 °C).",
    scope: "vehicle:control",
    sensitive: false,
    input: { vin, on: z.boolean(), targetCelsius: z.number().min(16).max(28).optional() },
    run: (svc: VehicleService, a: { vin: string; on: boolean; targetCelsius?: number }) =>
      svc.setClimate(a.vin, a.on, a.targetCelsius),
  },
  lock_vehicle: {
    title: "Lock vehicle",
    description: "Lock all doors.",
    scope: "vehicle:control",
    sensitive: false,
    input: { vin },
    run: (svc: VehicleService, a: { vin: string }) => svc.setLocked(a.vin, true),
  },
  unlock_vehicle: {
    title: "Unlock vehicle",
    description:
      "Unlock all doors. Security-sensitive: the call is refused unless confirm=true, which the assistant " +
      "must only set after the user has explicitly confirmed.",
    scope: "vehicle:control",
    sensitive: true,
    input: { vin, confirm: z.boolean().optional().describe("Must be true, after explicit user confirmation") },
    run: (svc: VehicleService, a: { vin: string }) => svc.setLocked(a.vin, false),
  },
  send_destination: {
    title: "Send navigation destination",
    description: "Send a destination (address or place name) to the vehicle's navigation system.",
    scope: "vehicle:control",
    sensitive: false,
    input: { vin, destination: z.string().min(2).max(200) },
    run: (svc: VehicleService, a: { vin: string; destination: string }) => svc.setDestination(a.vin, a.destination),
  },
} as const satisfies Record<string, ActionDef>;

type ActionDef = {
  title: string;
  description: string;
  scope: Scope;
  sensitive: boolean;
  input: z.ZodRawShape;
  run: (svc: VehicleService, args: any) => unknown;
};

export type ActionName = keyof typeof ACTIONS;

export class ActionRunner {
  readonly audit: AuditEntry[] = [];

  constructor(private svc: VehicleService) {}

  run(name: ActionName, rawArgs: unknown, caller: Caller): ActionResult {
    const def: ActionDef = ACTIONS[name];
    const log = (outcome: AuditEntry["outcome"], detail?: string) => {
      const entry = { at: new Date().toISOString(), clientId: caller.clientId, via: caller.via, action: name,
                      args: rawArgs, outcome, detail };
      this.audit.push(entry);
      console.log(JSON.stringify({ audit: entry }));
    };

    if (!caller.scopes.includes(def.scope)) {
      const message = `Client '${caller.clientId}' lacks scope '${def.scope}' required for ${name}.`;
      log("denied", message);
      return { status: "denied", message };
    }

    const parsed = z.object(def.input).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const message = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      log("error", message);
      return { status: "error", message };
    }

    if (def.sensitive && (parsed.data as { confirm?: boolean }).confirm !== true) {
      const message = `${def.title} is security-sensitive. Ask the user to confirm, then call again with confirm=true.`;
      log("needs_confirmation");
      return { status: "needs_confirmation", message };
    }

    try {
      const data = def.run(this.svc, parsed.data);
      log("ok");
      return { status: "ok", data };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", message);
      return { status: "error", message };
    }
  }
}
