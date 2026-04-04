import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtimeRef: PluginRuntime | null = null;

export function setRHClawRuntime(runtime: PluginRuntime) {
  runtimeRef = runtime;
}

export function getRHClawRuntime(): PluginRuntime {
  if (!runtimeRef) {
    throw new Error("RHClaw runtime has not been initialized");
  }
  return runtimeRef;
}