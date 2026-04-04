import { getApiBaseUrl } from './server-config';

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

export interface DesktopSubscriptionStatus {
	account: {
		status: string;
		billingMode: string;
		currentPlanCode?: string | null;
		currentTokenPackageCode?: string | null;
		trialStatus: string;
		trialStartAt?: string | null;
		trialEndAt?: string | null;
		expireAt?: string | null;
	} | null;
	entitlement: {
		maxDeviceCount: number;
		baseDeviceCount: number;
		extraDeviceSlots: number;
		totalDeviceLimit: number;
		billingMode: string;
		includedModelProvider?: string | null;
		includedTokenQuota?: number | null;
		extraTokenBalance: number;
		allowCustomLlm: boolean;
		featurePermissions: Record<string, unknown>;
		effectiveFrom: string;
		effectiveTo?: string | null;
	} | null;
	usage: {
		activeDeviceCount: number;
		totalDeviceLimit: number;
		remainingDeviceSlots: number;
		includedTokenQuota?: number;
		extraTokenBalance: number;
		totalTokenBalance?: number;
	};
	trial: {
		available: boolean;
		inTrial: boolean;
		trialStatus: string;
		trialStartAt?: string | null;
		trialEndAt?: string | null;
		daysLeft: number;
	};
	summary: {
		statusLabel: string;
		billingModeLabel: string;
		planName: string;
		featureHighlights: string[];
	};
	plans: DesktopPlanItem[];
	checkedAt: string;
}

export interface DesktopPlanItem {
	planCode: string;
	planName: string;
	billingMode: string;
	billingPeriod: string;
	priceAmount: string;
	currency: string;
	maxDeviceCount: number;
	includedModelProvider?: string | null;
	includedTokenQuota?: number | null;
	allowCustomLlm: boolean;
}

export interface DesktopTokenPackageItem {
	packageCode: string;
	packageName: string;
	priceAmount: string;
	currency: string;
	tokenAmount: number;
	validDays: number;
}

export interface DesktopDeviceAddonItem {
	packageCode: string;
	packageName: string;
	billingPeriod: string;
	priceAmount: string;
	currency: string;
	deviceSlots: number;
}

export interface DesktopVersionCheck {
	current: {
		deviceId: string;
		platform: string;
		appVersion?: string | null;
		protocolVersion?: string | null;
	};
	latest: {
		version?: string | null;
		channel?: string | null;
		releasedAt?: string | null;
		manifestSha256?: string | null;
		docsUrl?: string | null;
		itemCount?: number | null;
		coverage?: Record<string, unknown> | null;
		warnings?: string[];
	};
	rollout: {
		assignedChannel: 'stable' | 'beta' | 'canary';
		autoUpdateEnabled: boolean;
		channelMatched: boolean;
		policy: {
			defaultChannel: 'stable' | 'beta' | 'canary';
			stablePercent: number;
			betaPercent: number;
			canaryPercent: number;
			autoUpdateEnabled: boolean;
		};
	};
	compatibility: {
		minSupportedVersion?: string | null;
		compatible: boolean;
		hasUpdate: boolean;
		updateRecommended: boolean;
		reason: string;
	};
}

interface DesktopVersionCheckResponse {
	success: boolean;
	data: DesktopVersionCheck;
	message?: string;
}

interface DesktopSubscriptionStatusResponse {
	success: boolean;
	data: {
		subscription: DesktopSubscriptionStatus;
		tokenPackages: {
			items: DesktopTokenPackageItem[];
			total: number;
		};
		deviceAddons: {
			items: DesktopDeviceAddonItem[];
			total: number;
		};
		entry: {
			miniProgramPath: string;
			urlLink?: string;
			launchToken?: string;
			delivery?: 'url_link' | 'mini_program_path';
		};
	};
	message?: string;
}

interface DesktopOrderResponse {
	success: boolean;
	data: {
		order: {
			localOrderNo: string;
			externalOrderId?: string | null;
			status: string;
			amount: string;
			currency: string;
			businessType: string;
			createdAt: string;
			expiredAt?: string | null;
		};
		payment: {
			provider: string;
			providerMode: string;
			paymentMethod: string;
			paymentChannel?: string;
			payUrl?: string | null;
			message?: string;
			requestPayment?: {
				timeStamp: string;
				nonceStr: string;
				package: string;
				signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
				paySign: string;
			} | null;
		};
		productSummary: {
			productCode: string;
			productName: string;
			catalogSource: string;
			billingMode?: string | null;
		};
	};
	message?: string;
}

export interface DesktopLlmProviderItem {
	providerCode: string;
	providerName: string;
	defaultBaseUrl: string;
	defaultModel: string;
	openclawPrefix: string;
	recommendedModels?: string[];
	description: string;
	authMode: 'api_key';
}

