import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { rhclawPluginConfigSchema } from "./src/config-schema.js";
import { rhclawPlugin } from "./src/channel.js";
import { setRHClawRuntime } from "./src/runtime.js";

const plugin = {
  id: "rhclaw-channel",
  name: "RHClaw Channel",
  description: "RHOpenClaw custom channel plugin",
  configSchema: rhclawPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    setRHClawRuntime(api.runtime);
    api.registerChannel({ plugin: rhclawPlugin });
  },
};

export default plugin;