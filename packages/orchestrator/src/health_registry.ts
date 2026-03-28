export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthRecord {
  readonly service: string;
  readonly status: HealthStatus;
  readonly detail: string;
  readonly observedAt: string;
}

export class HealthRegistry {
  readonly #records = new Map<string, HealthRecord>();

  update(record: HealthRecord): void {
    if (record.service.trim().length === 0) {
      throw new Error("health record service must be non-empty");
    }
    this.#records.set(record.service, record);
  }

  list(): HealthRecord[] {
    return [...this.#records.values()].sort((left, right) =>
      left.service.localeCompare(right.service)
    );
  }

  overall(): HealthStatus {
    const records = this.list();
    if (records.some((record) => record.status === "unhealthy")) {
      return "unhealthy";
    }
    if (records.some((record) => record.status === "degraded")) {
      return "degraded";
    }
    return "healthy";
  }
}
