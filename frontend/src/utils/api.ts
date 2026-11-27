import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { useAuthStore } from '../stores/auth';
import { xorUint8Array } from './cipher';

const getSavedEncryptionSettings = () => {
  try {
    const raw = localStorage.getItem('novelai_encryption_settings');
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return {
    enabled: (import.meta as any).env.VITE_ENABLE_ENCRYPTION === 'true',
    key: 'nahida1027'
  };
};

const initialSettings = getSavedEncryptionSettings();

export const encryptionConfig = {
  enabled: initialSettings?.enabled === true,
  key: typeof initialSettings?.key === 'string' ? initialSettings.key.trim() || 'nahida1027' : 'nahida1027'
};

export const setEncryptionConfig = (enabled: boolean, key?: string) => {
  encryptionConfig.enabled = !!enabled;
  encryptionConfig.key = key?.trim() || 'nahida1027';
  try {
    localStorage.setItem('novelai_encryption_settings', JSON.stringify({
      enabled: encryptionConfig.enabled,
      key: encryptionConfig.key
    }));
  } catch {}
};

export const isEncryptionEnabled = (): boolean => encryptionConfig.enabled;

export function getGatewayBaseUrl(): string {
  if (typeof window !== 'undefined') {
    if (window.location.pathname.startsWith('/app/novelai')) {
      return '/app/novelai';
    }
    if (window.location.pathname.includes('/index.cgi')) {
      const idx = window.location.pathname.indexOf('/index.cgi');
      return window.location.pathname.slice(0, idx + 10);
    }
  }
  return '';
}

export function resolveApiUrl(url?: string): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:') || url.startsWith('data:')) {
    return url;
  }
  const base = getGatewayBaseUrl();
  if (base) {
    const cleanUrl = url.startsWith('/') ? url : `/${url}`;
    if (!cleanUrl.startsWith(base)) {
      return `${base}${cleanUrl}`;
    }
  }
  return url;
}

export async function fetchBackendSettings() {
  // The server's current settings must be readable with an empty or stale browser cache.
  const { siteAccessKey } = useAuthStore();
  const { data } = await axios.get(resolveApiUrl('/api/settings'), {
    params: { bootstrap: 1 },
    headers: { 'Cache-Control': 'no-cache', ...(siteAccessKey ? { 'x-access-key': siteAccessKey } : {}) },
    timeout: 10000
  });
  const settings = data?.settings || data;
  if (data?.success !== true || typeof settings?.enableEncryption !== 'boolean') {
    throw new Error('服务器设置响应无法读取，请确认已登录飞牛后重试');
  }
  return settings;
}

const getEncryptKey = (headers?: any): string => {
  if (encryptionConfig.key && encryptionConfig.key.trim()) {
    return encryptionConfig.key.trim();
  }
  const customKey = headers?.['x-access-key'];
  if (customKey && typeof customKey === 'string' && customKey.trim()) {
    return `nahida1027${customKey.trim()}`;
  }
  const authStore = useAuthStore();
  return authStore.siteAccessKey ? `nahida1027${authStore.siteAccessKey}` : 'nahida1027';
};

function decodeApiResponse(response: AxiosResponse, key: string, responseType: AxiosRequestConfig['responseType']) {
  const encrypted = response.headers['x-encrypted'] === '1';
  const success = response.status >= 200 && response.status < 300;
  const bytes = new Uint8Array(response.data);
  const body = encrypted ? xorUint8Array(bytes, key) : bytes;

  if (success && (responseType === 'arraybuffer' || responseType === 'blob')) {
    response.data = responseType === 'blob'
      ? new Blob([body], { type: String(response.headers['content-type'] || '') })
      : body.buffer;
    return;
  }
  if (response.status === 204 || response.status === 205) return;

  const text = new TextDecoder().decode(body);
  if (responseType === 'text' && success) {
    response.data = text;
    return;
  }
  try {
    response.data = JSON.parse(text);
  } catch {
    if (success) throw new Error(encrypted
      ? '无法解密服务器响应，请重试读取以同步加密设置'
      : '服务器返回了非 JSON 或空响应，请确认已登录飞牛后重试');
    response.data = text;
  }
}

export const encryptedAxios = async (config: AxiosRequestConfig) => {
  const authStore = useAuthStore();
  const modifiedConfig = { ...config };
  if (modifiedConfig.url) {
    modifiedConfig.url = resolveApiUrl(modifiedConfig.url);
  }
  const headers = { ...(config.headers || {}) } as Record<string, any>;
  modifiedConfig.headers = headers;

  if (authStore.siteAccessKey && !headers['x-access-key']) {
    headers['x-access-key'] = authStore.siteAccessKey;
  }

  const key = getEncryptKey(headers);
  if (isEncryptionEnabled()) {
    headers['x-encrypted'] = '1';
    if (modifiedConfig.data) {
      const data = modifiedConfig.data;
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
      modifiedConfig.data = xorUint8Array(bytes, key).buffer;
      headers['Content-Type'] = 'application/octet-stream';
    }
  }
  modifiedConfig.responseType = 'arraybuffer';

  let response;
  try {
    response = await axios(modifiedConfig);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      decodeApiResponse(error.response, key, config.responseType);
    }
    throw error;
  }
  decodeApiResponse(response, key, config.responseType);
  return response;
};

export const encryptedFetchStream = async (url: string, options: RequestInit) => {
  const targetUrl = resolveApiUrl(url);
  const authStore = useAuthStore();
  const headersObj: Record<string, string> = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((v, k) => { headersObj[k] = v; });
    } else if (Array.isArray(options.headers)) {
      options.headers.forEach(([k, v]) => { headersObj[k] = v; });
    } else {
      Object.assign(headersObj, options.headers);
    }
  }

  if (authStore.siteAccessKey && !headersObj['x-access-key']) {
    headersObj['x-access-key'] = authStore.siteAccessKey;
  }

  const modifiedOptions: RequestInit = { ...options, headers: headersObj };

  if (!isEncryptionEnabled()) return fetch(targetUrl, modifiedOptions);

  const key = getEncryptKey(headersObj);
  headersObj['x-encrypted'] = '1';

  if (modifiedOptions.body) {
    const bytes = new TextEncoder().encode(modifiedOptions.body as string);
    modifiedOptions.body = xorUint8Array(bytes, key).buffer as any;
    headersObj['Content-Type'] = 'application/octet-stream';
  }

  const response = await fetch(targetUrl, modifiedOptions);

  if (!response.body || response.headers.get('x-encrypted') !== '1') return response;

  const reader = response.body.getReader();
  const keyBuf = new TextEncoder().encode(key);
  let responseOffset = 0;

  const decryptedStream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          break;
        }
        if (value) {
          const decrypted = new Uint8Array(value.length);
          for (let i = 0; i < value.length; i++) {
            decrypted[i] = value[i] ^ keyBuf[(responseOffset + i) % keyBuf.length];
          }
          responseOffset += value.length;
          controller.enqueue(decrypted);
        }
      }
    }
  });

  return new Response(decryptedStream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
};
