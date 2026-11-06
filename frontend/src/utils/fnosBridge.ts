import { TrimApp } from '@trimjs/web-app';
import { resolveApiUrl } from './api';

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

export function getParentFolderPath(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash > 0) {
    return normalized.substring(0, lastSlash);
  } else if (lastSlash === 0) {
    return '/';
  }
  return normalized;
}

export async function openFnOSFileManager(targetPath: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isInsideFnOS()) return { success: false, error: '仅在飞牛系统桌面端内支持直接打开文件管理器' };
    const app = await ready();
    // 飞牛文件管理器仅接受目录路径，若传入带文件扩展名的路径则剥离文件名
    let dirPath = targetPath;
    if (/\.[a-zA-Z0-9]{2,6}$/.test(dirPath)) {
      dirPath = getParentFolderPath(dirPath);
    }
    await app.openFileManager(dirPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '打开文件管理器失败' };
  }
}

export async function openFnOSFile(filePath: string): Promise<{ success: boolean; error?: string }> {
  if (!isInsideFnOS()) return { success: false, error: '仅在飞牛系统桌面端内支持直接打开文件' };
  try {
    const app = await ready();
    await app.openFile(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '打开文件失败' };
  }
}

export async function getNasImageDiskPath(profile: string, item: { url?: string; id?: string }): Promise<string> {
  if (!item || (!item.url && !item.id)) {
    throw new Error('无效的图片标识');
  }
  const targetUrl = resolveApiUrl(`/api/profiles/images/disk-path?profile=${encodeURIComponent(profile || 'Default')}&url=${encodeURIComponent(item.url || '')}&id=${encodeURIComponent(item.id || '')}`);
  const res = await fetch(targetUrl);
  if (!res.ok) {
    let err = '未找到该图片在 NAS 上的持久化文件';
    try { const j = await res.json(); if (j.error) err = j.error; } catch {}
    throw new Error(err);
  }
  const data = await res.json();
  if (!data.success || !data.path) {
    throw new Error(data.error || '未获取到磁盘路径');
  }
  return data.path as string;
}

export async function openNasImageFile(profile: string, item: { url?: string; id?: string }): Promise<{ success: boolean; message?: string }> {
  try {
    const diskPath = await getNasImageDiskPath(profile, item);
    if (!isInsideFnOS()) {
      try {
        await navigator.clipboard.writeText(diskPath);
        return { success: true, message: `已复制 NAS 文件路径到剪贴板: ${diskPath}` };
      } catch {
        return { success: false, message: `NAS 文件路径: ${diskPath}` };
      }
    }
    const openRes = await openFnOSFile(diskPath);
    if (!openRes.success) {
      return { success: false, message: openRes.error || '打开文件失败' };
    }
    return { success: true, message: '已在 NAS 中打开图片文件' };
  } catch (err: any) {
    return { success: false, message: err.message || '打开文件失败' };
  }
}

export async function openNasImageFolder(profile: string, item: { url?: string; id?: string }): Promise<{ success: boolean; message?: string }> {
  try {
    const diskPath = await getNasImageDiskPath(profile, item);
    const folderPath = getParentFolderPath(diskPath);
    if (!folderPath) {
      return { success: false, message: '无法解析所在文件夹路径' };
    }
    if (!isInsideFnOS()) {
      try {
        await navigator.clipboard.writeText(folderPath);
        return { success: true, message: `已复制 NAS 所在文件夹路径到剪贴板: ${folderPath}` };
      } catch {
        return { success: false, message: `NAS 文件夹路径: ${folderPath}` };
      }
    }
    const openRes = await openFnOSFileManager(folderPath);
    if (!openRes.success) {
      return { success: false, message: openRes.error || '打开文件管理器失败' };
    }
    return { success: true, message: '已在文件管理器中定位文件夹' };
  } catch (err: any) {
    return { success: false, message: err.message || '定位文件夹失败' };
  }
}

export const openNasImageInHost = openNasImageFile;

export async function pickNasImage(): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }> {
  if (!isInsideFnOS()) return { success: false, error: '请在飞牛系统桌面端内使用此功能' };
  try {
    const app = await ready();
    const files = await app.pickFile({
      accept: ['.png', '.jpg', '.jpeg', '.webp'],
      sidebarGroup: ['myFiles', 'otherShare', 'favorites'],
      title: '从 NAS 选择图片'
    });
    if (!files || files.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, path: files[0] };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '选择图片失败' };
  }
}

export async function fetchNasImageFile(targetPath: string): Promise<File> {
  const url = resolveApiUrl(`/api/storage/raw-image?path=${encodeURIComponent(targetPath)}`);
  const response = await fetch(url);
  if (!response.ok) {
    let errMsg = `读取图片失败 (HTTP ${response.status})`;
    try {
      const json = await response.json();
      if (json.error) errMsg = json.error;
    } catch {}
    throw new Error(errMsg);
  }
  const blob = await response.blob();
  const filename = targetPath.split('/').filter(Boolean).pop() || 'nas_image.png';
  return new File([blob], filename, { type: blob.type || 'image/png' });
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

/**
 * 设置或清除飞牛系统退出页面提示
 * 当传入 params 时启用提示；未传参或传 null/undefined 时清除提示
 */
export async function setFnOSExitPageTips(params?: { title?: string; content?: string } | null): Promise<void> {
  if (!isInsideFnOS()) return;
  try {
    const app = await ready();
    if (params) {
      await app.setExitPageTips({
        title: params.title || '任务进行中',
        content: params.content || '当前任务尚未完成，确认退出可能导致数据丢失或中断。'
      });
    } else {
      await app.setExitPageTips();
    }
  } catch (err) {
    console.warn('[fnOS] Failed to setExitPageTips:', err);
  }
}

/**
 * 初始化并监听飞牛系统日间/夜间主题同步
 */
export async function syncFnOSTheme(onThemeChange: (isDark: boolean) => void): Promise<(() => void) | undefined> {
  if (!isInsideFnOS()) return;
  try {
    const app = await ready();
    const config = await app.getPlatformConfig();
    if (config?.theme) {
      onThemeChange(config.theme === 'dark');
    }

    const handler = (theme: any) => {
      const isDark = typeof theme === 'string' ? theme === 'dark' : (theme?.theme === 'dark' || Boolean(theme?.dark));
      onThemeChange(isDark);
    };

    try {
      await app.$on('os/theme', handler);
      return () => {
        try { app.$off('os/theme', handler); } catch {}
      };
    } catch {
      // Event bus might not be available on older runtimes
    }
  } catch (err) {
    console.warn('[fnOS] Failed to sync platform theme:', err);
  }
}

