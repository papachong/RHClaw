declare module "openclaw/plugin-sdk/core" {
  export type OpenClawConfig = {
    channels?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
  };

  export type PluginRuntime = Record<string, unknown>;

  export type OpenClawPluginConfigSchema = {
    validate: (value: unknown) => { ok: true; value: unknown } | { ok: false; errors: string[] };
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ path: unknown[]; message: string }> } };
    jsonSchema: unknown;
    uiHints?: Record<string, unknown>;
  };

  export type ChannelAccountSnapshot = {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    running?: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
    lastHeartbeatAt?: number | null;
    connectionState?: string;
    [key: string]: unknown;
  };

  export type ChannelGatewayContext<TAccount> = {
    accountId: string;
    account: TAccount;
    abortSignal: AbortSignal;
    cfg?: unknown;
    runtime?: unknown;
    channelRuntime?: {
      reply?: {
        handleInboundMessage?: (params: unknown) => Promise<void>;
      };
    };
    log?: {
      info?: (message: string) => void;
      warn?: (message: string) => void;
      error?: (message: string) => void;
    };
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (status: ChannelAccountSnapshot) => void;
  };

  export type ChannelPlugin<TAccount = any> = {
    id: string;
    meta: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    reload?: Record<string, unknown>;
    config: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
      defaultAccountId: (cfg: OpenClawConfig) => string;
      isConfigured: (account: TAccount) => boolean;
      describeAccount: (account: TAccount, cfg: OpenClawConfig) => Record<string, unknown>;
      resolveAllowFrom: (params: { cfg: OpenClawConfig }) => string[] | undefined;
      formatAllowFrom: (params: { allowFrom: unknown[] }) => string[];
    };
    security?: {
      resolveDmPolicy: (params: {
        account: TAccount & {
          config: {
            dmPolicy?: string;
            allowFrom?: string[];
          };
        };
      }) => {
        policy: string;
        allowFrom: string[];
        policyPath: string;
        allowFromPath: string;
        approveHint: string;
        normalizeEntry: (raw: string) => string;
      };
    };
    status?: {
      defaultRuntime: ChannelAccountSnapshot;
      collectStatusIssues: (accounts: ChannelAccountSnapshot[]) => unknown[];
      buildChannelSummary: (params: { snapshot: ChannelAccountSnapshot }) => Record<string, unknown>;
      buildAccountSnapshot: (params: {
        account: TAccount & {
          accountId: string;
          name: string;
          enabled: boolean;
          configured: boolean;
        };
        runtime?: ChannelAccountSnapshot;
      }) => Record<string, unknown>;
    };
    gateway?: {
      startAccount: (ctx: ChannelGatewayContext<TAccount>) => Promise<unknown>;
      stopAccount: (ctx: ChannelGatewayContext<TAccount>) => Promise<void>;
    };
  };

  export type OpenClawPluginApi = {
    runtime: PluginRuntime;
    registerChannel: <TAccount>(params: { plugin: ChannelPlugin<TAccount> }) => void;
  };
}

declare module "openclaw/plugin-sdk/status-helpers" {
  import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/core";

  export function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(
    accountId: string,
    extras?: T,
  ): {
    accountId: string;
    running: false;
    lastStartAt: null;
    lastStopAt: null;
    lastError: null;
  } & T;

  export function buildBaseChannelStatusSummary(snapshot: {
    configured?: boolean;
    running?: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  }): Record<string, unknown>;

  export function collectStatusIssuesFromLastError(
    channelId: string,
    accounts: ChannelAccountSnapshot[],
  ): unknown[];
}

declare module "openclaw/plugin-sdk/reply-payload" {
  export type OutboundReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
  };

  export function formatTextWithAttachmentLinks(text: string, mediaUrls: string[]): string;
}

declare module "openclaw/plugin-sdk/channel-inbound" {
  export function dispatchInboundDirectDmWithRuntime(params: {
    cfg: unknown;
    runtime: unknown;
    channel: string;
    channelLabel: string;
    accountId: string;
    peer: { kind: "direct"; id: string };
    senderId: string;
    senderAddress: string;
    recipientAddress: string;
    conversationLabel: string;
    rawBody: string;
    messageId: string;
    timestamp?: number;
    commandAuthorized?: boolean;
    bodyForAgent?: string;
    commandBody?: string;
    provider?: string;
    surface?: string;
    originatingChannel?: string;
    originatingTo?: string;
    extraContext?: Record<string, unknown>;
    deliver: (payload: unknown) => Promise<void>;
    onRecordError: (err: unknown) => void;
    onDispatchError: (err: unknown, info: { kind: string }) => void;
  }): Promise<{
    route: { agentId: string; sessionKey: string; accountId?: string };
    storePath: string;
    ctxPayload: unknown;
  }>;
}

declare module "openclaw/plugin-sdk" {
  export * from "openclaw/plugin-sdk/core";
}