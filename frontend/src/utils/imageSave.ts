import { saveAs } from 'file-saver';
import { ref } from 'vue';
import { useGenerationStore, type GeneratedImage } from '../stores/generation';
import { getTrimApp, openNasImageFile } from './fnosBridge';
import { isMobileDevice } from './mobilePerf';

export interface MobileSaveImagePayload {
  url: string;
  filename: string;
}

interface SaveImageOptions {
  image: GeneratedImage;
  filename: string;
  profile: string;
  onOpenMobileModal: (data: MobileSaveImagePayload) => void;
}

export const openingMobileImageId = ref<string | null>(null);

export async function saveOrDownloadImage(options: SaveImageOptions): Promise<void> {
  const { image, filename, profile, onOpenMobileModal } = options;

  if (!getTrimApp().isWeb) {
    if (openingMobileImageId.value !== null) return;
    openingMobileImageId.value = image.id;
    try {
      const saved = await useGenerationStore().ensureNasImageSaved(profile, image);
      const result = await openNasImageFile(saved.profile, {
        id: image.id,
        url: saved.url?.startsWith('blob:') ? undefined : saved.url
      });
      if (!result.success) throw new Error(result.message || '打开飞牛看图器失败');
    } catch (error) {
      alert(error instanceof Error ? error.message : '打开飞牛看图器失败');
    } finally {
      openingMobileImageId.value = null;
    }
    return;
  }

  const { url } = image;
  if (isMobileDevice()) {
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

    onOpenMobileModal({ url, filename });
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
