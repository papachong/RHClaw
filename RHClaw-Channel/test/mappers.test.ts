import assert from "node:assert/strict";
import test from "node:test";
import { mapRHInboundEventToEnvelope, resolveRHClawSessionKey } from "../src/inbound.ts";
import { buildRHOutboundEvent } from "../src/outbound.ts";

test("mapRHInboundEventToEnvelope preserves core fields and metadata", () => {
  const envelope = mapRHInboundEventToEnvelope({
    accountId: "default",
    defaultAgentId: "assistant",
    event: {
      eventId: "evt-1",
      taskId: "task-1",
      deviceId: "device-1",
      senderId: "user-1",
      sessionKey: "session-1",
      text: "你好",
      metadata: {
        source: "desktop",
      },
    },
  });

  assert.deepEqual(envelope, {
    channel: "rhclaw",
    accountId: "default",
    senderId: "user-1",
    chatType: "direct",
    chatId: "device-1",
    text: "你好",
    sessionKey: "agent:assistant:session-1",
    metadata: {
      eventId: "evt-1",
      taskId: "task-1",
      routeAgentId: "assistant",
      source: "desktop",
    },
  });
});

test("resolveRHClawSessionKey preserves agent-scoped keys and builds defaults", () => {
  assert.equal(
    resolveRHClawSessionKey({
      accountId: "default",
      defaultAgentId: "main",
      event: {
        eventId: "evt-1",
        taskId: "task-1",
        deviceId: "device-1",
        senderId: "server",
        sessionKey: "agent:worker:rhclaw:custom",
        text: "hello",
      },
    }),
    "agent:worker:rhclaw:custom",
  );

  assert.equal(
    resolveRHClawSessionKey({
      accountId: "default",
      defaultAgentId: "main",
      event: {
        eventId: "evt-2",
        taskId: "task-2",
        deviceId: "device-2",
        senderId: "server",
        text: "hello",
      },
    }),
    "agent:main:rhclaw:default:direct:device-2",
  );
});

test("buildRHOutboundEvent derives eventId from task and status", () => {
  const outbound = buildRHOutboundEvent({
    deviceId: "device-1",
    taskId: "task-1",
    sessionKey: "session-1",
    text: "已处理",
    status: "succeeded",
    metadata: {
      agentId: "agent-1",
    },
  });

  assert.deepEqual(outbound, {
    eventId: "task-1:succeeded",
    taskId: "task-1",
    deviceId: "device-1",
    sessionKey: "session-1",
    text: "已处理",
    status: "succeeded",
    metadata: {
      agentId: "agent-1",
    },
  });
});