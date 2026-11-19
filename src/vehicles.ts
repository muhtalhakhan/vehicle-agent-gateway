/**
 * Mock vehicle backend. Stands in for real vehicle/backend services so the integration layer
 * (OAuth, MCP, A2A, permission checks, audit log) can be built and tested end to end.
 */

export type VehicleState = {
  vin: string;
  model: string;
  batteryPercent: number;
  rangeKm: number;
  locked: boolean;
  climate: { on: boolean; targetCelsius: number };
  location: { lat: number; lon: number; label: string };
  navigationDestination: string | null;
};

export class VehicleNotFoundError extends Error {
  constructor(vin: string) {
    super(`Unknown vehicle ${vin}`);
  }
}

export class VehicleService {
  private vehicles = new Map<string, VehicleState>();

  constructor(seed: VehicleState[] = DEMO_FLEET) {
    for (const v of seed) this.vehicles.set(v.vin, structuredClone(v));
  }

  list(): Pick<VehicleState, "vin" | "model">[] {
    return [...this.vehicles.values()].map(({ vin, model }) => ({ vin, model }));
  }

  status(vin: string): VehicleState {
    return structuredClone(this.get(vin));
  }

  setClimate(vin: string, on: boolean, targetCelsius?: number): VehicleState {
    const v = this.get(vin);
    if (targetCelsius !== undefined && (targetCelsius < 16 || targetCelsius > 28)) {
      throw new RangeError("targetCelsius must be between 16 and 28");
    }
    v.climate = { on, targetCelsius: targetCelsius ?? v.climate.targetCelsius };
    return structuredClone(v);
  }

  setLocked(vin: string, locked: boolean): VehicleState {
    const v = this.get(vin);
    v.locked = locked;
    return structuredClone(v);
  }

  setDestination(vin: string, destination: string): VehicleState {
    const v = this.get(vin);
    v.navigationDestination = destination.trim().slice(0, 200);
    return structuredClone(v);
  }

  private get(vin: string): VehicleState {
    const v = this.vehicles.get(vin.toUpperCase());
    if (!v) throw new VehicleNotFoundError(vin);
    return v;
  }
}

export const DEMO_FLEET: VehicleState[] = [
  {
    vin: "WDEMO000000000001",
    model: "Demo EV Sedan",
    batteryPercent: 78,
    rangeKm: 412,
    locked: true,
    climate: { on: false, targetCelsius: 21 },
    location: { lat: 48.1771, lon: 11.5562, label: "Munich, Petuelring" },
    navigationDestination: null,
  },
  {
    vin: "WDEMO000000000002",
    model: "Demo EV SUV",
    batteryPercent: 34,
    rangeKm: 160,
    locked: false,
    climate: { on: true, targetCelsius: 22 },
    location: { lat: 50.9795, lon: 11.3235, label: "Weimar, Theaterplatz" },
    navigationDestination: "Erfurt Hbf",
  },
];
