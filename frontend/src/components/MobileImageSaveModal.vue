<template>
  <div 
    v-if="modelValue" 
    class="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md animate-fade-in"
    @click="close"
  >
    <div 
      class="w-full max-w-lg bg-white dark:bg-gray-900 rounded-3xl border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-fade-in"
      @click.stop
    >
      <!-- 弹窗顶栏 -->
      <div class="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 shrink-0">
        <div class="flex items-center gap-2">
          <Smartphone class="w-5 h-5 text-blue-500" />
          <h3 class="text-sm sm:text-base font-bold text-gray-900 dark:text-gray-100">保存图片到手机相册</h3>
        </div>
        <button 
          @click="close" 
          class="p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition cursor-pointer"
          title="关闭"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- 内容主体 (可滚动) -->
      <div class="p-4 sm:p-5 overflow-y-auto custom-scrollbar flex flex-col gap-3.5">
        <!-- 图片大图展示区 (必须显式放行长按呼出系统菜单) -->
        <div class="relative w-full bg-gray-950 rounded-2xl flex items-center justify-center p-2.5 overflow-hidden select-text">
          <img 
            :src="imageUrl" 
            :alt="filename" 
            class="max-w-full max-h-[38vh] sm:max-h-[44vh] object-contain rounded-xl shadow-lg select-text cursor-pointer"
            style="-webkit-touch-callout: default !important; -webkit-user-select: auto !important; user-select: auto !important; pointer-events: auto !important;"
            @contextmenu.stop
          />
        </div>

        <!-- 长按相册保存指引提示卡片 -->
        <div class="flex items-start gap-2.5 p-3 rounded-2xl bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-900/40 text-blue-800 dark:text-blue-300 text-xs leading-relaxed">
          <HelpCircle class="w-4 h-4 shrink-0 text-blue-500 mt-0.5" />
          <div>
            <p class="font-semibold mb-0.5">手机相册保存说明</p>
            <p class="text-[11px] text-blue-700/90 dark:text-blue-300/80 leading-normal">
              长按上方图片，在弹出的系统菜单中选择「保存图片」或「存储图像」，即可直接存入手机系统相册。
            </p>
          </div>
        </div>

        <!-- 临时操作反馈提示条 -->
        <div 
          v-if="feedbackText" 
          class="p-2.5 rounded-xl text-xs flex items-center gap-2 animate-fade-in"
          :class="feedbackIsError ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800' : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'"
        >
          <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="feedbackIsError ? 'bg-red-500' : 'bg-emerald-500'"></span>
          <span>{{ feedbackText }}</span>
        </div>

        <!-- 快捷操作选项列表 -->
        <div class="flex flex-col gap-2 pt-1">
          <!-- 系统原生分享保存（现代浏览器/WebView支持时） -->
          <button 
            v-if="canShare"
            type="button"
            @click="handleShare"
            :disabled="isSharing"
            class="w-full flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/80 hover:bg-purple-50 dark:hover:bg-purple-950/40 border border-gray-200/80 dark:border-gray-700/80 transition active:scale-[0.98] text-left cursor-pointer group"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-purple-500/10 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                <Loader2 v-if="isSharing" class="w-4 h-4 animate-spin" />
                <Share2 v-else class="w-4 h-4" />
              </div>
              <div>
                <div class="text-xs font-semibold text-gray-900 dark:text-gray-100 group-hover:text-purple-600 dark:group-hover:text-purple-400">调用系统相册保存 / 分享</div>
                <div class="text-[11px] text-gray-500 dark:text-gray-400">呼出系统原生面板直接存储至系统相册</div>
              </div>
            </div>
            <ChevronRight class="w-4 h-4 text-gray-400 group-hover:text-purple-500 transition shrink-0" />
          </button>

          <!-- 复制图片到剪贴板 -->
          <button 
            type="button"
            @click="handleCopyImage"
            :disabled="isCopying"
            class="w-full flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/80 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-gray-200/80 dark:border-gray-700/80 transition active:scale-[0.98] text-left cursor-pointer group"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Check v-if="isCopied" class="w-4 h-4 text-emerald-500" />
                <Loader2 v-else-if="isCopying" class="w-4 h-4 animate-spin" />
                <Copy v-else class="w-4 h-4" />
              </div>
              <div>
                <div class="text-xs font-semibold text-gray-900 dark:text-gray-100 group-hover:text-emerald-600 dark:group-hover:text-emerald-400">
                  {{ isCopied ? '已成功复制图片到剪贴板' : '复制图片到剪贴板' }}
                </div>
                <div class="text-[11px] text-gray-500 dark:text-gray-400">可直接在微信、小红书或聊天应用中粘贴发送</div>
              </div>
            </div>
            <ChevronRight class="w-4 h-4 text-gray-400 group-hover:text-emerald-500 transition shrink-0" />
          </button>

          <!-- 在手机自带浏览器中打开原图 -->
          <button 
            type="button"
            @click="handleOpenBrowser"
            class="w-full flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/80 hover:bg-amber-50 dark:hover:bg-amber-950/40 border border-gray-200/80 dark:border-gray-700/80 transition active:scale-[0.98] text-left cursor-pointer group"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                <ExternalLink class="w-4 h-4" />
              </div>
              <div>
                <div class="text-xs font-semibold text-gray-900 dark:text-gray-100 group-hover:text-amber-600 dark:group-hover:text-amber-400">在手机自带浏览器中打开</div>
                <div class="text-[11px] text-gray-500 dark:text-gray-400">呼出手机浏览器新标签页，支持直接下载或长按存图</div>
              </div>
            </div>
            <ChevronRight class="w-4 h-4 text-gray-400 group-hover:text-amber-500 transition shrink-0" />
          </button>

          <!-- 备选：尝试浏览器直接下载 -->
          <button 
            type="button"
            @click="handleDirectDownload"
            class="w-full flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/80 hover:bg-blue-50 dark:hover:bg-blue-950/40 border border-gray-200/80 dark:border-gray-700/80 transition active:scale-[0.98] text-left cursor-pointer group"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <Download class="w-4 h-4" />
              </div>
              <div>
                <div class="text-xs font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400">尝试直接下载文件</div>
                <div class="text-[11px] text-gray-500 dark:text-gray-400">调用浏览器默认文件下载通道</div>
              </div>
            </div>
            <ChevronRight class="w-4 h-4 text-gray-400 group-hover:text-blue-500 transition shrink-0" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { 
  X, Download, Share2, Copy, Check, ExternalLink, 
  Loader2, Smartphone, HelpCircle, ChevronRight
} from 'lucide-vue-next';
import { openInSystemBrowser } from '../utils/fnosBridge';
import { saveAs } from 'file-saver';

