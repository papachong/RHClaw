import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk/status-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedRHClawAccount } from "./types.js";

export const rhclawStatus: NonNullable<ChannelPlugin<ResolvedRHClawAccount>["status"]> = {
  defaultRuntime: {
    accountId: "default",
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    connectionState: "idle",
    lastHeartbeatAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("rhclaw", accounts),
  buildChannelSummary: ({ snapshot }) =>
    buildBaseChannelStatusSummary({
      configured: snapshot.configured,
      running: snapshot.running,
      lastStartAt: snapshot.lastStartAt,
      lastStopAt: snapshot.lastStopAt,
      lastError: snapshot.lastError,
    }),
  buildAccountSnapshot: ({ account, runtime }) => ({
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    running: runtime?.running ?? false,
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    lastHeartbeatAt:
      typeof runtime?.lastHeartbeatAt === "number" ? runtime.lastHeartbeatAt : null,
    lastInboundAt:
      typeof runtime?.lastInboundAt === "number" ? runtime.lastInboundAt : null,
    lastOutboundAt:
      typeof runtime?.lastOutboundAt === "number" ? runtime.lastOutboundAt : null,
    connectionState:
      typeof runtime?.connectionState === "string" ? runtime.connectionState : "idle",
  }),
};