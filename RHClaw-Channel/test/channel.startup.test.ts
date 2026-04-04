import assert from "node:assert/strict";
import test from "node:test";
import { rhclawPlugin } from "../src/channel.ts";

test("rhclaw startAccount stays pending until abort", async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const statuses: Array<Record<string, unknown>> = [];
  const statusPayloads: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.endsWith("/runtime-context")) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            deviceId: "device-1",
            defaultAgentId: "main",
            allowFrom: ["server"],
          },
        }),
      } as Response;
    }

    if (url.endsWith("/pending-events")) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            deviceId: "device-1",
            items: [],
          },
        }),
      } as Response;
    }

    if (url.endsWith("/openclaw/plugin/rhclaw/status")) {
      statusPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true }),
      } as Response;
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const snapshot: Record<string, unknown> = {
      accountId: "default",
      configured: true,
      enabled: true,
      running: false,
    };

    const task = rhclawPlugin.gateway!.startAccount!({
      accountId: "default",
      account: {
        accountId: "default",
        configured: true,
        enabled: true,
        name: "RHClaw Device",
        config: {
          serverUrl: "https://api.example.com/api/v1",
          deviceSocketUrl: "wss://api.example.com/device",
          deviceId: "device-1",
          connectionMode: "polling",
          defaultAgentId: "main",
          allowFrom: ["server"],
          dmPolicy: "allowlist",
        },
      },
      cfg: {},
      runtime: {},
      abortSignal: abort.signal,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      getStatus: () => snapshot,
      setStatus: (next) => {
        Object.assign(snapshot, next);
        statuses.push({ ...snapshot });
      },
    } as never);

    let settled = false;
    void task.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);

    abort.abort();
    await task;

    assert.equal(settled, true);
    assert.ok(statuses.some((status) => status.connectionState === "ready-for-bridge"));
    assert.ok(statuses.some((status) => status.connectionState === "stopped"));
    assert.ok(statusPayloads.length >= 2);
    assert.ok(statusPayloads.every((payload) => !("running" in payload)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rhclaw forwards inbound polling events through the available reply handler", async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const handled: Array<Record<string, unknown>> = [];
  let pendingEventsCalls = 0;

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.endsWith("/runtime-context")) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            deviceId: "device-1",
            defaultAgentId: "main",
            allowFrom: ["server"],
          },
        }),
      } as Response;
    }

    if (url.endsWith("/pending-events")) {
      pendingEventsCalls += 1;
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            deviceId: "device-1",
            items: pendingEventsCalls === 1
              ? [
                  {
                    type: "inbound_event",
                    payload: {
                      eventId: "evt-1",
                      taskId: "task-1",
                      deviceId: "device-1",
                      senderId: "server",
                      sessionKey: "task-1",
                      text: "hello from server",
                    },
                  },
                ]
              : [],
          },
        }),
      } as Response;
    }

    if (url.endsWith("/openclaw/plugin/rhclaw/status")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true }),
      } as Response;
    }

    if (url.endsWith("/openclaw/plugin/rhclaw/result")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true }),
      } as Response;
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const snapshot: Record<string, unknown> = {
      accountId: "default",
      configured: true,
      enabled: true,
      running: false,
    };

    const task = rhclawPlugin.gateway!.startAccount!({
      accountId: "default",
      account: {
        accountId: "default",
        configured: true,
        enabled: true,
        name: "RHClaw Device",
        config: {
          serverUrl: "https://api.example.com/api/v1",
          deviceSocketUrl: "wss://api.example.com/device",
          deviceId: "device-1",
          connectionMode: "polling",
          heartbeatIntervalSec: 1,
          defaultAgentId: "main",
          allowFrom: ["server"],
          dmPolicy: "allowlist",
        },
      },
      cfg: {},
      runtime: {
        channel: {
          reply: {
            handleInboundMessage: async (payload: unknown) => {
              handled.push(payload as Record<string, unknown>);
              abort.abort();
            },
          },
        },
      },
      abortSignal: abort.signal,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      getStatus: () => snapshot,
      setStatus: (next) => {
        Object.assign(snapshot, next);
      },
    } as never);

    await task;

    assert.equal(handled.length, 1);
    assert.equal(handled[0]?.channel, "rhclaw");
    assert.equal(handled[0]?.text, "hello from server");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rhclaw falls back to runtime channel dispatch when direct inbound handler is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const publishedBodies: Array<Record<string, unknown>> = [];
  let pendingEventsCalls = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.endsWith("/runtime-context")) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            deviceId: "device-1",
            defaultAgentId: "main",
            allowFrom: ["server"],
          },
        }),
      } as Response;
    }

    if (url.endsWith("/pending-events")) {
      pendingEventsCalls += 1;
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            deviceId: "device-1",
            items: pendingEventsCalls === 1
              ? [
                  {
                    type: "inbound_event",
                    payload: {
                      eventId: "evt-1",
                      taskId: "task-1",
                      deviceId: "device-1",
                      senderId: "server",
                      sessionKey: "task-1",
                      text: "hello from server",
                    },
                  },
                ]
              : [],
          },
        }),
      } as Response;
    }

    if (url.endsWith("/openclaw/plugin/rhclaw/status")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true }),
      } as Response;
    }

    if (url.endsWith("/openclaw/plugin/rhclaw/result")) {
      publishedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      abort.abort();
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true }),
      } as Response;
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const snapshot: Record<string, unknown> = {
      accountId: "default",
      configured: true,
      enabled: true,
      running: false,
    };

    await rhclawPlugin.gateway!.startAccount!({
      accountId: "default",
      account: {
        accountId: "default",
        configured: true,
        enabled: true,
        name: "RHClaw Device",
        config: {
          serverUrl: "https://api.example.com/api/v1",
          deviceSocketUrl: "wss://api.example.com/device",
          deviceId: "device-1",
          connectionMode: "polling",
          heartbeatIntervalSec: 1,
          defaultAgentId: "main",
          allowFrom: ["server"],
          dmPolicy: "allowlist",
        },
      },
      cfg: {},
      runtime: {
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              agentId: "main",
              sessionKey: "agent:main:task-1",
              accountId: "default",
            }),
          },
          session: {
            resolveStorePath: () => "/tmp/rhclaw-session-store",
            readSessionUpdatedAt: () => undefined,
            recordInboundSession: async () => undefined,
          },
          reply: {
            resolveEnvelopeFormatOptions: () => ({ mode: "plain" }),
            formatAgentEnvelope: ({ body }: { body: string }) => body,
            finalizeInboundContext: (payload: Record<string, unknown>) => payload,
            dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }: {
              dispatcherOptions: { deliver: (payload: unknown) => Promise<void> };
            }) => {
              await dispatcherOptions.deliver({ text: "chunk one" });
              await dispatcherOptions.deliver({ text: "chunk two" });
            },
          },
        },
      },
      abortSignal: abort.signal,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      getStatus: () => snapshot,
      setStatus: (next) => {
        Object.assign(snapshot, next);
      },
    } as never);

    assert.equal(publishedBodies.length, 1);
    assert.equal(publishedBodies[0]?.text, "chunk one\n\nchunk two");
    assert.equal(publishedBodies[0]?.status, "succeeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});