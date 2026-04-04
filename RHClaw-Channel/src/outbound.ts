import type { RHClawOutboundEvent } from "./types.js";

export function buildRHOutboundEvent(params: {
  deviceId: string;
  taskId: string;
  text: string;
  sessionKey?: string;
  status: RHClawOutboundEvent["status"];
  metadata?: Record<string, unknown>;
}): RHClawOutboundEvent {
  return {
    eventId: `${params.taskId}:${params.status}`,
    taskId: params.taskId,
    deviceId: params.deviceId,
    sessionKey: params.sessionKey,
    text: params.text,
    status: params.status,
    metadata: params.metadata,
  };
}