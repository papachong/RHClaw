import type {
  DesktopDeviceAddonItem,
  DesktopLlmAssignmentStatus,
  DesktopLlmConfigItem,
  DesktopLlmProviderItem,
  DesktopSubscriptionStatus,
  DesktopTokenPackageItem,
} from '../services/desktop-settings-api';
import type { DesktopUpdaterStatusSnapshot } from '../services/tauri-agent';
import type { InstallCheckActionId, InstallWizardScene } from '../services/install-check';

export interface SubscriptionNotificationRecord {
  id: string;
  reason: string;
  title: string;
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  publishedAt: string;
  accountStatus?: string | null;
  currentPlanCode?: string | null;
  expireAt?: string | null;
  totalDeviceLimit?: number;
  totalTokenBalance?: number;
}

export interface DesktopSubscriptionPanelState {
  subscription: DesktopSubscriptionStatus | null;
  tokenPackages: DesktopTokenPackageItem[];
  deviceAddons: DesktopDeviceAddonItem[];
  miniProgramPath?: string;
  urlLink?: string;
  launchToken?: string;
  lastOrder?: {
    orderNo: string;
    payUrl?: string | null;
    paymentMessage?: string | null;
    productName: string;
    paymentMethod: string;
    createdAt: string;
  };
}

export interface DesktopLlmPanelState {
  providers: DesktopLlmProviderItem[];
  configs: DesktopLlmConfigItem[];
  activeConfig: DesktopLlmConfigItem | null;
  assignment?: DesktopLlmAssignmentStatus | null;
  billingMode?: string | null;
  allowCustomLlm: boolean;
  miniProgramPath?: string;
  urlLink?: string;
  launchToken?: string;
}

export interface DesktopGatewaySecretStatus {
  storageMode: 'native_keyring';
  providerCode: string;
  providerName: string;
  secretRefProvider?: string;
  secretRefId?: string;
  syncedAt: string;
  detail: string;
}

export interface DesktopVersionPanelState {
  updaterStatus: DesktopUpdaterStatusSnapshot | null;
}

export interface DeviceSessionAlert {
  reason: string;
  title: string;
  detail: string;
  invalidatedAt: string;
}

export interface DesktopLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'danger';
  source: 'desktop' | 'agent' | 'runtime';
  message: string;
}

export type RuntimeSetupPromptMode = 'detected-existing' | 'fresh-install';

export type DesktopWorkspaceTab = 'home' | 'skills' | 'models' | 'advanced' | 'trace' | 'about';

export type DesktopWorkspaceTabIcon = 'home' | 'puzzle-piece' | 'sliders' | 'settings-2' | 'info-circle';

export interface OpenClawWorkspaceInfo {
  version: string;
  gatewayPort?: number | null;
  gatewayBind?: string | null;
  agentCount: number;
  skillCount: number;
  pluginCount: number;
  configPath?: string | null;
  dataDir?: string | null;
  workspacePath?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface DesktopWorkspaceInfoState {
  loading: boolean;
  info: OpenClawWorkspaceInfo | null;
  detail: string;
  checkedAt?: string;
}

export interface InstallWizardViewModel {
  step: 1 | 2 | 3 | 4;
  scene: InstallWizardScene;
  title: string;
  detail: string;
  progressPercent?: number;
  preferredAction?: InstallCheckActionId;
}

export interface DesktopInstallMarker {
  completedAt: string;
  deviceId?: string;
  deviceCode?: string;
  deviceName?: string;
  serverApiBaseUrl?: string;
  runtimeEndpoint?: string;
}

export interface DesktopRecommendedSkillInstallItem {
  slug: string;
  name: string;
  status: 'installed' | 'already-installed' | 'failed';
  detail: string;
  finishedAt: string;
}

export interface DesktopRecommendedSkillsInstallReport {
  source: 'install-wizard';
  startedAt: string;
  finishedAt: string;
  totalCount: number;
  installedCount: number;
  alreadyInstalledCount: number;
  failedCount: number;
  skillhubSiteUrl?: string;
  installerUrl?: string;
  items: DesktopRecommendedSkillInstallItem[];
}

export interface StartupCheckViewModel {
  title: string;
  detail: string;
  progressPercent: number;
  progressLabel: string;
  logs: string[];
}

export const desktopWorkspaceTabs: Array<{
  id: DesktopWorkspaceTab;
  label: string;
  detail: string;
  icon: DesktopWorkspaceTabIcon;
}> = [
  { id: 'home', label: '基本信息', detail: '设备状态、订阅与安装信息', icon: 'home' },
  { id: 'skills', label: '技能管理', detail: '推荐技能与插件状态', icon: 'puzzle-piece' },
  { id: 'models', label: '模型配置', detail: '套餐模型、自定义模型与高级配置', icon: 'sliders' },
  { id: 'advanced', label: '高级配置', detail: '读取与编辑当前 OpenClaw workspace Markdown 文件', icon: 'settings-2' },
  { id: 'about', label: '关于', detail: '版本、设备与运行环境', icon: 'info-circle' },
];

export interface DeviceProfileUpdateNotice {
  deviceId?: string;
  deviceName?: string;
  deviceAlias?: string;
  status?: string;
  updatedAt?: string;
}
