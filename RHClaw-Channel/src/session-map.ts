import type { RHClawSessionBinding } from "./types.js";

export class RHClawSessionMap {
  private readonly bindings = new Map<string, RHClawSessionBinding>();

  get(sessionKey: string) {
    return this.bindings.get(sessionKey);
  }

  set(binding: RHClawSessionBinding) {
    this.bindings.set(binding.sessionKey, binding);
  }

  delete(sessionKey: string) {
    this.bindings.delete(sessionKey);
  }

  list() {
    return Array.from(this.bindings.values());
  }
}