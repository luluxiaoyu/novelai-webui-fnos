import { TrimApp } from '@trimjs/web-app';

export interface FnosPickResult {
  supported: boolean;
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface FnosAppAuthResult {
  status: 'success' | 'cancel' | 'error';
  path?: string[];
  state?: string;
  method?: string;
  appName?: string;
  error?: string;
}

export const AUTH_STORAGE_KEY = 'novelai:folder-auth';
export const AUTH_MESSAGE_TYPE = 'novelai:folder-auth-result';
let trimAppInstance: TrimApp | null = null;
let pickerPromise: Promise<FnosPickResult> | null = null;
let authWindow: Window | null = null;

export function getTrimApp(): TrimApp {
  return trimAppInstance ??= new TrimApp({ debug: false });
}

export function isInsideFnOS(): boolean {
  return typeof window !== 'undefined' && !getTrimApp().isStandaloneWeb;
}

async function ready(): Promise<TrimApp> {
  const app = getTrimApp();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('飞牛宿主初始化超时，请重试；原生授权需要受支持的 fnOS 和飞牛 App 版本')), 5000);
      })
    ]);
    return app;
  } finally { clearTimeout(timer); }
}

export function pickSharedDirectory(): Promise<FnosPickResult> {
  if (pickerPromise) return pickerPromise;
  pickerPromise = (async (): Promise<FnosPickResult> => {
    if (!isInsideFnOS()) return { supported: false, success: false, error: '请使用浏览器授权页面' };
    try {
      const app = await ready();
      // A picker waits for the user, not a short RPC timeout. Never fall back to personal grants.
      const result = await app.pickSharedFile({ title: '选择存储目录', okText: '确认授权', sidebarGroup: ['myFiles', 'otherShare', 'favorites'] });
      if (result && result.code !== 0) return { supported: true, success: false, error: result.msg || '飞牛目录授权失败' };
      if (!result?.data?.length) return { supported: true, success: false, canceled: true };
      return { supported: true, success: true, path: result.data[0] };
    } catch (error) {
      return { supported: false, success: false, error: error instanceof Error ? error.message : '飞牛目录选择器调用失败' };
    }
  })().finally(() => { pickerPromise = null; });
  return pickerPromise;
}

export async function openFnOSAppSetting(): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isInsideFnOS()) throw new Error('请在飞牛桌面【应用中心 → 已安装 → NovelAI WebUI → 设置】中管理访问权限');
    const app = await ready();
    await app.openAppSetting();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '打开系统设置失败' };
  }
}

export async function openAppAuthRoute(): Promise<{ success: boolean; error?: string }> {
  if (!getTrimApp().isStandaloneWeb) return { success: false, error: '请在当前宿主内使用“添加授权”打开原生选择器' };
  if (authWindow && !authWindow.closed) {
    authWindow.focus();
    return { success: false, error: '已有授权页面，请先完成或关闭该页面' };
  }
  try {
    // getRandomValues also works on the HTTP origins commonly used by local NAS installations.
    const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ state, expires: Date.now() + 10 * 60 * 1000 }));
    // Reserve the popup during the click event, before awaiting the SDK URL builder.
    authWindow = window.open('about:blank', `novelai_auth_${state}`);
    if (!authWindow) throw new Error('浏览器阻止了授权窗口，请允许本站弹出窗口后重试');
    const url = await getTrimApp().buildAppAuthUrl('pickSharedFile', {
      appName: 'novelai', sidebarGroup: ['myFiles', 'otherShare', 'favorites'],
      redirectUri: new URL('/app/novelai/auth-callback.html', window.location.origin).href,
      state
    });
    authWindow.location.replace(url);
    return { success: true };
  } catch (error) {
    authWindow?.close();
    authWindow = null;
    try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
    return { success: false, error: error instanceof Error ? error.message : '打开授权页面失败' };
  }
}

export function isValidAuthResult(result: FnosAppAuthResult): boolean {
  try {
    const pending = JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    return Boolean(pending && pending.expires > Date.now() && pending.state === result.state && result.appName === 'novelai' &&
      result.method === 'pickSharedFile' && ['success', 'cancel', 'error'].includes(result.status) &&
      (result.status !== 'success' || (Array.isArray(result.path) && result.path.length > 0 && result.path.every(p => typeof p === 'string' && p.startsWith('/')))));
  } catch { return false; }
}

export function onDirectoryAuthorization(callback: (result: FnosAppAuthResult) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || !authWindow || event.source !== authWindow || event.data?.type !== AUTH_MESSAGE_TYPE) return;
    const result = event.data.result as FnosAppAuthResult;
    if (!result || !isValidAuthResult(result)) return;
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    authWindow = null;
    callback(result);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
