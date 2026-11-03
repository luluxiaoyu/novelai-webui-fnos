import axios, { AxiosRequestConfig } from 'axios';
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
  enabled: !!initialSettings.enabled,
  key: initialSettings.key || 'nahida1027'
};

export const setEncryptionConfig = (enabled: boolean, key?: string) => {
  encryptionConfig.enabled = !!enabled;
  if (key && key.trim()) {
    encryptionConfig.key = key.trim();
  }
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

  if (!isEncryptionEnabled()) {
    return axios(modifiedConfig);
  }

  const key = getEncryptKey(headers);
  headers['x-encrypted'] = '1';

  if (modifiedConfig.data) {
    let dataToEncrypt = modifiedConfig.data;
    if (typeof dataToEncrypt !== 'string' && !(dataToEncrypt instanceof Uint8Array)) {
      dataToEncrypt = JSON.stringify(dataToEncrypt);
    }
    const bytes = typeof dataToEncrypt === 'string' ? new TextEncoder().encode(dataToEncrypt) : dataToEncrypt;
    modifiedConfig.data = xorUint8Array(bytes, key).buffer;
    headers['Content-Type'] = 'application/octet-stream';
  }

  const originalResponseType = modifiedConfig.responseType;
  modifiedConfig.responseType = 'arraybuffer'; 

  let res;
  try {
    res = await axios(modifiedConfig);
  } catch (error: any) {
    if (error.response && error.response.data) {
      try {
        const decrypted = xorUint8Array(new Uint8Array(error.response.data), key);
        const text = new TextDecoder().decode(decrypted);
        try {
          error.response.data = JSON.parse(text);
        } catch {
          error.response.data = text;
        }
      } catch (decErr) {
        // Fallback if decryption fails
      }
    }
    throw error;
  }

  if (res.data) {
    const decrypted = xorUint8Array(new Uint8Array(res.data), key);
    if (originalResponseType !== 'arraybuffer' && originalResponseType !== 'blob') {
      const text = new TextDecoder().decode(decrypted);
      try {
        res.data = JSON.parse(text);
      } catch {
        res.data = text;
      }
    } else {
      res.data = decrypted.buffer;
    }
  }

  return res;
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
  
  if (!response.body) return response;

  const reader = response.body.getReader();
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
          const keyBuf = new TextEncoder().encode(key);
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
