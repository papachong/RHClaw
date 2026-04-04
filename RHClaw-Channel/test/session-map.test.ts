import assert from "node:assert/strict";
import test from "node:test";
import { RHClawSessionMap } from "../src/session-map.ts";

test("RHClawSessionMap stores, lists, and deletes bindings", () => {
  const sessionMap = new RHClawSessionMap();
  const binding = {
    sessionKey: "session-1",
    taskId: "task-1",
    deviceId: "device-1",
    agentId: "agent-1",
    createdAt: "2026-03-10T00:00:00.000Z",
  };

  sessionMap.set(binding);

  assert.deepEqual(sessionMap.get("session-1"), binding);
  assert.deepEqual(sessionMap.list(), [binding]);

  sessionMap.delete("session-1");

  assert.equal(sessionMap.get("session-1"), undefined);
  assert.deepEqual(sessionMap.list(), []);
});