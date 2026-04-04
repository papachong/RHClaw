export interface WorkspaceMarkdownFileItem {
  name: string;
  relativePath: string;
  description: string;
  icon: string;
  exists: boolean;
  path: string;
  modifiedAt?: string | null;
}

export interface WorkspaceMarkdownFilesList {
  workspacePath: string;
  files: WorkspaceMarkdownFileItem[];
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
    throw new Error('当前为浏览器联调壳层，无法读取本地 OpenClaw workspace 文件。');
  }

  return invoke;
}

export async function listWorkspaceMarkdownFiles(directory?: string): Promise<WorkspaceMarkdownFilesList> {
  const invoke = requireInvoke();
  return invoke<WorkspaceMarkdownFilesList>('list_workspace_files', { directory });
}

export async function readWorkspaceMarkdownFile(fileName: string): Promise<string> {
  const invoke = requireInvoke();
  return invoke<string>('read_workspace_file', { fileName });
}

export async function saveWorkspaceMarkdownFile(fileName: string, content: string): Promise<string> {
  const invoke = requireInvoke();
  return invoke<string>('save_workspace_file', { fileName, content });
}