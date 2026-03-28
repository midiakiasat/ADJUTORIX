export interface ServiceDefinition {
  readonly name: string;
  readonly version: string;
  readonly critical: boolean;
}

export class ServiceRegistry {
  readonly #services = new Map<string, ServiceDefinition>();

  register(service: ServiceDefinition): void {
    if (service.name.trim().length === 0) {
      throw new Error("service name must be non-empty");
    }
    this.#services.set(service.name, service);
  }

  get(name: string): ServiceDefinition | undefined {
    return this.#services.get(name);
  }

  list(): ServiceDefinition[] {
    return [...this.#services.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  criticalServices(): ServiceDefinition[] {
    return this.list().filter((service) => service.critical);
  }
}
