import type { RHClawInboundEvent } from "./types.js";

export type RHClawInboundEnvelope = {
  channel: "rhclaw";
  accountId: string;
  senderId: string;
  chatType: "direct";
  chatId: string;
  text: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
};

function normalizeSessionKey(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveRHClawSessionKey(params: {
  accountId: string;
  event: RHClawInboundEvent;
  defaultAgentId?: string;
}): string {
  const incomingSessionKey = normalizeSessionKey(params.event.sessionKey);
  if (incomingSessionKey?.toLowerCase().startsWith("agent:")) {
    return incomingSessionKey;
  }

  if (incomingSessionKey && params.defaultAgentId?.trim()) {
    return `agent:${params.defaultAgentId.trim()}:${incomingSessionKey}`;
  }

  if (params.defaultAgentId?.trim()) {
    return `agent:${params.defaultAgentId.trim()}:rhclaw:${params.accountId}:direct:${params.event.deviceId}`;
  }

  return incomingSessionKey ?? `rhclaw:${params.accountId}:direct:${params.event.deviceId}`;
}

export function mapRHInboundEventToEnvelope(params: {
  accountId: string;
  event: RHClawInboundEvent;
  defaultAgentId?: string;
}): RHClawInboundEnvelope {
  return {
    channel: "rhclaw",
    accountId: params.accountId,
    senderId: params.event.senderId,
    chatType: "direct",
    chatId: params.event.deviceId,
    text: params.event.text,
    sessionKey: resolveRHClawSessionKey(params),
    metadata: {
      eventId: params.event.eventId,
      taskId: params.event.taskId,
      routeAgentId: params.defaultAgentId ?? null,
      ...(params.event.metadata ?? {}),
    },
  };
}