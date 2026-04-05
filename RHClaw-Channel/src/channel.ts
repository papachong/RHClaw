import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { formatTextWithAttachmentLinks } from "openclaw/plugin-sdk/reply-payload";
import {
  listRHClawAccountIds,
  resolveDefaultRHClawAccountId,
  resolveRHClawAccount,
} from "./config.js";
import { mapRHInboundEventToEnvelope } from "./inbound.js";
import { buildRHOutboundEvent } from "./outbound.js";
import { getRHClawRuntime } from "./runtime.js";
import { createRHClawServerClient } from "./server-client.js";
import { RHClawSessionMap } from "./session-map.js";
import { rhclawStatus } from "./status.js";
import type { ResolvedRHClawAccount } from "./types.js";

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

type RuntimeRouteLike = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
};

type RuntimeChannelLike = {
  routing: {
    resolveAgentRoute: (params: {
      cfg: unknown;
      channel: string;
      accountId: string;
      peer: { kind: "direct"; id: string };
    }) => RuntimeRouteLike;
  };
  session: {
    resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
    readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
    recordInboundSession: (params: {
      storePath: string;
      sessionKey: string;
      ctx: unknown;
      onRecordError: (error: unknown) => void;
    }) => Promise<void>;
  };
  reply: {
    handleInboundMessage?: (payload: unknown) => Promise<void>;
    dispatchReplyWithBufferedBlockDispatcher: (params: {
      ctx: unknown;
      cfg: unknown;
      dispatcherOptions: {
        deliver: (payload: unknown) => Promise<void>;
        onError: (error: unknown, info: { kind: string }) => void;
      } & Record<string, unknown>;
      replyOptions?: Record<string, unknown>;
    }) => Promise<void>;
    finalizeInboundContext: (payload: Record<string, unknown>) => unknown;
    formatAgentEnvelope: (params: {
      channel: string;
      from: string;
      timestamp?: number;
      previousTimestamp?: number;
      envelope: unknown;
      body: string;
    }) => string;
    resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
  };
};

type RuntimeChannelCoreLike = {
  channel: RuntimeChannelLike;
};

type DirectInboundHandlerLike = (payload: unknown) => Promise<void>;

type RHClawReplyResult =
  | string
  | {
      text: string;
      metadata?: Record<string, unknown>;
      usage?: Record<string, unknown>;
      mediaUrls?: string[];
      mediaUrl?: string;
    };

type RHClawDispatchPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  metadata?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  message?: {
    usage?: Record<string, unknown>;
  };
  meta?: {
    agentMeta?: {
      usage?: Record<string, unknown>;
    };
  };
};

function resolveRuntimeChannel(runtime: unknown): RuntimeChannelCoreLike {
  if (
    runtime &&
    typeof runtime === "object" &&
    "channel" in runtime &&
    runtime.channel &&
    typeof runtime.channel === "object"
  ) {
    return runtime as RuntimeChannelCoreLike;
  }

  const pluginRuntime = getRHClawRuntime();
  if (
    pluginRuntime &&
    typeof pluginRuntime === "object" &&
    "channel" in pluginRuntime &&
    pluginRuntime.channel &&
    typeof pluginRuntime.channel === "object"
  ) {
    return pluginRuntime as RuntimeChannelCoreLike;
  }

  throw new Error("OpenClaw runtime.channel is unavailable for RHClaw inbound dispatch");
}

function resolveDirectInboundHandler(runtime: unknown): DirectInboundHandlerLike | undefined {
  const candidates: unknown[] = [runtime];

  try {
    candidates.push(getRHClawRuntime());
  } catch {
    // Ignore missing global runtime when a caller passes an explicit runtime object.
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const channel = "channel" in candidate ? (candidate as { channel?: unknown }).channel : undefined;
    if (!channel || typeof channel !== "object") {
      continue;
    }

    const reply = "reply" in channel ? (channel as { reply?: unknown }).reply : undefined;
    if (!reply || typeof reply !== "object") {
      continue;
    }

    const handleInboundMessage = "handleInboundMessage" in reply
      ? (reply as { handleInboundMessage?: unknown }).handleInboundMessage
      : undefined;
    if (typeof handleInboundMessage === "function") {
      return handleInboundMessage as DirectInboundHandlerLike;
    }
  }

  return undefined;
}

function resolveResultTextFromPayloads(payloads: RHClawDispatchPayload[]): string {
  const textParts = payloads
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean);
  const mediaUrls = payloads.flatMap((payload) => {
    if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) {
      return payload.mediaUrls;
    }
    if (payload.mediaUrl) {
      return [payload.mediaUrl];
    }
    return [];
  });
  return formatTextWithAttachmentLinks(textParts.join("\n\n"), mediaUrls).trim();
}

