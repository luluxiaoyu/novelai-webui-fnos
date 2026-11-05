/**
 * fnOS JS Bridge integration for desktop environment.
 * Handles detection of fnOS desktop iframe, invocation of native picker,
 * and graceful fallback.
 */

export interface FnosPickResult {
  supported: boolean;
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

/**
 * Returns true if the app is embedded inside an iframe (e.g. fnOS desktop shell).
 */
export function isInsideFnOS(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.parent !== window;
  } catch {
    // Cross-origin iframe security restriction
    return true;
  }
}

/**
 * Invokes native fnOS directory picker if available, or sends postMessage.
 * If unsupported or running in standalone browser, returns { supported: false }.
 */
export async function pickSharedDirectory(timeoutMs = 30000): Promise<FnosPickResult> {
  if (!isInsideFnOS()) {
    return { supported: false, success: false, error: '当前未运行在飞牛桌面宿主环境中' };
  }

  // 1. Check direct fnos SDK if exposed globally on window, window.parent, or window.top
  try {
    const directApi =
      (window as any).fnos?.pickSharedFile ||
      ((window.parent as any) && (window.parent as any).fnos?.pickSharedFile) ||
      ((window.top as any) && (window.top as any).fnos?.pickSharedFile);
    if (typeof directApi === 'function') {
      const res = await directApi({ directory: true });
      if (!res) {
        return { supported: true, success: false, canceled: true };
      }
      const pickedPath =
        typeof res === 'string'
          ? res
          : (res.path || res.dir || res.result || (Array.isArray(res) ? res[0]?.path || res[0] : null));
      if (pickedPath) {
        return { supported: true, success: true, path: String(pickedPath) };
      }
      return { supported: true, success: false, canceled: true };
    }
  } catch {
    // Cross-origin restriction or not defined, continue to postMessage
  }

  // 2. Fallback to iframe postMessage protocol
  return new Promise<FnosPickResult>((resolve) => {
    const requestId = `fnos_dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('message', handleMessage);
    };

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      const isMatch =
        data.requestId === requestId ||
        data.type === 'fnos:pickSharedFile:response' ||
        data.action === 'pickSharedFile:response' ||
        data.event === 'pickSharedFile:response' ||
        data.type === 'pickSharedFile:response' ||
        (data.type === 'fnos:pickSharedFile' && (data.response || data.result !== undefined)) ||
        (data.action === 'pickSharedFile' && (data.result !== undefined || data.path !== undefined));

      if (!isMatch) return;

      cleanup();

      if (data.canceled || data.cancelled) {
        resolve({ supported: true, success: false, canceled: true });
        return;
      }
      if (data.error) {
        resolve({ supported: true, success: false, error: data.error });
        return;
      }

      const rawPath =
        data.path ||
        data.dir ||
        data.result ||
        (Array.isArray(data.paths) ? data.paths[0] : null) ||
        data.payload?.path ||
        data.payload?.dir ||
        data.payload?.result ||
        (Array.isArray(data.payload) ? data.payload[0]?.path || data.payload[0] : null) ||
        data.data?.path ||
        data.data?.dir ||
        data.data?.result;

      if (rawPath) {
        resolve({ supported: true, success: true, path: String(rawPath) });
      } else {
        resolve({ supported: true, success: false, canceled: true });
      }
    };

    window.addEventListener('message', handleMessage);

    const messagePayload = {
      type: 'fnos:pickSharedFile',
      action: 'pickSharedFile',
      requestId,
      options: { directory: true },
      payload: { directory: true },
      params: { directory: true }
    };

    try {
      window.parent.postMessage(messagePayload, '*');
      if (window.top && window.top !== window.parent) {
        try {
          window.top.postMessage(messagePayload, '*');
        } catch {}
      }
    } catch (e: any) {
      cleanup();
      resolve({ supported: false, success: false, error: e.message });
      return;
    }

    timer = setTimeout(() => {
      cleanup();
      resolve({ supported: false, success: false, error: '飞牛桌面未响应原生选择器调用' });
    }, timeoutMs);
  });
}
