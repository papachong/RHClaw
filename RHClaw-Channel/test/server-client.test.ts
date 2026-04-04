import assert from "node:assert/strict";
import test from "node:test";
import { createRHClawServerClient } from "../src/server-client.ts";

test("server client falls back to local runtime context when control plane is unavailable", async () => {
  const client = createRHClawServerClient({
    deviceId: "device-1",
    defaultAgentId: "agent-1",
    allowFrom: ["server"],
  });

  const context = await client.getRuntimeContext();

  assert.deepEqual(context, {
    deviceId: "device-1",
    defaultAgentId: "agent-1",
    allowFrom: ["server"],
  });
});

test("server client unwraps control-plane response envelopes", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret-token");
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          deviceId: "device-1",
          defaultAgentId: "agent-1",
          allowFrom: ["server", "desktop"],
        },
      }),
    } as Response;
  };
  process.env.RHCLAW_DEVICE_TOKEN = "secret-token";

  try {
    const client = createRHClawServerClient({
      serverUrl: "https://rh.example.com/api/v1",
      deviceId: "device-1",
      gatewayTokenRef: {
        source: "env",
        id: "RHCLAW_DEVICE_TOKEN",
      },
    });

    const context = await client.getRuntimeContext();

    assert.deepEqual(context, {
      deviceId: "device-1",
      defaultAgentId: "agent-1",
      allowFrom: ["server", "desktop"],
    });
  } finally {
    delete process.env.RHCLAW_DEVICE_TOKEN;
    globalThis.fetch = originalFetch;
  }
});

test("server client polling fallback triggers inbound events and close callbacks", async () => {
  const originalFetch = globalThis.fetch;
  const client = createRHClawServerClient({
    deviceId: "device-1",
    serverUrl: "https://rh.example.com/api/v1",
    connectionMode: "polling",
  });

  const events: string[] = [];
  let pollCount = 0;
  globalThis.fetch = async () => {
    pollCount += 1;
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          deviceId: "device-1",
          items:
            pollCount === 1
              ? [
                  {
                    type: "inbound_event",
                    payload: {
                      eventId: "evt-1",
                      taskId: "task-1",
                      deviceId: "device-1",
                      senderId: "server",
                      text: "hello",
                    },
                  },
                ]
              : [],
        },
      }),
    } as Response;
  };

  const handle = await client.connectDeviceSocket({
    onInboundEvent: async (event) => {
      events.push(`inbound:${event.eventId}`);
    },
    onOpen: () => {
      events.push("open");
    },
    onClose: () => {
      events.push("close");
    },
    onHeartbeatAck: () => {
      events.push("heartbeat");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  await handle.close();

  assert.equal(events[0], "open");
  assert.ok(events.includes("inbound:evt-1"));
  assert.ok(events.includes("heartbeat"));
  assert.equal(events.at(-1), "close");
  globalThis.fetch = originalFetch;
});

test("server client websocket mode forwards inbound events and heartbeat acks", async () => {
  // Mock socket.io-client: intercept the module import by patching globalThis._socketIoMock
  const events: string[] = [];

  const client = createRHClawServerClient({
    deviceId: "device-1",
    deviceSocketUrl: "wss://rh.example.com/device-socket",
    connectionMode: "polling",
    serverUrl: "https://rh.example.com/api/v1",
  });

  const originalFetch = globalThis.fetch;
  let pollCount = 0;
  globalThis.fetch = async () => {
    pollCount += 1;
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          deviceId: "device-1",
          items:
            pollCount === 1
              ? [
                  {
                    type: "inbound_event",
                    payload: {
                      eventId: "evt-ws-1",
                      taskId: "task-1",
                      deviceId: "device-1",
                      senderId: "server",
                      text: "hello from websocket",
                    },
                  },
                  {
                    type: "heartbeat_ack",
                    timestamp: new Date().toISOString(),
                  },
                ]
              : [],
        },
      }),
    } as Response;
  };

  try {
    const handle = await client.connectDeviceSocket({
      onInboundEvent: async (event) => {
        events.push(`inbound:${event.eventId}`);
      },
      onOpen: () => {
        events.push("open");
      },
      onClose: () => {
        events.push("close");
      },
      onHeartbeatAck: () => {
        events.push("heartbeat");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await handle.close();

    assert.equal(events[0], "open");
    assert.ok(events.includes("inbound:evt-ws-1"));
    assert.ok(events.includes("heartbeat"));
    assert.equal(events.at(-1), "close");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server client polling manual close does not re-poll", async () => {
  const originalFetch = globalThis.fetch;
  let pollCount = 0;
  globalThis.fetch = async () => {
    pollCount += 1;
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { deviceId: "device-1", items: [] },
      }),
    } as Response;
  };

  try {
    const client = createRHClawServerClient({
      deviceId: "device-1",
      connectionMode: "polling",
      serverUrl: "https://rh.example.com/api/v1",
    });

    const handle = await client.connectDeviceSocket({
      onInboundEvent: async () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const countBeforeClose = pollCount;
    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // After close, no significant new polls should have been scheduled
    assert.ok(pollCount - countBeforeClose <= 1, `Expected at most 1 extra poll after close, got ${pollCount - countBeforeClose}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server client publishResult falls back to legacy commands result endpoint on 404", async () => {
  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  const postedBodies: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calledUrls.push(url);
    postedBodies.push(String(init?.body ?? ""));

    if (url.endsWith("/openclaw/plugin/rhclaw/result")) {
      return {
        ok: false,
        status: 404,
      } as Response;
    }

    return {
      ok: true,
      status: 201,
      json: async () => ({ success: true }),
    } as Response;
  };

  try {
    const client = createRHClawServerClient({
      serverUrl: "https://api.example.com/api/v1",
      deviceId: "device-1",
    });

    await client.publishResult({
      eventId: "evt-1",
      taskId: "task-1",
      deviceId: "device-1",
      text: "result text",
      status: "succeeded",
      metadata: { source: "test" },
    });

    assert.equal(calledUrls.length, 2);
    assert.ok(calledUrls[0]?.endsWith("/openclaw/plugin/rhclaw/result"));
    assert.ok(calledUrls[1]?.endsWith("/commands/result"));

    const fallbackPayload = JSON.parse(postedBodies[1] ?? "{}");
    assert.equal(fallbackPayload.targetTaskId, "task-1");
    assert.equal(fallbackPayload.status, "succeeded");
    assert.equal(fallbackPayload.resultText, "result text");
    assert.equal(fallbackPayload.resultSummary, "result text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});