function resolveInboundMediaUrls(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }

  const mediaUrls = new Set<string>();
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }

    const record = attachment as Record<string, unknown>;
    const candidate = [record.url, record.downloadUrl, record.storageUrl].find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (typeof candidate === "string" && candidate.trim()) {
      mediaUrls.add(candidate.trim());
    }
  }

  const contentPayload =
    metadata.contentPayload &&
    typeof metadata.contentPayload === "object" &&
    !Array.isArray(metadata.contentPayload)
      ? (metadata.contentPayload as Record<string, unknown>)
      : undefined;
  const blocks = Array.isArray(contentPayload?.blocks) ? contentPayload!.blocks : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }

    const url = (block as Record<string, unknown>).url;
    if (typeof url === "string" && url.trim()) {
      mediaUrls.add(url.trim());
    }
  }

  return [...mediaUrls];
}

function resolveInboundEventText(event: { text: string; metadata?: Record<string, unknown> }): string {
  const mediaUrls = resolveInboundMediaUrls(event.metadata);
  return formatTextWithAttachmentLinks(event.text.trim(), mediaUrls).trim();
}

function resolveUsageFromPayloads(payloads: RHClawDispatchPayload[]): Record<string, unknown> | undefined {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)) {
      return payload.usage;
    }
    if (payload.message?.usage && typeof payload.message.usage === "object" && !Array.isArray(payload.message.usage)) {
      return payload.message.usage;
    }
    if (
      payload.meta?.agentMeta?.usage &&
      typeof payload.meta.agentMeta.usage === "object" &&
      !Array.isArray(payload.meta.agentMeta.usage)
    ) {
      return payload.meta.agentMeta.usage;
    }
  }

  return undefined;
}

