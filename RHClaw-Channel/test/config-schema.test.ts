import assert from "node:assert/strict";
import test from "node:test";
import { rhclawPluginConfigSchema } from "../src/config-schema.ts";

test("config schema accepts a valid RHClaw config", () => {
  const config = {
    connectionMode: "polling",
    serverUrl: "https://rh.example.com",
    deviceSocketUrl: "wss://rh.example.com/device",
    deviceId: "device-001",
    allowFrom: ["server", "desktop"],
    heartbeatIntervalSec: 10,
  };

  const result = rhclawPluginConfigSchema.validate(config);

  assert.deepEqual(result, {
    ok: true,
    value: config,
  });
});

test("config schema rejects malformed RHClaw config", () => {
  const result = rhclawPluginConfigSchema.safeParse({
    connectionMode: "invalid",
    serverUrl: 1,
    allowFrom: "server",
    heartbeatIntervalSec: 3,
  });

  assert.equal(result.success, false);
  if (result.success) {
    assert.fail("expected schema validation to fail");
  }

  assert.deepEqual(
    [...result.error.issues.map((issue) => issue.message)].sort(),
    [
      "allowFrom must be a string array",
      "connectionMode must be websocket or polling",
      "heartbeatIntervalSec must be an integer >= 5",
      "serverUrl must be a string",
    ],
  );
});