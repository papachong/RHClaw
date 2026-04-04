import { readFile, writeFile } from "node:fs/promises";
import { io as socketIoConnect, type Socket as SocketIoSocket } from "socket.io-client";
import { readTokenFromEnv, writeTokenToEnv } from "./env-token.js";
import type {
  RHClawInboundEvent,
  RHClawOutboundEvent,
  RHClawChannelConfig,
  RHClawSocketEnvelope,
} from "./types.js";

export type RHClawServerRuntimeContext = {
  deviceId: string;
  defaultAgentId?: string;
  allowFrom?: string[];
  metadata?: Record<string, unknown>;
};

type RHClawPendingEventsResponse = {
  deviceId: string;
  items: Array<
    | {
        type: "command" | "inbound_event";
        payload: RHClawInboundEvent;
      }
    | {
        type: "heartbeat_ack";
        timestamp?: string;
      }
  >;
};

type RHClawResponseEnvelope<T> = {
  success?: boolean;
  data?: T;
  message?: string;
};

type RHClawAckResponse = {
  target: {
    targetTaskId: string;
    deliveryStatus: string;
    executeStatus: string;
  };
  acked: boolean;
};

type RHClawRefreshTokenResponse = {
  token: {
    deviceToken: string;
    expiresAt: string;
  };
};

type RHClawRegisterResponse = {
  device: {
    id: string;
    deviceCode: string;
    deviceName: string;
  };
  token: {
    deviceToken: string;
    expiresAt: string;
  };
};

type DeviceTokenState = {
  value?: string;
  expiresAt?: string;
};

function extractEnvelopeMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) {
    return undefined;
  }

  const directMessage = payload.message;
  if (typeof directMessage === "string" && directMessage.trim()) {
    return directMessage.trim();
  }

  const nestedData = payload.data;
  if (
    nestedData &&
    typeof nestedData === "object" &&
    !Array.isArray(nestedData) &&
    typeof (nestedData as Record<string, unknown>).message === "string"
  ) {
    const nestedMessage = (nestedData as Record<string, unknown>).message as string;
    return nestedMessage.trim() || undefined;
  }

  return undefined;
}

export type RHClawServerClient = {
  getRuntimeContext: () => Promise<RHClawServerRuntimeContext>;
  reportStatus: (status: Record<string, unknown>) => Promise<void>;
  ackCommand: (targetTaskId: string) => Promise<RHClawAckResponse | undefined>;
  publishResult: (event: RHClawOutboundEvent) => Promise<void>;
  reregisterDevice: () => Promise<string | undefined>;
  connectDeviceSocket: (handlers: {
    onInboundEvent: (event: RHClawInboundEvent) => Promise<void>;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (error: Error) => void;
    onHeartbeatAck?: (timestamp?: string) => void;
    onSessionInvalidated?: (reason: string) => Promise<boolean>;
  }) => Promise<{ close: () => Promise<void> }>;
};

function normalizeUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildControlPlaneUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function isSocketEnvelope(value: unknown): value is RHClawSocketEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  return typeof envelope.type === "string";
}

function buildBaseHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function parseEnvelope<T>(response: Response): Promise<T | undefined> {
  const payload = (await response.json().catch(() => undefined)) as RHClawResponseEnvelope<T> | T | undefined;
  if (!payload) {
    return undefined;
  }

  if (typeof payload === "object" && payload !== null && "data" in payload) {
    const envelope = payload as RHClawResponseEnvelope<T>;
    if (envelope.success === false) {
      throw new Error(envelope.message || "RHClaw control plane returned failure");
    }
    return envelope.data;
  }

  return payload as T;
}

function buildLegacyCommandResultPayload(event: RHClawOutboundEvent) {
  return {
    targetTaskId: event.taskId,
    status: event.status === "succeeded" ? "succeeded" : "failed",
    resultText: event.text,
    resultSummary: event.text.slice(0, 200),
    renderMeta: event.metadata,
    contentPayload: event.metadata,
  };
}