export interface DesktopLlmConfigItem {
	id: string;
	providerCode: string;
	providerName: string;
	apiKeyMasked?: string | null;
	baseUrl?: string | null;
	defaultModel?: string | null;
	status: string;
	lastVerifiedAt?: string | null;
	verificationStatus: string;
	createdAt: string;
	updatedAt: string;
}

export interface DesktopGatewayLlmSyncConfig {
	providerCode: string;
	providerName: string;
	bootstrapApiKey: string;
	baseUrl: string;
	defaultModel: string;
	openaiCompatPrefix: string;
}

export interface DesktopLlmPoolAssignment {
	id: string;
	poolType: 'trial' | 'subscription';
	providerCode: string;
	providerName: string;
	bootstrapApiKey: string;
	baseUrl: string;
	defaultModel: string;
	openaiCompatPrefix: string;
	activeDeviceCount: number;
	maxDeviceCount: number;
	enabled: boolean;
	label?: string | null;
	assignedNow: boolean;
	assignedAt: string;
}

export interface DesktopLlmAssignmentStatus {
	source: 'custom' | 'pool' | 'none';
	recommendedPoolType: 'trial' | 'subscription';
	hasPendingReassign: boolean;
	assignedPoolEntry: Omit<DesktopLlmPoolAssignment, 'bootstrapApiKey' | 'assignedNow' | 'assignedAt'> | null;
	activeConfig: DesktopLlmConfigItem | null;
	checkedAt: string;
}

interface DesktopLlmOverviewResponse {
	success: boolean;
	data: {
		providers: {
			items: DesktopLlmProviderItem[];
			total: number;
			subscription: {
				billingMode?: string | null;
				allowCustomLlm: boolean;
			};
		};
		configs: {
			items: DesktopLlmConfigItem[];
			total: number;
		};
		activeConfig: DesktopLlmConfigItem | null;
		entry: {
			miniProgramPath: string;
			urlLink?: string;
			launchToken?: string;
			delivery?: 'url_link' | 'mini_program_path';
		};
	};
	message?: string;
}

interface DesktopLlmConfigResponse {
	success: boolean;
	data: {
		config?: DesktopLlmConfigItem;
		verified?: boolean;
		message?: string;
		activeConfigId?: string;
		syncConfig?: DesktopGatewayLlmSyncConfig | null;
	};
	message?: string;
}

interface DesktopInstallLlmResponse {
	success: boolean;
	data: {
		assignment: DesktopLlmPoolAssignment;
		checkedAt: string;
	};
	message?: string;
}

interface DesktopLlmAssignmentResponse {
	success: boolean;
	data: DesktopLlmAssignmentStatus;
	message?: string;
}

interface DesktopLlmReassignResponse {
	success: boolean;
	data: {
		targetPoolType: 'trial' | 'subscription';
		assignment: DesktopLlmPoolAssignment;
		checkedAt: string;
	};
	message?: string;
}

interface DesktopInstallSkillsConfigResponse {
	success: boolean;
	data: {
		mode: string;
		skills: Array<string | {
			slug: string;
			name?: string;
			description?: string;
			version?: string;
			homepage?: string;
			owner?: string;
			tags?: string[];
			downloads?: number;
			source?: string;
			updatedAt?: string;
		}>;
		notes?: string;
		updatedAt?: string;
		skillhub?: {
			siteUrl?: string;
			installerUrl?: string;
		};
	};
	message?: string;
}

export async function getDesktopSubscriptionStatus(deviceToken: string) {
	const native = await invokeNativeHttp<DesktopSubscriptionStatusResponse['data']>('get_desktop_subscription_status_http', {
		apiBaseUrl: getApiBaseUrl(),
		deviceToken,
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/devices/me/subscription/status`, {
		headers: { Authorization: `Bearer ${deviceToken}` },
	});

	return parseResponse<DesktopSubscriptionStatusResponse>(response);
}

export async function createDesktopSubscriptionOrder(
	deviceToken: string,
	input: {
		businessType: 'subscription_plan' | 'token_package' | 'device_addon';
		paymentMethod?: 'wechat';
		planCode?: string;
		tokenPackageCode?: string;
		deviceAddonCode?: string;
		returnUrl?: string;
	},
) {
	const response = await fetch(`${getApiBaseUrl()}/devices/me/subscription/orders`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${deviceToken}`,
		},
		body: JSON.stringify({
			...input,
			paymentMethod: 'wechat',
			source: 'desktop',
		}),
	});

	return parseResponse<DesktopOrderResponse>(response);
}