function normalizeReplyResult(result: RHClawReplyResult): {
  text: string;
  metadata?: Record<string, unknown>;
} {
  if (typeof result === "string") {
    return { text: result };
  }

  return {
    text: result.text,
    metadata: {
      ...(result.metadata ?? {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.mediaUrls ? { mediaUrls: result.mediaUrls } : {}),
      ...(result.mediaUrl ? { mediaUrl: result.mediaUrl } : {}),
    },
  };
}

async function dispatchViaRuntimeChannel(params: {
  cfg: unknown;
  runtime: unknown;
  accountId: string;
  event: {
    eventId: string;
    taskId: string;
    deviceId: string;
    senderId: string;
    sessionKey?: string;
    text: string;
    metadata?: Record<string, unknown>;
  };
  sessionKey: string;
  client: ReturnType<typeof createRHClawServerClient>;
  ctx: {
    log?: {
      error?: (message: string) => void;
      warn?: (message: string) => void;
    };
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (status: ChannelAccountSnapshot) => void;
  };
}): Promise<void> {
  const inboundText = resolveInboundEventText(params.event);
  const directInboundHandler = resolveDirectInboundHandler(params.runtime);
  if (directInboundHandler) {
    const directEnvelope = mapRHInboundEventToEnvelope({
      accountId: params.accountId,
      event: {
        ...params.event,
        text: inboundText,
      },
    });

    await directInboundHandler({
      ...directEnvelope,
      sessionKey: params.sessionKey,
    });

    params.ctx.setStatus({
      ...params.ctx.getStatus(),
      lastOutboundAt: Date.now(),
      connectionState: "connected",
    });
    return;
  }

  const core = resolveRuntimeChannel(params.runtime);
  const outboundPayloads: RHClawDispatchPayload[] = [];

  const { route } = await dispatchInboundDirectDmWithRuntime({
    cfg: params.cfg as any,
    runtime: core,
    channel: "rhclaw",
    channelLabel: "RHClaw",
    accountId: params.accountId,
    peer: { kind: "direct", id: params.event.deviceId },
    senderId: params.event.senderId,
    senderAddress: `rhclaw:${params.event.senderId}`,
    recipientAddress: `rhclaw:${params.event.deviceId}`,
    conversationLabel: params.event.senderId,
    rawBody: inboundText,
    messageId: params.event.taskId,
    bodyForAgent: inboundText,
    commandBody: inboundText,
    provider: "rhclaw",
    surface: "rhclaw",
    originatingChannel: "rhclaw",
    originatingTo: `rhclaw:${params.event.deviceId}`,
    extraContext: {
      RenderMeta: params.event.metadata?.renderMeta,
      ContentPayload: params.event.metadata?.contentPayload,
      Attachments: params.event.metadata?.attachments,
    },
    deliver: async (payload: unknown) => {
      outboundPayloads.push(payload as RHClawDispatchPayload);
    },
    onRecordError: (error) => {
      params.ctx.log?.error?.(`[rhclaw] account=${params.accountId} session record failed: ${String(error)}`);
    },
    onDispatchError: (error, info) => {
      params.ctx.log?.error?.(`[rhclaw] account=${params.accountId} ${info.kind} reply failed: ${String(error)}`);
    },
  });

  const responseText = resolveResultTextFromPayloads(outboundPayloads);
  const usage = resolveUsageFromPayloads(outboundPayloads);
  if (!responseText) {
    params.ctx.log?.warn?.(
      `[rhclaw] account=${params.accountId} task=${params.event.taskId} dispatch completed without reply output`,
    );
    await params.client.publishResult(
      buildRHOutboundEvent({
        deviceId: params.event.deviceId,
        taskId: params.event.taskId,
        sessionKey: params.event.sessionKey,
        text: "[OpenClaw] 未生成回复内容，请稍后重试。",
        status: "failed",
        metadata: {
          agentId: route.agentId,
          delivery: "runtime-channel-dispatch",
          error: "empty-reply",
        },
      }),
    );
    return;
  }

  await params.client.publishResult(
    buildRHOutboundEvent({
      deviceId: params.event.deviceId,
      taskId: params.event.taskId,
      sessionKey: params.event.sessionKey,
      text: responseText,
      status: "succeeded",
      metadata: {
        agentId: route.agentId,
        delivery: "runtime-channel-dispatch",
        ...(usage ? { usage } : {}),
      },
    }),
  );

  params.ctx.setStatus({
    ...params.ctx.getStatus(),
    lastOutboundAt: Date.now(),
    connectionState: "connected",
  });
}

export const rhclawPlugin: ChannelPlugin<ResolvedRHClawAccount> = {
  id: "rhclaw",
  meta: {
    id: "rhclaw",
    label: "RHClaw Channel",
    selectionLabel: "RHClaw Channel",
    docsPath: "/channels/rhclaw",
    docsLabel: "rhclaw",
    blurb: "RHOpenClaw custom channel bridge.",
    order: 95,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.rhclaw", "bindings"] },
  config: {
    listAccountIds: (cfg) => listRHClawAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveRHClawAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultRHClawAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      serverUrl: account.config.serverUrl ?? null,
      deviceSocketUrl: account.config.deviceSocketUrl ?? null,
      deviceId: account.config.deviceId ?? null,
      defaultAgentId: account.config.defaultAgentId ?? null,
    }),
    resolveAllowFrom: ({ cfg }) => resolveRHClawAccount(cfg).config.allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy === "open" ? "open" : "allowlist",
      allowFrom: account.config.allowFrom ?? ["server"],
      policyPath: "channels.rhclaw.dmPolicy",
      allowFromPath: "channels.rhclaw.allowFrom",
      approveHint: "通过 RHOpenClaw-Server 或 Desktop 管理端配置 allowFrom。",
      normalizeEntry: (raw) => raw.trim(),
    }),
  },
  status: rhclawStatus,
  gateway: {
    startAccount: async (ctx) => {
      const sessionMap = new RHClawSessionMap();
      const client = createRHClawServerClient(ctx.account.config);
      let shuttingDown = false;

      ctx.setStatus({
        ...ctx.getStatus(),
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
        connectionState: "starting",
      });

      if (!ctx.account.configured) {
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastError: "RHClaw channel is not configured",
          connectionState: "unconfigured",
        });
        throw new Error("RHClaw channel is not configured");
      }

      const runtimeContext = await client.getRuntimeContext();
      ctx.log?.info?.(
        `[rhclaw] account=${ctx.accountId} deviceId=${ctx.account.config.deviceId ?? "unset"} skeleton runtime started`,
      );

      const socketHandle = await client.connectDeviceSocket({
        onOpen: () => {
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connectionState: "connected",
            lastHeartbeatAt: Date.now(),
          });
          void client.reportStatus({
            accountId: ctx.accountId,
            connectionState: "connected",
          });
        },
        onClose: () => {
          ctx.setStatus({
            ...ctx.getStatus(),
            running: !shuttingDown,
            connectionState: shuttingDown ? "stopped" : "reconnecting",
          });
        },
        onHeartbeatAck: () => {
          ctx.setStatus({
            ...ctx.getStatus(),
            lastHeartbeatAt: Date.now(),
            connectionState: "connected",
          });
        },
        onError: (error) => {
          if (shuttingDown) {
            return;
          }

          ctx.log?.error?.(`[rhclaw] account=${ctx.accountId} runtime error: ${error.message}`);

          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
            connectionState: "error",
          });
        },
        onSessionInvalidated: async (reason) => {
          ctx.log?.error?.(`[rhclaw] account=${ctx.accountId} session invalidated: ${reason}, attempting re-register...`);

          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: `Session invalidated: ${reason}`,
            connectionState: "reconnecting",
          });

          try {
            const newToken = await client.reregisterDevice();
            if (newToken) {
              ctx.log?.info?.(`[rhclaw] account=${ctx.accountId} re-register succeeded, reconnecting...`);
              return true;
            }
            ctx.log?.error?.(`[rhclaw] account=${ctx.accountId} re-register returned no token (deviceCode may be missing)`);
            ctx.setStatus({
              ...ctx.getStatus(),
              lastError: `Session invalidated: ${reason} (re-register failed: no deviceCode)`,
              connectionState: "error",
            });
            return false;
          } catch (err) {
            ctx.log?.error?.(`[rhclaw] account=${ctx.accountId} re-register failed: ${String(err)}`);
            ctx.setStatus({
              ...ctx.getStatus(),
              lastError: `Session invalidated: ${reason} (re-register error: ${String(err)})`,
              connectionState: "error",
            });
            return false;
          }
        },
        onInboundEvent: async (event) => {
          try {
            await client.ackCommand(event.taskId);
          } catch (ackError) {
            ctx.log?.warn?.(
              `[rhclaw] account=${ctx.accountId} task=${event.taskId} ack failed, continuing dispatch: ${String(ackError)}`,
            );
          }

          const envelope = mapRHInboundEventToEnvelope({
            accountId: ctx.accountId,
            event,
            defaultAgentId: runtimeContext.defaultAgentId,
          });

          sessionMap.set({
            sessionKey: envelope.sessionKey ?? `${event.deviceId}:${event.taskId}`,
            taskId: event.taskId,
            deviceId: event.deviceId,
            agentId: runtimeContext.defaultAgentId,
            createdAt: new Date().toISOString(),
          });

          ctx.setStatus({
            ...ctx.getStatus(),
            lastInboundAt: Date.now(),
            connectionState: "processing",
          });

          try {
            await dispatchViaRuntimeChannel({
              cfg: ctx.cfg,
              runtime: ctx.runtime,
              accountId: ctx.accountId,
              event,
              sessionKey: envelope.sessionKey ?? `agent:${runtimeContext.defaultAgentId ?? "main"}:rhclaw:${event.taskId}`,
              client,
              ctx,
            });
          } catch (dispatchError) {
            ctx.log?.error?.(
              `[rhclaw] account=${ctx.accountId} task=${event.taskId} inbound dispatch failed: ${String(dispatchError)}`,
            );

            try {
              await client.publishResult(
                buildRHOutboundEvent({
                  deviceId: event.deviceId,
                  taskId: event.taskId,
                  sessionKey: event.sessionKey,
                  text: "[OpenClaw] 消息处理失败，请稍后重试。",
                  status: "failed",
                  metadata: {
                    error: String(dispatchError),
                  },
                }),
              );
            } catch (publishError) {
              ctx.log?.error?.(
                `[rhclaw] account=${ctx.accountId} task=${event.taskId} error result publish failed: ${String(publishError)}`,
              );
            }

            ctx.setStatus({
              ...ctx.getStatus(),
              lastError: String(dispatchError),
              connectionState: "connected",
            });
          }
        },
      });

      const abortListener = () => {
        void socketHandle.close();
      };
      ctx.abortSignal.addEventListener("abort", abortListener, { once: true });

      ctx.setStatus({
        ...ctx.getStatus(),
        running: true,
        connectionState: "ready-for-bridge",
        lastHeartbeatAt: Date.now(),
      });

      await client.reportStatus({
        accountId: ctx.accountId,
        connectionState: "ready-for-bridge",
        deviceId: runtimeContext.deviceId,
        defaultAgentId: runtimeContext.defaultAgentId,
        sessionBindings: sessionMap.list().length,
      });

      try {
        await waitForAbortSignal(ctx.abortSignal);
      } finally {
        shuttingDown = true;
        await socketHandle.close();
      }
    },
    stopAccount: async (ctx) => {
      const client = createRHClawServerClient(ctx.account.config);
      ctx.log?.info?.(`[rhclaw] account=${ctx.accountId} skeleton runtime stopped`);
      await client.reportStatus({
        accountId: ctx.accountId,
        connectionState: "stopped",
      });
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        lastStopAt: Date.now(),
        connectionState: "stopped",
      });
    },
  },
};