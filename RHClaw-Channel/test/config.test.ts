import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RHCLAW_ACCOUNT_ID,
  listRHClawAccountIds,
  resolveDefaultRHClawAccountId,
  resolveRHClawAccount,
} from "../src/config.ts";

test("config helpers expose the default RHClaw account", () => {
  const cfg = {
    channels: {
      rhclaw: {
        enabled: true,
      },
    },
  };

  assert.deepEqual(listRHClawAccountIds(cfg), [DEFAULT_RHCLAW_ACCOUNT_ID]);
  assert.equal(resolveDefaultRHClawAccountId(cfg), DEFAULT_RHCLAW_ACCOUNT_ID);
});

test("resolveRHClawAccount detects configured state and trims display name", () => {
  const cfg = {
    channels: {
      rhclaw: {
        enabled: true,
        serverUrl: "https://rh.example.com",
        deviceSocketUrl: "wss://rh.example.com/device",
        deviceName: "  门店设备  ",
      },
    },
  };

  const account = resolveRHClawAccount(cfg, " custom ");

  assert.equal(account.accountId, "custom");
  assert.equal(account.enabled, true);
  assert.equal(account.configured, true);
  assert.equal(account.name, "门店设备");
});

test("resolveRHClawAccount falls back when config is partial or disabled", () => {
  const cfg = {
    channels: {
      rhclaw: {
        enabled: false,
        serverUrl: "https://rh.example.com",
      },
    },
  };

  const account = resolveRHClawAccount(cfg);

  assert.equal(account.accountId, DEFAULT_RHCLAW_ACCOUNT_ID);
  assert.equal(account.enabled, false);
  assert.equal(account.configured, false);
  assert.equal(account.name, "RHClaw Device");
});