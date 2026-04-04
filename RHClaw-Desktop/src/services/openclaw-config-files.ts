export interface OpenClawConfigFileItem {
  name: string;
  description: string;
  icon: string;
  exists: boolean;
  path: string;
  modifiedAt?: string | null;
}

export interface OpenClawConfigFilesList {
  configRootPath: string;
  files: OpenClawConfigFileItem[];
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
    __TAURI_INTERNALS__?: {
      invoke?: TauriInvoke;
    };
  }
}

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

function requireInvoke(): TauriInvoke {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法读取本地 OpenClaw 配置文件。');
  }

  return invoke;
}

export async function listOpenClawConfigFiles(): Promise<OpenClawConfigFilesList> {
  const invoke = requireInvoke();
  return invoke<OpenClawConfigFilesList>('list_openclaw_config_files');
}

export async function readOpenClawConfigFile(fileName: string): Promise<string> {
  const invoke = requireInvoke();
  return invoke<string>('read_openclaw_config_file', { fileName });
}

export async function saveOpenClawConfigFile(fileName: string, content: string): Promise<string> {
  const invoke = requireInvoke();
  return invoke<string>('save_openclaw_config_file', { fileName, content });
}