export async function getDesktopLlmOverview(deviceToken: string) {
	const native = await invokeNativeHttp<DesktopLlmOverviewResponse['data']>('get_desktop_llm_overview_http', {
		apiBaseUrl: getApiBaseUrl(),
		deviceToken,
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/devices/me/llm/overview`, {
		headers: { Authorization: `Bearer ${deviceToken}` },
	});

	return parseResponse<DesktopLlmOverviewResponse>(response);
}

export async function getDesktopVersionCheck(deviceToken: string) {
	const native = await invokeNativeHttp<DesktopVersionCheckResponse['data']>('get_desktop_version_check_http', {
		apiBaseUrl: getApiBaseUrl(),
		deviceToken,
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/devices/me/version-check`, {
		headers: { Authorization: `Bearer ${deviceToken}` },
	});

	return parseResponse<DesktopVersionCheckResponse>(response);
}

export async function getDesktopInstallSkillsConfig() {
	const native = await invokeNativeHttp<DesktopInstallSkillsConfigResponse['data']>('fetch_install_skills_config_http', {
		apiBaseUrl: getApiBaseUrl(),
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/desktop/install/skills`, {
		headers: {
			'Content-Type': 'application/json',
		},
	});

	return parseResponse<DesktopInstallSkillsConfigResponse>(response);
}

export async function fetchInstallLlmConfig(deviceToken: string) {
	const native = await invokeNativeHttp<DesktopInstallLlmResponse['data']>('fetch_install_llm_config_http', {
		apiBaseUrl: getApiBaseUrl(),
		deviceToken,
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/desktop/install/llm-config`, {
		headers: { Authorization: `Bearer ${deviceToken}` },
	});

	return parseResponse<DesktopInstallLlmResponse>(response);
}

export async function getDesktopLlmAssignment(deviceToken: string) {
	const native = await invokeNativeHttp<DesktopLlmAssignmentResponse['data']>('get_desktop_llm_assignment_http', {
		apiBaseUrl: getApiBaseUrl(),
		deviceToken,
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/devices/me/llm/assignment`, {
		headers: { Authorization: `Bearer ${deviceToken}` },
	});

	return parseResponse<DesktopLlmAssignmentResponse>(response);
}

export async function reassignDesktopLlm(deviceToken: string) {
	const native = await invokeNativeHttp<DesktopLlmReassignResponse['data']>('reassign_desktop_llm_http', {
		apiBaseUrl: getApiBaseUrl(),
		deviceToken,
	});
	if (native) {
		return native;
	}

	const response = await requestJson(`${getApiBaseUrl()}/devices/me/llm/reassign`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${deviceToken}`,
		},
		body: JSON.stringify({}),
	});

	return parseResponse<DesktopLlmReassignResponse>(response);
}

export async function createDesktopLlmConfig(
	deviceToken: string,
	input: {
		providerCode: string;
		apiKey: string;
		baseUrl?: string;
		defaultModel?: string;
	},
) {
	const response = await fetch(`${getApiBaseUrl()}/devices/me/llm/configs`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${deviceToken}`,
		},
		body: JSON.stringify(input),
	});

	return parseResponse<DesktopLlmConfigResponse>(response);
}

export async function verifyDesktopLlmConfig(deviceToken: string, configId: string) {
	const response = await fetch(`${getApiBaseUrl()}/devices/me/llm/verify`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${deviceToken}`,
		},
		body: JSON.stringify({ configId }),
	});

	return parseResponse<DesktopLlmConfigResponse>(response);
}

export async function setDesktopActiveLlmConfig(deviceToken: string, configId: string) {
	const response = await fetch(`${getApiBaseUrl()}/devices/me/llm/active-config`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${deviceToken}`,
		},
		body: JSON.stringify({ configId }),
	});

	return parseResponse<DesktopLlmConfigResponse>(response);
}

async function parseResponse<T extends { success: boolean; data: unknown; message?: string }>(response: Response) {
	const payload = (await response.json()) as T;

	if (!response.ok || !payload.success) {
		throw new Error(payload.message || 'Request failed');
	}

	return payload.data as T['data'];
}

async function requestJson(url: string, init: RequestInit) {
	try {
		return await fetch(url, init);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`请求失败：${reason}。请检查 API 地址与网络连通性（当前：${getApiBaseUrl()}）。`);
	}
}

function getTauriInvoke(): TauriInvoke | null {
	return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

async function invokeNativeHttp<T>(command: string, args: Record<string, unknown>) {
	const invoke = getTauriInvoke();
	if (!invoke) {
		return null;
	}

	try {
		return await invoke<T>(command, { args });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// If the Tauri command doesn't exist, fall back to browser fetch
		if (reason.includes('not found') || reason.includes('did not match')) {
			return null;
		}
		throw new Error(reason || 'Native HTTP request failed');
	}
}
