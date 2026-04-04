export type RHClawChannelConfig = {
  enabled?: boolean;
  connectionMode?: "websocket" | "polling";
  serverUrl?: string;
  deviceSocketUrl?: string;
  deviceId?: string;
  deviceCode?: string;
  deviceName?: string;
  defaultAgentId?: string;
  heartbeatIntervalSec?: number;
  ackTimeoutSec?: number;
  resultTimeoutSec?: number;
  allowFrom?: string[];
  dmPolicy?: string;
  groupPolicy?: string;
  gatewayTokenRef?: {
    source?: "env" | "file";
    provider?: string;
    id?: string;
  };
};

export type ResolvedRHClawAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  config: RHClawChannelConfig;
};

export type RHClawInboundEvent = {
  eventId: string;
  taskId: string;
  deviceId: string;
  senderId: string;
  sessionKey?: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type RHClawSocketEnvelope =
  | {
      type: "command" | "inbound_event";
      payload: RHClawInboundEvent;
    }
  | {
      type: "heartbeat_ack";
      timestamp?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "config_refresh";
      metadata?: Record<string, unknown>;
    };

export type RHClawOutboundEvent = {
  eventId: string;
  taskId: string;
  deviceId: string;
  sessionKey?: string;
  text: string;
  status: "pending" | "running" | "succeeded" | "failed";
  metadata?: Record<string, unknown>;
};

export type RHClawSessionBinding = {
  sessionKey: string;
  taskId: string;
  deviceId: string;
  agentId?: string;
  createdAt: string;
};