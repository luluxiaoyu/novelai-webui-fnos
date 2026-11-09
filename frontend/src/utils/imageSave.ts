import { saveAs } from 'file-saver';
import { isMobileDevice, isMobileFnosApp } from './mobilePerf';

export interface MobileSaveImagePayload {
  url: string;
  filename: string;
  profile?: string;
  item?: any;
}

export interface SaveImageOptions extends MobileSaveImagePayload {
  onOpenMobileModal: (data: MobileSaveImagePayload) => void;
}

/**
 * 跨平台图片保存与下载分发器
 * - PC 桌面端：直接调用浏览器原生下载保存到本地
 * - 移动端 / 飞牛手机客户端：优先尝试 Web Share API 保存至系统相册；不支持时唤起专属保存弹窗（长按存入相册、飞牛查看器存图等）
 */
export async function saveOrDownloadImage(options: SaveImageOptions): Promise<void> {
  const { url, filename, profile, item, onOpenMobileModal } = options;

  // 1. 处于移动设备环境（包括飞牛移动客户端与移动端网页浏览器）
  if (isMobileDevice() || isMobileFnosApp()) {
    // 若浏览器支持 Web Share API 文件共享且处于安全上下文，尝试调起原生分享面板
    if (typeof navigator !== 'undefined' && typeof window !== 'undefined' && navigator.canShare && window.isSecureContext) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const file = new File([blob], filename, { type: blob.type || 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: '保存到手机相册',
            text: filename
          });
          return;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // 用户在系统弹窗中主动取消，无需继续弹窗
          return;
        }
        console.warn('[imageSave] Web Share API failed, fallback to modal:', err);
      }
    }

    // 无法直接通过系统 Share 保存时（如 HTTP 局域网、WebView 未授权等），唤起专属移动端保存相册弹窗
    onOpenMobileModal({ url, filename, profile, item });
    return;
  }

  // 2. PC 桌面端：标准浏览器直接触发文件下载
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    saveAs(blob, filename);
  } catch {
    saveAs(url, filename);
  }
}
