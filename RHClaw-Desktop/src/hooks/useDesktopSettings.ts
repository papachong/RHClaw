import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDesktopLlmConfig,
  createDesktopSubscriptionOrder,
  getDesktopLlmAssignment,
  getDesktopLlmOverview,
  getDesktopSubscriptionStatus,
  reassignDesktopLlm,
  setDesktopActiveLlmConfig,
  verifyDesktopLlmConfig,
  type DesktopGatewayLlmSyncConfig,
  type DesktopLlmProviderItem,
} from '../services/desktop-settings-api';
import {
  checkAndInstallDesktopUpdate,
  getDesktopUpdateProgress,
  getOpenClawModelsStatus,
  pasteOpenClawAuthToken,
  restartGateway,
  writeGatewayLlmConfig,
} from '../services/tauri-agent';
import type {
  DesktopLlmPanelState,
  DesktopLogEntry,
  DesktopSubscriptionPanelState,
  DesktopVersionPanelState,
  SubscriptionNotificationRecord,
} from '../types/desktop';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface UseDesktopSettingsDeps {
  getDeviceToken: () => string | undefined;
  deviceToken: string | undefined;
  deviceStatus: string;
  setMessage: (msg: string) => void;
  formatDisplayTime: (value?: string) => string;
  pushDesktopLog?: (source: DesktopLogEntry['source'], entryMessage: string, level: DesktopLogEntry['level']) => void;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useDesktopSettings(deps: UseDesktopSettingsDeps) {
  const { getDeviceToken, deviceToken, deviceStatus, setMessage, formatDisplayTime, pushDesktopLog } = deps;

  const AUTO_REFRESH_RETRY_DELAY_MS = 1200;
  const AUTO_REFRESH_MAX_RETRIES = 3;

  function resolveDeviceToken() {
    return deviceToken || getDeviceToken();
  }

  /* ---- subscription ---- */
  const [subscriptionPanelBusy, setSubscriptionPanelBusy] = useState<'refresh' | 'order' | null>(null);
  const [subscriptionNotifications, setSubscriptionNotifications] = useState<SubscriptionNotificationRecord[]>([]);
  const [desktopSubscription, setDesktopSubscription] = useState<DesktopSubscriptionPanelState>({
    subscription: null,
    tokenPackages: [],
    deviceAddons: [],
  });
  const [selectedPlanCode, setSelectedPlanCode] = useState('');
  const [selectedTokenPackageCode, setSelectedTokenPackageCode] = useState('');
  const [selectedDeviceAddonCode, setSelectedDeviceAddonCode] = useState('');
  const [selectedPaymentMethod] = useState<'wechat'>('wechat');

  /* ---- LLM ---- */
  const [llmPanelBusy, setLlmPanelBusy] = useState<'refresh' | 'create' | 'verify' | 'activate' | 'reassign' | null>(null);
  const [desktopLlm, setDesktopLlm] = useState<DesktopLlmPanelState>({
    providers: [],
    configs: [],
    activeConfig: null,
    assignment: null,
    allowCustomLlm: false,
  });
  const [llmProviderCode, setLlmProviderCode] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmDefaultModel, setLlmDefaultModel] = useState('');
  const selectedLlmProvider = useMemo(
    () => desktopLlm.providers.find((item) => item.providerCode === llmProviderCode) ?? null,
    [desktopLlm.providers, llmProviderCode],
  );

  /* ---- version ---- */
  const [desktopVersion, setDesktopVersion] = useState<DesktopVersionPanelState>({
    updaterStatus: null,
  });
  const [versionPanelBusy, setVersionPanelBusy] = useState<'refresh' | 'install' | null>(null);
  const [workspaceSettingsLoading, setWorkspaceSettingsLoading] = useState(false);

  /* ---- derived ---- */
  const latestSubscriptionNotification = subscriptionNotifications[0] as SubscriptionNotificationRecord | undefined;

  /* ---- effects ---- */

  // Poll Rust shared state just to detect completion and update hook-level installed flag
  // (progress bytes are now handled inside UpdateModal directly)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const shouldPoll = desktopVersion.updaterStatus?.updateAvailable && !desktopVersion.updaterStatus?.installed;
    if (!shouldPoll) {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      return;
    }
    if (pollingRef.current) return;

    console.info('[updater-poll] starting polling for completion');
    pollingRef.current = setInterval(async () => {
      try {
        const progress = await getDesktopUpdateProgress();
        if (!progress.active) return;
        if (progress.completed) {
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
          setDesktopVersion((prev) => {
            const base = prev.updaterStatus;
            if (!base) return prev;
            return { ...prev, updaterStatus: { ...base, installed: true, detail: '下载完毕，请重启。' } };
          });
        }
        if (progress.error) {
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
          setDesktopVersion((prev) => {
            const base = prev.updaterStatus;
            if (!base) return prev;
            return { ...prev, updaterStatus: { ...base, detail: progress.error! } };
          });
        }
      } catch (err) {
        console.error('[updater-poll] error:', err);
      }
    }, 600);

    return () => {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    };
  }, [desktopVersion.updaterStatus?.updateAvailable, desktopVersion.updaterStatus?.installed]);

  // Auto-refresh panels when connected
  useEffect(() => {
    if (deviceStatus === 'binding') {
      setWorkspaceSettingsLoading(false);
      return;
    }

    let active = true;
    let retryAttempts = 0;
    let retryTimer: number | null = null;

    const scheduleRetry = () => {
      if (!active || retryAttempts >= AUTO_REFRESH_MAX_RETRIES) {
        setWorkspaceSettingsLoading(false);
        return;
      }

      retryAttempts += 1;
      console.info('[workspace-settings] auto refresh waiting for device token', {
        attempt: retryAttempts,
        deviceStatus,
      });

      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (active) {
          void refreshPanels();
        }
      }, AUTO_REFRESH_RETRY_DELAY_MS);
    };

    const refreshPanels = async () => {
      const token = resolveDeviceToken();
      if (!token) {
        if (deviceStatus === 'connected' || deviceStatus === 'offline') {
          scheduleRetry();
        } else {
          setWorkspaceSettingsLoading(false);
        }
        return;
      }

      setWorkspaceSettingsLoading(true);

      void Promise.allSettled([
        refreshDesktopSubscriptionPanel(),
        refreshDesktopLlmPanel(),
      ]).finally(() => {
        if (active) {
          setWorkspaceSettingsLoading(false);
        }
      });
    };

    void refreshPanels();

    return () => {
      active = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      setWorkspaceSettingsLoading(false);
    };
  }, [deviceToken, deviceStatus]);

  // Auto-fill LLM provider defaults
  useEffect(() => {
    if (!selectedLlmProvider) {
      return;
    }

    setLlmBaseUrl((current) => (current ? current : selectedLlmProvider.defaultBaseUrl));
    setLlmDefaultModel((current) => (current ? current : selectedLlmProvider.defaultModel));
  }, [selectedLlmProvider]);

  /* ---- internal helpers ---- */

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function applyDefaultGlmProvider(providers: DesktopLlmProviderItem[], force = false) {
    const glmProvider = providers.find(
      (item) => item.providerCode === 'zhipu' || item.providerName.toLowerCase().includes('glm'),
    ) ?? providers[0];

    if (!glmProvider) {
      return;
    }

    setLlmProviderCode((current) => (force || !current ? glmProvider.providerCode : current));
    setLlmBaseUrl((current) => (force || !current ? glmProvider.defaultBaseUrl : current));
    setLlmDefaultModel((current) => (force || !current ? glmProvider.defaultModel : current));
  }

  function buildSubscriptionNotificationDetail(reason: string, subscription?: Record<string, unknown>) {
    const planCode = typeof subscription?.currentPlanCode === 'string' ? subscription.currentPlanCode : '当前套餐';
    const totalDeviceLimit = typeof subscription?.totalDeviceLimit === 'number' ? subscription.totalDeviceLimit : 0;
    const totalTokenBalance = typeof subscription?.totalTokenBalance === 'number' ? subscription.totalTokenBalance : 0;
    const expireAt = typeof subscription?.expireAt === 'string' ? formatDisplayTime(subscription.expireAt) : '未设置';

    switch (reason) {
      case 'subscription_trial_started':
        return `试用权益已生效，可绑定 ${totalDeviceLimit} 台设备，预计到期时间 ${expireAt}。`;
      case 'subscription_payment_succeeded':
        return `${planCode} 已生效，可绑定 ${totalDeviceLimit} 台设备，当前 Token 余额 ${totalTokenBalance}。`;
      case 'subscription_token_insufficient':
        return `${planCode} 当前 Token 余额不足，请续费主套餐或购买 Token 包。`;
      case 'subscription_expired':
        return `${planCode} 已过期，设备执行已冻结，请尽快续费。`;
      case 'subscription_frozen':
        return `${planCode} 当前处于冻结状态，设备执行权限已暂停。`;
      case 'subscription_cancelled':
        return `${planCode} 已取消，当前设备将无法继续执行命令。`;
      case 'subscription_restored':
        return `${planCode} 已恢复，可继续执行命令。`;
      default:
        return `${planCode} 状态已更新，可绑定 ${totalDeviceLimit} 台设备。`;
    }
  }

  async function syncGatewayConfig(syncConfig: DesktopGatewayLlmSyncConfig, successMessage?: string) {
    let authWarning = '';

    try {
      const authResult = await pasteOpenClawAuthToken({
        provider: syncConfig.openaiCompatPrefix,
        token: syncConfig.bootstrapApiKey,
      });

      if (!authResult.ok) {
        authWarning = authResult.detail || authResult.stderr || 'OpenClaw auth profile 写入失败';
      }
    } catch (error) {
      authWarning = error instanceof Error ? error.message : 'OpenClaw auth profile 写入失败';
    }

    const writeResult = await writeGatewayLlmConfig({
      apiKey: syncConfig.bootstrapApiKey,
      baseUrl: syncConfig.baseUrl,
      model: syncConfig.defaultModel,
      openaiCompatPrefix: syncConfig.openaiCompatPrefix,
    });

    pushDesktopLog?.(
      'runtime',
      `settings:model-config:write:${writeResult.applyMode}:${writeResult.restartRequired ? 'restart-required' : 'hot-reload'}:${writeResult.detail}`,
      writeResult.restartRequired ? 'warning' : 'info',
    );

    const restart = writeResult.restartRequired ? await restartGateway() : null;
    if (restart) {
      pushDesktopLog?.(
        'runtime',
        `settings:model-config:restart:${restart.running ? 'ok' : 'warning'}:${restart.detail}`,
        restart.running ? 'info' : 'warning',
      );
    }

    if (successMessage) {
      let baseMessage = successMessage;
      if (restart) {
        baseMessage = restart.running ? successMessage : `${successMessage} 但 Gateway 重启状态异常：${restart.detail}`;
      } else {
        baseMessage = `${successMessage} ${writeResult.detail}`;
      }
      setMessage(authWarning ? `${baseMessage} 同时 OpenClaw CLI 鉴权写入异常：${authWarning}` : baseMessage);
    }
  }

  function buildExpectedModelKey(syncConfig: Pick<DesktopGatewayLlmSyncConfig, 'defaultModel' | 'openaiCompatPrefix'>) {
    const model = syncConfig.defaultModel.trim().toLowerCase();
    if (!model) {
      return '';
    }

    if (model.includes('/')) {
      return model;
    }

    const prefix = syncConfig.openaiCompatPrefix.trim().toLowerCase() || 'openai';
    return `${prefix}/${model}`;
  }

  async function needsGatewayConfigSync(syncConfig: DesktopGatewayLlmSyncConfig) {
    try {
      const status = await getOpenClawModelsStatus();
      const parsed = status.parsed;
      const expectedModel = buildExpectedModelKey(syncConfig);
      if (!status.ok || !parsed || !expectedModel) {
        return true;
      }

      const resolvedDefault = parsed.resolvedDefault?.trim().toLowerCase();
      const currentDefault = parsed.defaultModel?.trim().toLowerCase();
      return resolvedDefault !== expectedModel && currentDefault !== expectedModel;
    } catch {
      return true;
    }
  }

  async function syncPoolAssignmentIfGatewayDrifted(assignment: Awaited<ReturnType<typeof getDesktopLlmAssignment>>, silent = false) {
    const assignedPoolEntry = assignment.assignedPoolEntry;
    if (assignment.source !== 'pool' || !assignedPoolEntry) {
      return;
    }

    const currentSyncConfig: DesktopGatewayLlmSyncConfig = {
      providerCode: assignedPoolEntry.providerCode,
      providerName: assignedPoolEntry.providerName,
      bootstrapApiKey: '',
      baseUrl: assignedPoolEntry.baseUrl,
      defaultModel: assignedPoolEntry.defaultModel,
      openaiCompatPrefix: assignedPoolEntry.openaiCompatPrefix,
    };

    const drifted = await needsGatewayConfigSync(currentSyncConfig);
    if (!drifted) {
      return;
    }

    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    const result = await reassignDesktopLlm(token);
    await syncGatewayConfig(result.assignment, silent ? undefined : `${result.assignment.providerName} 已重新同步到本地 OpenClaw。`);
  }

  async function syncPendingPoolAssignment(silent = false) {
    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    const assignment = await getDesktopLlmAssignment(token);
    setDesktopLlm((current) => ({
      ...current,
      assignment,
    }));

    await syncPoolAssignmentIfGatewayDrifted(assignment, true);

    if (!assignment.hasPendingReassign) {
      return;
    }

    const result = await reassignDesktopLlm(token);
    await syncGatewayConfig(result.assignment, silent ? undefined : `${result.assignment.providerName} 已同步到本地 OpenClaw。`);
    await refreshDesktopLlmPanel();
  }

  /* ---- panel refresh ---- */

  async function refreshDesktopSubscriptionPanel() {
    const token = resolveDeviceToken();
    if (!token) {
      console.warn('[subscription] refreshDesktopSubscriptionPanel skipped: no device token');
      return;
    }

    setSubscriptionPanelBusy('refresh');
    try {
      const payload = await getDesktopSubscriptionStatus(token);
      console.info('[subscription] loaded:', {
        plan: payload.subscription?.summary?.planName,
        entry: payload.entry?.urlLink || payload.entry?.miniProgramPath,
      });
      setDesktopSubscription((current) => ({
        subscription: payload.subscription,
        tokenPackages: payload.tokenPackages.items,
        deviceAddons: payload.deviceAddons.items,
        miniProgramPath: payload.entry.miniProgramPath,
        urlLink: payload.entry.urlLink,
        launchToken: payload.entry.launchToken,
        lastOrder: token ? current.lastOrder : undefined,
      }));
      setSelectedPlanCode((current) => current || payload.subscription.plans[0]?.planCode || '');
      setSelectedTokenPackageCode((current) => current || payload.tokenPackages.items[0]?.packageCode || '');
      setSelectedDeviceAddonCode((current) => current || payload.deviceAddons.items[0]?.packageCode || '');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[subscription] refreshDesktopSubscriptionPanel failed:', detail);
      setMessage(`加载订阅状态失败：${detail}`);
    } finally {
      setSubscriptionPanelBusy(null);
    }
  }

  async function refreshDesktopLlmPanel() {
    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    setLlmPanelBusy('refresh');
    try {
      const [payload, assignment] = await Promise.all([getDesktopLlmOverview(token), getDesktopLlmAssignment(token)]);
      setDesktopLlm({
        providers: payload.providers.items,
        configs: payload.configs.items,
        activeConfig: payload.activeConfig,
        assignment,
        billingMode: payload.providers.subscription.billingMode,
        allowCustomLlm: payload.providers.subscription.allowCustomLlm,
        miniProgramPath: payload.entry.miniProgramPath,
        urlLink: payload.entry.urlLink,
        launchToken: payload.entry.launchToken,
      });
      applyDefaultGlmProvider(payload.providers.items);
      await syncPoolAssignmentIfGatewayDrifted(assignment, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载模型配置状态失败');
    } finally {
      setLlmPanelBusy(null);
    }
  }

  async function refreshDesktopVersionPanel() {
    setVersionPanelBusy('refresh');
    try {
      console.info('[updater] checking for desktop update…');
      const updaterStatus = await checkAndInstallDesktopUpdate();
      console.info('[updater] check result', JSON.stringify(updaterStatus, null, 2));
      setDesktopVersion({ updaterStatus });
      if (updaterStatus.installed) {
        setMessage(updaterStatus.detail);
      } else if (updaterStatus.updateAvailable) {
        setMessage(`检测到新版本 ${updaterStatus.targetVersion || ''}，升级任务已开始。`);
      } else if (!updaterStatus.available && updaterStatus.detail) {
        setMessage(updaterStatus.detail);
      }
    } catch (error) {
      console.error('[updater] check failed', error);
      setMessage(error instanceof Error ? error.message : '版本检查失败');
    } finally {
      setVersionPanelBusy(null);
    }
  }

  async function handleInstallDesktopUpdate() {
    await refreshDesktopVersionPanel();
  }

  /* ---- CRUD handlers ---- */

  async function handleCreateSubscriptionOrder(
    input: { businessType: string; planCode?: string; tokenPackageCode?: string; deviceAddonCode?: string },
  ) {
    const token = resolveDeviceToken();
    if (!token) {
      setMessage('当前设备未注册或令牌不可用');
      return;
    }

    setSubscriptionPanelBusy('order');
    try {
      const result = await createDesktopSubscriptionOrder(token, {
        ...input,
        businessType: input.businessType as 'subscription_plan' | 'token_package' | 'device_addon',
        paymentMethod: selectedPaymentMethod,
      });
      setDesktopSubscription((current) => ({
        ...current,
        lastOrder: {
          orderNo: result.order.localOrderNo,
          payUrl: result.payment.payUrl,
          paymentMessage: result.payment.message,
          productName: result.productSummary.productName,
          paymentMethod: result.payment.paymentMethod,
          createdAt: result.order.createdAt,
        },
      }));

      setMessage(`${result.productSummary.productName} 下单成功，请前往小程序完成微信支付。${result.payment.message ? ` ${result.payment.message}` : ''}`);
      await refreshDesktopSubscriptionPanel();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建订单失败');
    } finally {
      setSubscriptionPanelBusy(null);
    }
  }

  async function handleCreateLlmConfig() {
    const token = resolveDeviceToken();
    if (!token) {
      setMessage('当前设备未注册或令牌不可用');
      return;
    }

    setLlmPanelBusy('create');
    try {
      const result = await createDesktopLlmConfig(token, {
        providerCode: llmProviderCode,
        apiKey: llmApiKey,
        baseUrl: llmBaseUrl,
        defaultModel: llmDefaultModel,
      });
      setLlmApiKey('');
      setMessage(`${result.config?.providerName || '模型配置'}已创建，请继续执行校验。`);
      await refreshDesktopLlmPanel();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建模型配置失败');
    } finally {
      setLlmPanelBusy(null);
    }
  }

  async function handleVerifyLlmConfig(configId: string) {
    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    setLlmPanelBusy('verify');
    try {
      const result = await verifyDesktopLlmConfig(token, configId);
      setMessage(result.message || '模型配置校验完成');
      await refreshDesktopLlmPanel();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '模型配置校验失败');
    } finally {
      setLlmPanelBusy(null);
    }
  }

  async function handleActivateLlmConfig(configId: string) {
    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    setLlmPanelBusy('activate');
    try {
      const result = await setDesktopActiveLlmConfig(token, configId);
      if (result.syncConfig) {
        await syncGatewayConfig(result.syncConfig, result.config ? `${result.config.providerName} 已设为当前激活模型。` : '模型配置已切换。');
      } else {
        setMessage(result.config ? `${result.config.providerName} 已设为当前激活模型。` : '模型配置已切换。');
      }
      await refreshDesktopLlmPanel();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '激活模型配置失败');
    } finally {
      setLlmPanelBusy(null);
    }
  }

  async function handleReassignDesktopLlm() {
    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    setLlmPanelBusy('reassign');
    try {
      const result = await reassignDesktopLlm(token);
      await syncGatewayConfig(result.assignment, `${result.assignment.providerName} 已切换为当前设备默认模型。`);
      await refreshDesktopLlmPanel();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '切换设备默认模型失败');
    } finally {
      setLlmPanelBusy(null);
    }
  }

  /* ---- functions called from outside (socket handler, install flow) ---- */

  async function initializeDefaultGlmProviderForToken(token: string, force = true) {
    const [payload, assignment] = await Promise.all([getDesktopLlmOverview(token), getDesktopLlmAssignment(token)]);
    setDesktopLlm({
      providers: payload.providers.items,
      configs: payload.configs.items,
      activeConfig: payload.activeConfig,
      assignment,
      billingMode: payload.providers.subscription.billingMode,
      allowCustomLlm: payload.providers.subscription.allowCustomLlm,
      miniProgramPath: payload.entry.miniProgramPath,
      urlLink: payload.entry.urlLink,
      launchToken: payload.entry.launchToken,
    });
    applyDefaultGlmProvider(payload.providers.items, force);
  }

  /** 内置模型套餐白名单（应和 Server 侧保持一致） */
  const BUILTIN_MODEL_PLAN_CODES = ['glm_monthly', 'glm_quarterly', 'glm_yearly'];

  /**
   * 收到订阅变更 WebSocket 事件时，进行模型配置自动更新。
   * 仅内置模型套餐且非自定义 provider 用户才执行更新。
   */
  async function handleSubscriptionModelConfigUpdate(event: Record<string, unknown>): Promise<void> {
    const modelConfigChanged = event.modelConfigChanged === true;
    const planCode = typeof event.planCode === 'string' ? event.planCode : null;

    if (!modelConfigChanged || !planCode || !BUILTIN_MODEL_PLAN_CODES.includes(planCode)) {
      return;
    }

    if (desktopLlm.assignment?.source === 'custom') {
      return;
    }

    const token = resolveDeviceToken();
    if (!token) {
      return;
    }

    try {
      const result = await reassignDesktopLlm(token);
      await syncGatewayConfig(result.assignment, '订阅已激活，模型配置已自动更新');
      await refreshDesktopLlmPanel();
      pushSubscriptionNotification({
        id: `subscription_model_synced_${Date.now()}`,
        reason: 'subscription_payment_succeeded',
        title: '订阅已激活',
        detail: '模型配置已自动切换为订阅池。',
        tone: 'success',
        publishedAt: new Date().toISOString(),
        currentPlanCode: planCode,
      });
    } catch (error) {
      pushSubscriptionNotification({
        id: `subscription_model_sync_failed_${Date.now()}`,
        reason: 'subscription_payment_succeeded',
        title: '订阅已激活',
        detail: '请重启桌面客户端以更新模型配置。',
        tone: 'warning',
        publishedAt: new Date().toISOString(),
        currentPlanCode: planCode,
      });
      pushDesktopLog?.('runtime', `subscription:model-config-sync-failed:${error instanceof Error ? error.message : 'unknown'}`, 'warning');
    }
  }

  function pushSubscriptionNotification(record: SubscriptionNotificationRecord) {
    setSubscriptionNotifications((current) => [record, ...current].slice(0, 12));
  }

  function mapSubscriptionNotification(payload: Record<string, unknown>): SubscriptionNotificationRecord {
    const subscription = isRecord(payload.subscription) ? payload.subscription : undefined;
    const reason = typeof payload.reason === 'string' ? payload.reason : 'subscription_updated';
    const titleMap: Record<string, { title: string; tone: SubscriptionNotificationRecord['tone'] }> = {
      subscription_trial_started: { title: '免费试用已开始', tone: 'success' },
      subscription_payment_succeeded: { title: '订阅权益已更新', tone: 'success' },
      subscription_token_insufficient: { title: 'Token 余额不足', tone: 'warning' },
      subscription_expired: { title: '订阅已过期', tone: 'danger' },
      subscription_frozen: { title: '订阅已冻结', tone: 'warning' },
      subscription_cancelled: { title: '订阅已取消', tone: 'warning' },
      subscription_restored: { title: '订阅已恢复', tone: 'success' },
      subscription_updated: { title: '订阅状态已更新', tone: 'neutral' },
    };

    const mapped = titleMap[reason] ?? titleMap.subscription_updated;
    const detail =
      (typeof payload.detail === 'string' && payload.detail) ||
      buildSubscriptionNotificationDetail(reason, subscription);

    return {
      id: `${reason}_${typeof payload.publishedAt === 'string' ? payload.publishedAt : Date.now()}`,
      reason,
      title: (typeof payload.title === 'string' && payload.title) || mapped.title,
      detail,
      tone: mapped.tone,
      publishedAt: typeof payload.publishedAt === 'string' ? payload.publishedAt : new Date().toISOString(),
      accountStatus: typeof subscription?.accountStatus === 'string' ? subscription.accountStatus : null,
      currentPlanCode: typeof subscription?.currentPlanCode === 'string' ? subscription.currentPlanCode : null,
      expireAt: typeof subscription?.expireAt === 'string' ? subscription.expireAt : null,
      totalDeviceLimit: typeof subscription?.totalDeviceLimit === 'number' ? subscription.totalDeviceLimit : undefined,
      totalTokenBalance: typeof subscription?.totalTokenBalance === 'number' ? subscription.totalTokenBalance : undefined,
    };
  }

  /** Reset all panels to empty state (e.g. on session invalidation). */
  function resetSettingsPanels() {
    setDesktopSubscription({ subscription: null, tokenPackages: [], deviceAddons: [] });
    setDesktopLlm({ providers: [], configs: [], activeConfig: null, assignment: null, allowCustomLlm: false });
    setDesktopVersion({ updaterStatus: null });
  }

  /* ---- return ---- */

  return {
    // subscription
    subscriptionPanelBusy,
    subscriptionNotifications,
    desktopSubscription,
    selectedPlanCode,
    setSelectedPlanCode,
    selectedTokenPackageCode,
    setSelectedTokenPackageCode,
    selectedDeviceAddonCode,
    setSelectedDeviceAddonCode,
    selectedPaymentMethod,
    latestSubscriptionNotification,

    // LLM
    llmPanelBusy,
    desktopLlm,
    llmProviderCode,
    setLlmProviderCode,
    llmApiKey,
    setLlmApiKey,
    llmBaseUrl,
    setLlmBaseUrl,
    llmDefaultModel,
    setLlmDefaultModel,
    selectedLlmProvider,

    // version
    desktopVersion,
    versionPanelBusy,
    workspaceSettingsLoading,

    // panel refresh
    refreshDesktopSubscriptionPanel,
    refreshDesktopLlmPanel,
    refreshDesktopVersionPanel,

    // CRUD handlers
    handleCreateSubscriptionOrder,
    handleInstallDesktopUpdate,
    handleCreateLlmConfig,
    handleVerifyLlmConfig,
    handleActivateLlmConfig,
    handleReassignDesktopLlm,

    // cross-concern API
    initializeDefaultGlmProviderForToken,
    pushSubscriptionNotification,
    mapSubscriptionNotification,
    handleSubscriptionModelConfigUpdate,
    resetSettingsPanels,
  };
}
