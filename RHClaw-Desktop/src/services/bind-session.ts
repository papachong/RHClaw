import type { BindSessionStatusData } from './device-api';

export type DesktopBindSessionState =
  | 'pending'
  | 'binding'
  | 'bound'
  | 'limited'
  | 'expired'
  | 'abandoned'
  | 'replaced'
  | 'failed';

export interface DesktopBindSessionView {
  state: DesktopBindSessionState;
  title: string;
  detail: string;
  canRetry: boolean;
}

export function deriveDesktopBindSessionView(status: BindSessionStatusData): DesktopBindSessionView {
  const bindStatus = status.bindSession.status;
  const executionAllowed = status.executionAllowed;

  if (bindStatus === 'confirmed') {
    if (executionAllowed === false) {
      return {
        state: 'limited',
        title: '设备已绑定，但当前不可执行',
        detail: status.message || '设备已绑定成功，但当前订阅或执行权限受限，请在订阅管理中完成处理。',
        canRetry: false,
      };
    }

    return {
      state: 'bound',
      title: '设备已完成绑定',
      detail: status.message || '绑定确认已完成，Desktop 将自动进入主工作台。',
      canRetry: false,
    };
  }

  if (bindStatus === 'expired') {
    return {
      state: 'expired',
      title: '绑定会话已过期',
      detail: '当前二维码已失效，请重新生成新的绑定会话。',
      canRetry: true,
    };
  }

  if (bindStatus === 'abandoned' || bindStatus === 'cancelled') {
    return {
      state: 'abandoned',
      title: '本次绑定已放弃',
      detail: status.message || '当前绑定流程已结束，请重新生成二维码后再继续。',
      canRetry: true,
    };
  }

  if (bindStatus === 'replaced') {
    return {
      state: 'replaced',
      title: '绑定目标已切换',
      detail: status.message || '当前绑定会话已被新的替换决策接管，请重新生成二维码或刷新页面。',
      canRetry: true,
    };
  }

  if (status.bindHint?.loginRequired) {
    return {
      state: 'pending',
      title: '等待用户扫码并登录',
      detail: '用户需要先在小程序中完成登录，登录后会继续执行自动绑定。',
      canRetry: false,
    };
  }

  if (status.bindHint?.canAutoConfirm) {
    return {
      state: 'binding',
      title: '小程序正在自动完成绑定',
      detail: '扫码和登录已完成，系统正在自动确认绑定结果。',
      canRetry: false,
    };
  }

  if (status.bindHint?.conflictType && status.bindHint.conflictType !== 'none') {
    return {
      state: 'binding',
      title: '等待小程序完成绑定决策',
      detail: '用户已进入绑定确认流程，正在处理登录、替换设备或额度决策。',
      canRetry: false,
    };
  }

  return {
    state: 'pending',
    title: '等待微信扫码拉起小程序',
    detail: '二维码已生成，请使用微信扫码；小程序会自动登录回跳并尝试完成绑定。',
    canRetry: false,
  };
}

export function createPendingBindSessionView(): DesktopBindSessionView {
  return {
    state: 'pending',
    title: '等待微信扫码拉起小程序',
    detail: '二维码已生成，请使用微信扫码；小程序会自动登录回跳并尝试完成绑定。',
    canRetry: false,
  };
}