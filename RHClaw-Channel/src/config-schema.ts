import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import type { RHClawChannelConfig } from "./types.js";

const rhclawConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    connectionMode: {
      type: "string",
      enum: ["websocket", "polling"],
    },
    serverUrl: { type: "string" },
    deviceSocketUrl: { type: "string" },
    deviceId: { type: "string" },
    deviceCode: { type: "string" },
    deviceName: { type: "string" },
    defaultAgentId: { type: "string" },
    heartbeatIntervalSec: { type: "integer", minimum: 5 },
    ackTimeoutSec: { type: "integer", minimum: 1 },
    resultTimeoutSec: { type: "integer", minimum: 5 },
    allowFrom: {
      type: "array",
      items: { type: "string" },
    },
    dmPolicy: { type: "string" },
    groupPolicy: { type: "string" },
    gatewayTokenRef: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", enum: ["env", "file"] },
        provider: { type: "string" },
        id: { type: "string" },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return ["expected config object"];
  }

  const config = value as RHClawChannelConfig;
  const errors: string[] = [];

  if (config.serverUrl !== undefined && typeof config.serverUrl !== "string") {
    errors.push("serverUrl must be a string");
  }
  if (
    config.connectionMode !== undefined &&
    config.connectionMode !== "websocket" &&
    config.connectionMode !== "polling"
  ) {
    errors.push("connectionMode must be websocket or polling");
  }
  if (config.deviceSocketUrl !== undefined && typeof config.deviceSocketUrl !== "string") {
    errors.push("deviceSocketUrl must be a string");
  }
  if (config.deviceId !== undefined && typeof config.deviceId !== "string") {
    errors.push("deviceId must be a string");
  }
  if (config.allowFrom !== undefined && !Array.isArray(config.allowFrom)) {
    errors.push("allowFrom must be a string array");
  }
  if (
    config.gatewayTokenRef?.source !== undefined &&
    config.gatewayTokenRef.source !== "env" &&
    config.gatewayTokenRef.source !== "file"
  ) {
    errors.push("gatewayTokenRef.source must be env or file");
  }
  if (
    config.heartbeatIntervalSec !== undefined &&
    (!Number.isInteger(config.heartbeatIntervalSec) || config.heartbeatIntervalSec < 5)
  ) {
    errors.push("heartbeatIntervalSec must be an integer >= 5");
  }

  return errors;
}

export const rhclawPluginConfigSchema: OpenClawPluginConfigSchema = {
  validate(value) {
    const errors = validateConfig(value);
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
  },
  safeParse(value) {
    const errors = validateConfig(value);
    if (errors.length > 0) {
      return {
        success: false,
        error: {
          issues: errors.map((message) => ({ path: [], message })),
        },
      };
    }
    return { success: true, data: value };
  },
  jsonSchema: rhclawConfigJsonSchema,
  uiHints: {
    serverUrl: {
      label: "RHOpenClaw API 地址",
      help: "用于拉取配置、上报状态和查询运行上下文。",
      placeholder: "https://api.rhopenclaw.example.com/api/v1",
    },
    connectionMode: {
      label: "连接模式",
      help: "当前 Server 骨架已支持 polling 控制面，WebSocket 数据面仍在联调中。",
    },
    deviceSocketUrl: {
      label: "RH 设备 Socket 地址",
      help: "用于接收命令、回传 ACK、结果和心跳。",
      placeholder: "wss://api.rhopenclaw.example.com/device",
    },
    deviceId: {
      label: "设备 ID",
    },
    deviceCode: {
      label: "设备注册码",
      help: "用于 token 过期时自动重新注册获取新令牌。由 Desktop 安装流程写入。",
    },
  },
};