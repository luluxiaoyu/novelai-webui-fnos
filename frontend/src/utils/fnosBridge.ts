import { TrimApp } from '@trimjs/web-app';

export interface FnosPickResult {
  supported: boolean;
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

let trimAppInstance: TrimApp | null = null;

export function getTrimApp(): TrimApp {
  if (!trimAppInstance) {
    trimAppInstance = new TrimApp();
  }
  return trimAppInstance;
}

/**
 * Check if running inside fnOS desktop host (iframe or embedded webview).
 */
export function isInsideFnOS(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.parent !== window) return true;
  } catch {
    return true;
  }
  const app = getTrimApp();
  return !app.isStandaloneWeb;
}

/**
 * Invoke native fnOS shared directory picker using the official @trimjs/web-app SDK.
 */
export async function pickSharedDirectory(): Promise<FnosPickResult> {
  const app = getTrimApp();

  if (!isInsideFnOS()) {
    return {
      supported: false,
      success: false,
      error: '当前未运行在飞牛桌面宿主环境中'
    };
  }

  try {
    // 1. Try pickSharedFile first (Application Shared Folder authorization)
    const res = await app.pickSharedFile({
      title: '选择共享文件夹'
    });

    if (res && res.data) {
      const paths = Array.isArray(res.data) ? res.data : [res.data];
      if (paths.length > 0 && paths[0]) {
        return {
          supported: true,
          success: true,
          path: String(paths[0])
        };
      }
      return { supported: true, success: false, canceled: true };
    }

    // 2. Fallback to pickUserFile with directory=true
    const userRes = await app.pickUserFile({
      directory: true,
      title: '选择存储目录'
    });

    if (userRes && userRes.data) {
      const paths = Array.isArray(userRes.data) ? userRes.data : [userRes.data];
      if (paths.length > 0 && paths[0]) {
        return {
          supported: true,
          success: true,
          path: String(paths[0])
        };
      }
      return { supported: true, success: false, canceled: true };
    }

    return { supported: true, success: false, canceled: true };
  } catch (err: any) {
    console.warn('[fnosBridge] Failed to pick directory via @trimjs/web-app:', err);
    return {
      supported: false,
      success: false,
      error: err?.message || '调起系统文件选择器失败'
    };
  }
}

/**
 * Open the host fnOS App Settings window for NovelAI WebUI directly.
 */
export async function openFnOSAppSetting(): Promise<boolean> {
  try {
    const app = getTrimApp();
    await app.openAppSetting();
    return true;
  } catch (err) {
    console.warn('[fnosBridge] openAppSetting failed:', err);
    return false;
  }
}
