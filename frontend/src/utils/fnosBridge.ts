import { TrimApp } from '@trimjs/web-app';

export interface FnosPickResult {
  supported: boolean;
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface FnosAppSettingResult {
  success: boolean;
  error?: string;
}

export interface FnosAppAuthRouteResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface FnosAppAuthCallbackResult {
  hasCallback: boolean;
  status?: 'success' | 'cancel' | 'error';
  path?: string;
  method?: string;
  appName?: string;
  error?: string;
}

let trimAppInstance: TrimApp | null = null;
let hostBridgeSupported: boolean | null = null;
let probePromise: Promise<boolean> | null = null;

export function getTrimApp(): TrimApp {
  if (!trimAppInstance) {
    trimAppInstance = new TrimApp({ debug: false });
  }
  return trimAppInstance;
}

/**
 * Proactively check if the host window supports @trimjs/web-app Postmate / Extension host handshake.
 * Bounded by a quick timeout (300ms). If unsupported or timeout occurs, marks host bridge as unsupported.
 */
export async function isFnosHostBridgeSupported(timeoutMs = 300): Promise<boolean> {
  if (hostBridgeSupported !== null) {
    return hostBridgeSupported;
  }
  if (typeof window === 'undefined') {
    hostBridgeSupported = false;
    return false;
  }
  try {
    if (window.parent === window) {
      hostBridgeSupported = false;
      return false;
    }
  } catch {
    hostBridgeSupported = false;
    return false;
  }

  if (probePromise) {
    return probePromise;
  }

  probePromise = (async () => {
    try {
      const app = getTrimApp();
      let timer: any;
      const timeoutP = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Extension host handshake timeout')), timeoutMs);
      });
      await Promise.race([app.ready(), timeoutP]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      hostBridgeSupported = true;
      return true;
    } catch {
      hostBridgeSupported = false;
      return false;
    }
  })();

  return probePromise;
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
 * Wrap a promise with a bounded timeout to prevent hanging on unresponsive host bridge calls.
 */
function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMsg: string): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Invoke native fnOS shared directory picker using the official @trimjs/web-app SDK.
 * Bounded by a quick handshake check to prevent hanging when host does not respond to Postmate.
 */
export async function pickSharedDirectory(timeoutMs = 1500): Promise<FnosPickResult> {
  if (!isInsideFnOS()) {
    return {
      supported: false,
      success: false,
      error: '当前未运行在飞牛桌面宿主环境中'
    };
  }

  const supported = await isFnosHostBridgeSupported(300);
  if (!supported) {
    return {
      supported: false,
      success: false,
      error: '宿主桌面未开放交互式文件夹选择器（请使用预设列表或手动输入路径）'
    };
  }

  const app = getTrimApp();

  try {
    // 1. Try pickSharedFile first (Application Shared Folder authorization) with bounded timeout
    const res = await promiseWithTimeout(
      app.pickSharedFile({
        title: '选择共享文件夹'
      }),
      timeoutMs,
      '宿主共享文件夹选择器响应超时'
    );

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
    const userRes = await promiseWithTimeout(
      app.pickUserFile({
        directory: true,
        title: '选择存储目录'
      }),
      timeoutMs,
      '宿主存储目录选择器响应超时'
    );

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
    console.warn('[fnosBridge] Failed to pick directory via @trimjs/web-app:', err?.message);
    return {
      supported: false,
      success: false,
      error: err?.message || '宿主选择器未响应（当前宿主版本未开放该通信接口）'
    };
  }
}

/**
 * Build route URL for fnOS App Auth Flow (/app-auth/pick-shared-file or /app-auth/authorize-shared-file).
 */
export async function buildAppAuthUrl(
  method: 'pickSharedFile' | 'authorizeSharedFile' = 'pickSharedFile',
  targetPath?: string
): Promise<string> {
  const app = getTrimApp();
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

  if (method === 'authorizeSharedFile' && targetPath) {
    return await app.buildAppAuthUrl('authorizeSharedFile', {
      appName: 'novelai',
      path: targetPath,
      redirectUri: currentUrl,
      state: 'novelai_auth'
    });
  }

  return await app.buildAppAuthUrl('pickSharedFile', {
    appName: 'novelai',
    redirectUri: currentUrl,
    state: 'novelai_pick'
  });
}

