import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RHClawChannelConfig, ResolvedRHClawAccount } from "./types.js";

export const DEFAULT_RHCLAW_ACCOUNT_ID = "default";

function readRawRHClawConfig(cfg: OpenClawConfig): RHClawChannelConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const raw = (channels.rhclaw ?? {}) as RHClawChannelConfig;
  return raw;
}

export function listRHClawAccountIds(_cfg: OpenClawConfig): string[] {
  return [DEFAULT_RHCLAW_ACCOUNT_ID];
}

export function resolveRHClawAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedRHClawAccount {
  const resolvedAccountId = accountId?.trim() || DEFAULT_RHCLAW_ACCOUNT_ID;
  const channelConfig = readRawRHClawConfig(cfg);
  const configured = Boolean(channelConfig.serverUrl && channelConfig.deviceSocketUrl);

  return {
    accountId: resolvedAccountId,
    name: channelConfig.deviceName?.trim() || "RHClaw Device",
    enabled: channelConfig.enabled !== false,
    configured,
    config: channelConfig,
  };
}

export function resolveDefaultRHClawAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_RHCLAW_ACCOUNT_ID;
}