const props = defineProps<{
  modelValue: boolean;
  imageUrl: string;
  filename: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const isSharing = ref(false);
const isCopying = ref(false);
const isCopied = ref(false);
const feedbackText = ref('');
const feedbackIsError = ref(false);

const canShare = computed(() => {
  return typeof navigator !== 'undefined' && 
    typeof window !== 'undefined' && 
    !!navigator.canShare && 
    !!window.isSecureContext;
});

const close = () => {
  feedbackText.value = '';
  emit('update:modelValue', false);
};

const handleShare = async () => {
  if (isSharing.value) return;
  isSharing.value = true;
  feedbackText.value = '';
  try {
    const resp = await fetch(props.imageUrl);
    const blob = await resp.blob();
    const file = new File([blob], props.filename, { type: blob.type || 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: '保存到手机相册',
        text: props.filename
      });
      feedbackIsError.value = false;
      feedbackText.value = '已呼出系统相册保存面板';
    } else {
      feedbackIsError.value = true;
      feedbackText.value = '当前运行环境不支持系统文件分享';
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      feedbackIsError.value = true;
      feedbackText.value = '调用系统保存失败: ' + (err.message || '未知错误');
    }
  } finally {
    isSharing.value = false;
  }
};

const handleCopyImage = async () => {
  if (isCopying.value) return;
  isCopying.value = true;
  feedbackText.value = '';
  try {
    const resp = await fetch(props.imageUrl);
    const blob = await resp.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || 'image/png']: blob })
    ]);
    isCopied.value = true;
    feedbackIsError.value = false;
    feedbackText.value = '已成功复制图片，可直接粘贴到微信等应用中发送';
    setTimeout(() => {
      isCopied.value = false;
    }, 2500);
  } catch (err: any) {
    feedbackIsError.value = true;
    feedbackText.value = '复制到剪贴板失败，请直接长按图片保存';
  } finally {
    isCopying.value = false;
  }
};

const handleOpenBrowser = async () => {
  let targetUrl = props.imageUrl;
  if (!targetUrl.includes('?')) {
    targetUrl += '?download=1&filename=' + encodeURIComponent(props.filename);
  } else if (!targetUrl.includes('download=')) {
    targetUrl += '&download=1&filename=' + encodeURIComponent(props.filename);
  }
  await openInSystemBrowser(targetUrl);
  feedbackIsError.value = false;
  feedbackText.value = '正在唤起手机自带浏览器打开原图';
};

const handleDirectDownload = async () => {
  try {
    const resp = await fetch(props.imageUrl);
    const blob = await resp.blob();
    saveAs(blob, props.filename);
    feedbackIsError.value = false;
    feedbackText.value = '已触发浏览器下载请求';
  } catch {
    saveAs(props.imageUrl, props.filename);
  }
};
</script>