/**
 * Open fnOS route-based App Auth in a new window or top-level navigation.
 */
export async function openAppAuthRoute(
  method: 'pickSharedFile' | 'authorizeSharedFile' = 'pickSharedFile',
  targetPath?: string
): Promise<FnosAppAuthRouteResult> {
  try {
    const authUrl = await buildAppAuthUrl(method, targetPath);
    if (!authUrl) {
      return { success: false, error: '无法生成授权跳转链接' };
    }
    const win = window.open(authUrl, '_blank');
    if (!win) {
      return { success: false, url: authUrl, error: '弹出窗口被浏览器拦截，请允许弹出窗口' };
    }
    return { success: true, url: authUrl };
  } catch (err: any) {
    console.warn('[fnosBridge] Failed to open App Auth route:', err?.message);
    return { success: false, error: err?.message || '调起应用授权路由失败' };
  }
}

/**
 * Open the host fnOS App Settings window for NovelAI WebUI directly.
 * Bounded by timeout and accompanied by postMessage fallbacks.
 */
export async function openFnOSAppSetting(timeoutMs = 1500): Promise<FnosAppSettingResult> {
  if (!isInsideFnOS()) {
    return {
      success: false,
      error: '当前在独立浏览器窗口运行，宿主设置通道不可用'
    };
  }

  const supported = await isFnosHostBridgeSupported(300);
  if (!supported) {
    return {
      success: false,
      error: '宿主系统未开放应用设置通信接口，请在飞牛系统【应用中心】->【已安装】->【NovelAI WebUI】->【设置】中配置'
    };
  }

  // Also broadcast standard postMessage events to parent/top window as backup
  try {
    if (typeof window !== 'undefined') {
      const targets = [window.parent, window.top].filter(Boolean);
      for (const t of targets) {
        if (t && t !== window) {
          t.postMessage({ type: 'openAppSetting', appName: 'novelai' }, '*');
          t.postMessage({ action: 'openAppSetting', appName: 'novelai' }, '*');
          t.postMessage({ fnOS: 'openAppSetting', appName: 'novelai' }, '*');
          t.postMessage({ type: 'trim:openAppSetting', appName: 'novelai' }, '*');
        }
      }
    }
  } catch {}

  try {
    const app = getTrimApp();
    await promiseWithTimeout(
      app.openAppSetting(),
      timeoutMs,
      '宿主系统设置响应超时（宿主未响应通信协议）'
    );
    return { success: true };
  } catch (err: any) {
    console.warn('[fnosBridge] openAppSetting failed or timed out:', err?.message);
    return {
      success: false,
      error: err?.message || '调起系统设置未响应'
    };
  }
}

/**
 * Check if the current page was loaded via an App Auth redirect callback and extract authorized path.
 */
export function checkAppAuthCallback(): FnosAppAuthCallbackResult {
  if (typeof window === 'undefined' || !window.location.search) {
    return { hasCallback: false };
  }

  try {
    const app = getTrimApp();
    const result = app.parseAppAuthCallback(window.location.search);

    if (result && result.status) {
      // Clean up the URL parameters so a page refresh does not re-trigger
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('status');
        url.searchParams.delete('path');
        url.searchParams.delete('method');
        url.searchParams.delete('appName');
        url.searchParams.delete('state');
        url.searchParams.delete('error');
        window.history.replaceState({}, document.title, url.toString());
      } catch {}

      if (result.status === 'success' && result.path && result.path.length > 0) {
        return {
          hasCallback: true,
          status: 'success',
          path: String(result.path[0]),
          method: result.method,
          appName: result.appName
        };
      }

      return {
        hasCallback: true,
        status: result.status,
        method: result.method,
        appName: result.appName,
        error: result.error
      };
    }
  } catch (err: any) {
    console.warn('[fnosBridge] Failed to parse App Auth callback:', err?.message);
  }

  return { hasCallback: false };
}