function parseJsonWebTokenExpiry(token: string | undefined): string | undefined {
  const raw = token?.trim();
  if (!raw) {
    return undefined;
  }

  const segments = raw.split(".");
  if (segments.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { exp?: number };
    if (typeof payload.exp !== "number") {
      return undefined;
    }
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return undefined;
  }
}

async function readTokenFromFile(filePath: string): Promise<string | undefined> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  const firstLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  if (!firstLine) {
    return undefined;
  }

  const equalsIndex = firstLine.indexOf("=");
  if (equalsIndex >= 0) {
    return firstLine.slice(equalsIndex + 1).trim();
  }

  return firstLine;
}

async function writeTokenToFile(filePath: string, token: string): Promise<void> {
  const nextContent = `RHCLAW_DEVICE_TOKEN=${token.trim()}\n`;
  await writeFile(filePath, nextContent, "utf8");
}

function shouldRefreshToken(tokenState: DeviceTokenState, thresholdMs: number): boolean {
  if (!tokenState.value) {
    return false;
  }

  const expiresAtMs = tokenState.expiresAt ? new Date(tokenState.expiresAt).getTime() : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return expiresAtMs - Date.now() <= thresholdMs;
}

function buildInboundMetadata(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};

  if (payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)) {
    Object.assign(metadata, payload.metadata as Record<string, unknown>);
  }

  if (payload.contentPayload && typeof payload.contentPayload === "object" && !Array.isArray(payload.contentPayload)) {
    metadata.contentPayload = payload.contentPayload;
  }

  if (payload.renderMeta && typeof payload.renderMeta === "object" && !Array.isArray(payload.renderMeta)) {
    metadata.renderMeta = payload.renderMeta;
  }

  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    metadata.attachments = payload.attachments;
  }

  if (typeof payload.messageType === "string" && payload.messageType.trim()) {
    metadata.messageType = payload.messageType;
  }

  if (typeof payload.contentFormat === "string" && payload.contentFormat.trim()) {
    metadata.contentFormat = payload.contentFormat;
  }

  if (typeof payload.commandNo === "string" && payload.commandNo.trim()) {
    metadata.commandNo = payload.commandNo;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function createRHClawServerClient(config: RHClawChannelConfig): RHClawServerClient {
  const baseUrl = normalizeUrl(config.serverUrl);
  const socketUrl = normalizeUrl(config.deviceSocketUrl);
  const deviceId = config.deviceId ?? "unknown-device";
  const connectionMode = config.connectionMode ?? "websocket";
  const heartbeatIntervalMs = Math.max((config.heartbeatIntervalSec ?? 30) * 1000, 5_000);
  const tokenRefreshThresholdMs = 10 * 60 * 1000;
  const tokenRefSource = config.gatewayTokenRef?.source ?? "env";
  const tokenRefId = config.gatewayTokenRef?.id?.trim();
  const tokenState: DeviceTokenState = {
    value: undefined,
    expiresAt: undefined,
  };
  let refreshInFlight: Promise<string | undefined> | null = null;

  const loadToken = async () => {
    if (tokenState.value?.trim()) {
      return tokenState.value;
    }

    if (tokenRefSource === "file" && tokenRefId) {
      const fileToken = await readTokenFromFile(tokenRefId);
      tokenState.value = fileToken?.trim() || undefined;
      tokenState.expiresAt = parseJsonWebTokenExpiry(tokenState.value);
      return tokenState.value;
    }

    if (tokenRefSource === "env" && tokenRefId) {
      tokenState.value = readTokenFromEnv(tokenRefId);
      tokenState.expiresAt = parseJsonWebTokenExpiry(tokenState.value);
      return tokenState.value;
    }

    return undefined;
  };

  const persistToken = async (token: string, expiresAt?: string) => {
    const normalizedToken = token.trim();
    tokenState.value = normalizedToken || undefined;
    tokenState.expiresAt = expiresAt || parseJsonWebTokenExpiry(normalizedToken);

    if (!normalizedToken) {
      return;
    }

    if (tokenRefSource === "file" && tokenRefId) {
      await writeTokenToFile(tokenRefId, normalizedToken).catch(() => undefined);
      return;
    }

    if (tokenRefSource === "env" && tokenRefId) {
      writeTokenToEnv(tokenRefId, normalizedToken);
    }
  };

  const refreshDeviceToken = async (force = false) => {
    if (!baseUrl || typeof fetch !== "function") {
      return loadToken();
    }

    const currentToken = await loadToken();
    if (!currentToken) {
      return undefined;
    }

    if (!force && !shouldRefreshToken(tokenState, tokenRefreshThresholdMs)) {
      return currentToken;
    }

    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const response = await fetch(buildControlPlaneUrl(baseUrl, "/auth/device/refresh"), {
        method: "POST",
        headers: {
          ...buildBaseHeaders(),
          authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({ reason: "rhclaw_channel_keepalive" }),
      });

      if (!response.ok) {
        const payload = await parseEnvelope<Record<string, unknown>>(response).catch(() => undefined);
        throw new Error(
          extractEnvelopeMessage(payload) || `RHClaw token refresh failed: ${response.status}`,
        );
      }

      const payload = await parseEnvelope<RHClawRefreshTokenResponse>(response);
      const nextToken = payload?.token.deviceToken?.trim();
      if (!nextToken) {
        throw new Error("RHClaw token refresh returned empty token");
      }

      await persistToken(nextToken, payload?.token.expiresAt);
      return nextToken;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  const requestWithAuth = async (
    path: string,
    init: RequestInit,
    retryOnUnauthorized = true,
  ) => {
    if (!baseUrl || typeof fetch !== "function") {
      return undefined;
    }

    const currentToken = await refreshDeviceToken(false);
    const response = await fetch(buildControlPlaneUrl(baseUrl, path), {
      ...init,
      headers: {
        ...buildBaseHeaders(),
        ...(init.headers ?? {}),
        ...(currentToken ? { authorization: `Bearer ${currentToken}` } : {}),
      },
    });

    if (response.status === 401 && retryOnUnauthorized) {
      const refreshedToken = await refreshDeviceToken(true).catch(() => undefined);
      if (!refreshedToken) {
        // Token refresh failed (e.g. cached token was revoked externally).
        // Clear cache and re-read from source — the file may contain a newer token.
        const staleToken = tokenState.value;
        tokenState.value = undefined;
        tokenState.expiresAt = undefined;
        const reloadedToken = await loadToken();
        if (!reloadedToken || reloadedToken === staleToken) {
          return response;
        }
        return fetch(buildControlPlaneUrl(baseUrl, path), {
          ...init,
          headers: {
            ...buildBaseHeaders(),
            ...(init.headers ?? {}),
            authorization: `Bearer ${reloadedToken}`,
          },
        });
      }

      return fetch(buildControlPlaneUrl(baseUrl, path), {
        ...init,
        headers: {
          ...buildBaseHeaders(),
          ...(init.headers ?? {}),
          authorization: `Bearer ${refreshedToken}`,
        },
      });
    }

    return response;
  };

  const reregisterDevice = async (): Promise<string | undefined> => {
    const deviceCode = config.deviceCode?.trim();
    if (!baseUrl || !deviceCode || typeof fetch !== "function") {
      return undefined;
    }

    const response = await fetch(buildControlPlaneUrl(baseUrl, "/api/v1/devices/register"), {
      method: "POST",
      headers: buildBaseHeaders(),
      body: JSON.stringify({
        deviceCode,
        platform: process.platform ?? "unknown",
        appVersion: "dev",
        protocolVersion: "1",
      }),
    });

    if (!response.ok) {
      const payload = await parseEnvelope<Record<string, unknown>>(response).catch(() => undefined);
      throw new Error(
        extractEnvelopeMessage(payload) || `RHClaw device re-register failed: ${response.status}`,
      );
    }

    const payload = await parseEnvelope<RHClawRegisterResponse>(response);
    const nextToken = payload?.token.deviceToken?.trim();
    if (!nextToken) {
      throw new Error("RHClaw device re-register returned empty token");
    }

    await persistToken(nextToken, payload?.token.expiresAt);
    return nextToken;
  };

  return {
    reregisterDevice,

    async getRuntimeContext() {
      if (baseUrl && typeof fetch === "function") {
        const response = await requestWithAuth(
          `/openclaw/plugin/rhclaw/device/${encodeURIComponent(deviceId)}/runtime-context`,
          {
            method: "GET",
          },
        );

        if (response?.ok) {
          const runtimeContext = await parseEnvelope<RHClawServerRuntimeContext>(response);
          if (runtimeContext) {
            return runtimeContext;
          }
        }
      }

      return {
        deviceId,
        defaultAgentId: config.defaultAgentId,
        allowFrom: config.allowFrom,
      };
    },

    async reportStatus(status) {
      if (!baseUrl || typeof fetch !== "function") {
        return;
      }

      await requestWithAuth("/openclaw/plugin/rhclaw/status", {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          ...status,
        }),
      }).catch(() => undefined);
    },

    async ackCommand(targetTaskId) {
      const response = await requestWithAuth("/commands/ack", {
        method: "POST",
        body: JSON.stringify({ targetTaskId }),
      });

      if (!response?.ok) {
        return undefined;
      }

      return parseEnvelope<RHClawAckResponse>(response);
    },

    async publishResult(event) {
      if (!baseUrl || typeof fetch !== "function") {
        return;
      }

      const response = await requestWithAuth("/openclaw/plugin/rhclaw/result", {
        method: "POST",
        body: JSON.stringify(event),
      }).catch(() => undefined);

      if (response && response.status !== 404) {
        return;
      }

      await requestWithAuth("/commands/result", {
        method: "POST",
        body: JSON.stringify(buildLegacyCommandResultPayload(event)),
      }).catch(() => undefined);
    },

    async connectDeviceSocket({ onInboundEvent, onOpen, onClose, onError, onHeartbeatAck, onSessionInvalidated }) {
      if (connectionMode === "polling" || !socketUrl || typeof WebSocket !== "function") {
        let closed = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const deliveredEventIds = new Set<string>();

        const schedulePoll = () => {
          if (closed) {
            return;
          }
          pollTimer = setTimeout(() => {
            void pollOnce();
          }, heartbeatIntervalMs);
        };

        const pollOnce = async () => {
          if (closed || !baseUrl || typeof fetch !== "function") {
            schedulePoll();
            return;
          }

          try {
            const response = await requestWithAuth(
              `/openclaw/plugin/rhclaw/device/${encodeURIComponent(deviceId)}/pending-events`,
              {
                method: "GET",
              },
            );

            if (!response?.ok) {
              throw new Error(`RHClaw pending-events failed: ${response?.status ?? "network"}`);
            }

            const payload = await parseEnvelope<RHClawPendingEventsResponse>(response);
            for (const item of payload?.items ?? []) {
              if (item.type === "heartbeat_ack") {
                onHeartbeatAck?.(item.timestamp ?? new Date().toISOString());
                continue;
              }

              if (!deliveredEventIds.has(item.payload.eventId)) {
                deliveredEventIds.add(item.payload.eventId);
                await onInboundEvent(item.payload);
              }
            }

            onHeartbeatAck?.(new Date().toISOString());
          } catch (error) {
            onError?.(error instanceof Error ? error : new Error("RHClaw pending-events polling failed"));
          } finally {
            schedulePoll();
          }
        };

        onOpen?.();
        void pollOnce();

        return {
          async close() {
            closed = true;
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = undefined;
            }
            onClose?.();
          },
        };
      }

      let manualClose = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let tokenRefreshTimer: ReturnType<typeof setInterval> | undefined;
      let socket: SocketIoSocket | null = null;

      const clearTimers = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        if (tokenRefreshTimer) {
          clearInterval(tokenRefreshTimer);
          tokenRefreshTimer = undefined;
        }
      };

      const sendHeartbeat = () => {
        if (!socket || !socket.connected) {
          return;
        }

        socket.emit("heartbeat", {
          deviceId,
          timestamp: new Date().toISOString(),
        });
      };

      const currentToken = await loadToken();

      const resolvedSocketUrl = socketUrl.replace(/^ws(s?):\/\//, (_, s) => `http${s}://`);

      socket = socketIoConnect(resolvedSocketUrl, {
        auth: { token: currentToken },
        transports: ["polling", "websocket"],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 30_000,
        reconnectionAttempts: Infinity,
        autoConnect: true,
      });

      socket.on("connect", () => {
        onOpen?.();
        sendHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
        tokenRefreshTimer = setInterval(() => {
          void refreshDeviceToken(false).catch((error) => {
            onError?.(error instanceof Error ? error : new Error("RHClaw token refresh failed"));
          });
        }, heartbeatIntervalMs);
      });

      socket.on("connected", (_data: unknown) => {
        // Server sends `connected` event after auth succeeds — already handled via `connect`.
      });

      socket.on("heartbeat_ack", (data: unknown) => {
        const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
        const ts = typeof record.receivedAt === "string"
          ? record.receivedAt
          : typeof record.timestamp === "string"
            ? record.timestamp
            : new Date().toISOString();
        onHeartbeatAck?.(ts);
      });

      socket.on("command.dispatched", async (data: unknown) => {
        try {
          if (!data || typeof data !== "object") {
            return;
          }
          const payload = data as Record<string, unknown>;
          const event: RHClawInboundEvent = {
            eventId: String(payload.commandId ?? payload.eventId ?? ""),
            taskId: String(payload.targetTaskId ?? payload.taskId ?? payload.commandId ?? ""),
            deviceId: String(payload.deviceId ?? deviceId),
            senderId: String(payload.senderId ?? payload.userId ?? "server"),
            sessionKey: payload.sessionKey ? String(payload.sessionKey) : undefined,
            text: String(payload.rawText ?? payload.commandText ?? payload.text ?? (payload.contentPayload as Record<string, unknown>)?.text ?? payload.content ?? ""),
            metadata: buildInboundMetadata(payload),
          };
          await onInboundEvent(event);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error("RHClaw command.dispatched handler error"));
        }
      });

      socket.on("subscription.updated", (_data: unknown) => {
        // Subscription status update — handle in future iteration.
      });

      socket.on("device.session.invalidated", (data: unknown) => {
        const reason = data && typeof data === "object" && "reason" in data
          ? String((data as Record<string, unknown>).reason)
          : "unknown";

        if (onSessionInvalidated) {
          void onSessionInvalidated(reason).then((recovered) => {
            if (recovered && socket) {
              // Force reconnect with the new token
              socket.auth = { token: tokenState.value };
              socket.disconnect().connect();
            } else {
              onError?.(new Error(`Device session invalidated: ${reason}`));
            }
          }).catch((err) => {
            onError?.(err instanceof Error ? err : new Error(`Device session invalidated: ${reason}`));
          });
        } else {
          onError?.(new Error(`Device session invalidated: ${reason}`));
        }
      });

      socket.on("disconnect", (reason: string) => {
        clearTimers();
        if (manualClose) return;

        // "io server disconnect" means the server kicked us (token revoked / auth fail).
        // Attempt automatic re-register before falling back to onClose.
        if (reason === "io server disconnect" && onSessionInvalidated) {
          void onSessionInvalidated(`server-disconnect:${reason}`)
            .then((recovered) => {
              if (recovered && socket) {
                socket.auth = { token: tokenState.value };
                socket.connect();
              } else {
                onClose?.();
              }
            })
            .catch(() => {
              onClose?.();
            });
          return;
        }

        onClose?.();
      });

      socket.on("connect_error", (error: Error) => {
        onError?.(new Error(`RHClaw Socket.IO connect error: ${error.message}`));
      });

      return {
        async close() {
          manualClose = true;
          clearTimers();
          socket?.disconnect();
          onClose?.();
        },
      };
    },
  };
}