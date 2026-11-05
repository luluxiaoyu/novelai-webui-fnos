<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { encryptedAxios } from '../utils/api';
import { 
  isInsideFnOS, 
  pickSharedDirectory, 
  openAppAuthRoute, 
  onDirectoryAuthorization, 
  type FnosAppAuthResult 
} from '../utils/fnosBridge';
import CustomSelect from './CustomSelect.vue';
import { 
  Sparkles, KeyRound, Globe, Eye, EyeOff, 
  Check, Loader2, AlertCircle, ArrowRight, FolderTree,
  FolderPlus, RefreshCw
} from 'lucide-vue-next';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'completed'): void;
}>();

const authStore = useAuthStore();

const apiToken = ref('');
const showToken = ref(false);
const apiBaseUrl = ref('https://image.novelai.net');
const storagePath = ref('');
const originalStoragePath = ref('');
const canManageStorage = ref(false);
const imageSubdirPattern = ref('/{year}/{month}/');

interface AuthorizedPathItem {
  path: string;
  mountPath?: string | null;
  aliases?: string[];
  name: string;
  type: 'app_share' | 'share' | 'appdata' | 'custom';
  exists: boolean;
  writable: boolean;
  reason?: string | null;
  isCurrent?: boolean;
}

const authorizedPaths = ref<AuthorizedPathItem[]>([]);
const isLoadingPaths = ref(false);
const isPickingDirectory = ref(false);
const authorizationWarning = ref('');
const actionFeedback = ref<{ success: boolean; message: string } | null>(null);
let removeAuthListener: (() => void) | undefined;

const nowExample = new Date();
const currentYear = String(nowExample.getFullYear());
const currentMonth = String(nowExample.getMonth() + 1).padStart(2, '0');
const currentDay = String(nowExample.getDate()).padStart(2, '0');

const AVAILABLE_VARIABLES = [
  { name: '{year}', desc: `年份 ${currentYear}` },
  { name: '{month}', desc: `月份 ${currentMonth}` },
  { name: '{day}', desc: `日期 ${currentDay}` },
  { name: '{date}', desc: `年月日 ${currentYear}-${currentMonth}-${currentDay}` },
  { name: '{model}', desc: '模型标识' },
  { name: '{profile}', desc: '当前存档名' }
];

const insertVariable = (varName: string) => {
  let cur = imageSubdirPattern.value || '';
  if (cur.endsWith('/')) {
    cur += varName + '/';
  } else {
    cur += '/' + varName + '/';
  }
  cur = cur.replace(/\/+/g, '/');
  imageSubdirPattern.value = cur;
};

const handlePatternInput = () => {
  if (imageSubdirPattern.value.includes('\\')) {
    imageSubdirPattern.value = imageSubdirPattern.value.replace(/\\/g, '/');
  }
};

const handlePatternBlur = () => {
  let p = imageSubdirPattern.value.replace(/\\/g, '/').trim();
  p = p.replace(/[<>:"|?*\x00-\x1F]/g, '');
  const segments = p.split('/').map(s => s.trim()).filter(s => s && !/^\.+$/.test(s));
  if (segments.length === 0) {
    p = '/{year}/{month}/';
  } else {
    p = '/' + segments.join('/') + '/';
  }
  imageSubdirPattern.value = p;
};

interface StorageSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  badge?: string;
  badgeType?: 'success' | 'warning' | 'error' | 'default';
}

const storagePathOptions = computed<StorageSelectOption[]>(() => {
  const list: StorageSelectOption[] = authorizedPaths.value.map(item => ({
    value: item.path,
    label: item.name,
    sublabel: item.path,
    badge: item.writable ? '读写正常' : (item.reason || '无写入权限'),
    badgeType: item.writable ? 'success' : 'error'
  }));
  if (storagePath.value && !list.some(opt => opt.value === storagePath.value)) {
    list.push({
      value: storagePath.value,
      label: '自定义目录',
      sublabel: storagePath.value,
      badge: '自定义',
      badgeType: 'warning'
    });
  }
  return list;
});

const previewPath = computed(() => {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  const model = 'nai-diffusion-4-full';
  const profile = 'Default';

  let p = (imageSubdirPattern.value || '/{year}/{month}/').replace(/\\/g, '/').trim();
  p = p.replace(/[<>:"|?*\x00-\x1F]/g, '');
  const segments = p.split('/').map(s => s.trim()).filter(s => s && !/^\.+$/.test(s));
  const rawPattern = segments.length === 0 ? '{year}/{month}' : segments.join('/');

  const resolved = rawPattern
    .replace(/\{year\}/gi, year)
    .replace(/\{month\}/gi, month)
    .replace(/\{day\}/gi, day)
    .replace(/\{date\}/gi, dateStr)
    .replace(/\{model\}/gi, model)
    .replace(/\{profile\}/gi, profile)
    .replace(/\/+/g, '/');

  const cleanBase = (storagePath.value || originalStoragePath.value || 'NovelAI-WebUI').replace(/\/+$/, '');
  return `${cleanBase}/profiles/${profile}/${resolved}/image_example.png`.replace(/\/+/g, '/');
});

const isTestingUrl = ref(false);
const urlTestResult = ref<{ success: boolean; message: string } | null>(null);

const isSaving = ref(false);
const errorMessage = ref('');

const fetchAuthorizedPaths = async () => {
  isLoadingPaths.value = true;
  try {
    const res = await encryptedAxios({
      method: 'GET',
      url: '/api/storage/authorized-paths'
    });
    if (res.data && res.data.success) {
      authorizedPaths.value = res.data.paths || [];
      authorizationWarning.value = res.data.warning || '';
      if (!storagePath.value && res.data.currentPath) {
        storagePath.value = res.data.currentPath;
      }
    }
  } catch (err: any) {
    console.warn('[WelcomeModal] Failed to load authorized paths:', err.message);
  } finally {
    isLoadingPaths.value = false;
  }
};

const loadDefaults = async () => {
  try {
    const res = await encryptedAxios({
      method: 'GET',
      url: '/api/settings'
    });
    if (res.data && res.data.success) {
      const s = res.data.settings || res.data;
      if (s.apiToken) apiToken.value = s.apiToken;
      if (s.apiBaseUrl) apiBaseUrl.value = s.apiBaseUrl;
      if (s.storagePath) {
        storagePath.value = s.storagePath;
        originalStoragePath.value = s.storagePath;
      }
      canManageStorage.value = Boolean(s.canManageStorage);
      if (s.imageSubdirPattern) imageSubdirPattern.value = s.imageSubdirPattern;
    }
  } catch (err: any) {
    console.warn('[WelcomeModal] Failed to load settings:', err.message);
  }
  await fetchAuthorizedPaths();
};

const acceptAuthorization = async (result: FnosAppAuthResult) => {
  if (result.status === 'success') {
    await fetchAuthorizedPaths();
    if (result.path?.[0]) storagePath.value = result.path[0];
    actionFeedback.value = { success: true, message: '目录已授权并选定' };
  } else if (result.status === 'error') {
    actionFeedback.value = { success: false, message: result.error || '目录授权失败' };
  }
};

const handlePickOrAuthorize = async () => {
  if (isPickingDirectory.value || !canManageStorage.value) return;
  isPickingDirectory.value = true;
  actionFeedback.value = null;
  try {
    if (!isInsideFnOS()) {
      const res = await openAppAuthRoute();
      actionFeedback.value = { 
        success: res.success, 
        message: res.success ? '请在新窗口完成授权；返回后也可手动刷新列表' : res.error || '打开授权页面失败' 
      };
      return;
    }
    const res = await pickSharedDirectory();
    if (res.success && res.path) {
      await acceptAuthorization({ status: 'success', path: [res.path] });
    } else if (!res.canceled) {
      actionFeedback.value = { success: false, message: res.error || '调起目录选择器失败' };
    }
  } finally {
    isPickingDirectory.value = false;
  }
};

watch(() => props.modelValue, (val) => {
  if (val) {
    errorMessage.value = '';
    urlTestResult.value = null;
    actionFeedback.value = null;
    loadDefaults();
  }
});

onMounted(() => {
  removeAuthListener = onDirectoryAuthorization(async (result) => {
    await acceptAuthorization(result);
  });
  if (props.modelValue) {
    loadDefaults();
  }
});

onUnmounted(() => {
  removeAuthListener?.();
});

const handleTestUrl = async () => {
  if (!apiBaseUrl.value.trim()) {
    urlTestResult.value = { success: false, message: '请先输入接口地址' };
    return;
  }
  isTestingUrl.value = true;
  urlTestResult.value = null;
  try {
    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/settings/test-url',
      data: { url: apiBaseUrl.value.trim() }
    });
    if (res.data && res.data.success) {
      urlTestResult.value = { 
        success: true, 
        message: `连通正常 (延迟 ${res.data.latency || 0}ms)` 
      };
    } else {
      urlTestResult.value = { success: false, message: res.data.error || '连接失败' };
    }
  } catch (err: any) {
    urlTestResult.value = { 
      success: false, 
      message: `连接失败: ${err.response?.data?.error || err.message}` 
    };
  } finally {
    isTestingUrl.value = false;
  }
};

const handleSave = async () => {
  const tokenTrimmed = apiToken.value.trim();
  if (!tokenTrimmed) {
    errorMessage.value = '请输入 NovelAI API Token';
    return;
  }

  isSaving.value = true;
  errorMessage.value = '';

  try {
    const payload: Record<string, any> = {
      apiToken: tokenTrimmed,
      apiBaseUrl: apiBaseUrl.value.trim() || 'https://image.novelai.net',
      imageSubdirPattern: imageSubdirPattern.value.trim() || '/{year}/{month}/'
    };

    // 仅当用户具备管理员权限且显式修改了目录时才提交 storagePath，避免普通用户因未变动误触 403
    const newStorage = storagePath.value.trim();
    if (canManageStorage.value && newStorage && newStorage !== originalStoragePath.value.trim()) {
      payload.storagePath = newStorage;
    }

    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/settings',
      data: payload
    });

    if (res.data && res.data.success) {
      if (res.data.settings?.imageSubdirPattern) {
        imageSubdirPattern.value = res.data.settings.imageSubdirPattern;
      }
      authStore.token = tokenTrimmed;
      await authStore.fetchUserData(tokenTrimmed);
      emit('completed');
      emit('update:modelValue', false);
    } else {
      errorMessage.value = res.data.error || '保存配置失败';
    }
  } catch (err: any) {
    errorMessage.value = `保存失败: ${err.response?.data?.error || err.message}`;
  } finally {
    isSaving.value = false;
  }
};

const handleSkip = () => {
  emit('update:modelValue', false);
};
</script>

<template>
  <div v-if="modelValue" class="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in select-none">
    <div class="max-w-lg w-full bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-2xl flex flex-col overflow-hidden transition-all text-xs sm:text-sm">
      <!-- 头部欢迎区域 -->
      <div class="px-6 pt-6 pb-4 bg-gradient-to-br from-blue-50/70 via-indigo-50/40 to-transparent dark:from-blue-950/30 dark:via-indigo-950/20 dark:to-transparent border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-blue-500/20">
            <Sparkles class="w-5 h-5 text-amber-300" />
          </div>
          <div>
            <h2 class="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100">
              欢迎使用 NovelAI WebUI
            </h2>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              初次运行向导：请配置您的 API 密钥与存储目录以开始创作
            </p>
          </div>
        </div>
      </div>

      <!-- 表单区域 -->
      <div class="p-6 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
        <!-- 错误提示 -->
        <div v-if="errorMessage" class="p-3 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
          <AlertCircle class="w-4 h-4 shrink-0" />
          <span>{{ errorMessage }}</span>
        </div>

        <!-- 1. API Token -->
        <div class="space-y-1.5">
          <label class="block font-semibold text-gray-800 dark:text-gray-200 text-xs">
            NovelAI API Token <span class="text-red-500">*</span>
          </label>
          <div class="relative">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
              <KeyRound class="w-4 h-4" />
            </div>
            <input 
              :type="showToken ? 'text' : 'password'"
              v-model="apiToken"
              placeholder="pst-xxxxxxxxxxxxxxxx"
              class="w-full bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl pl-9 pr-10 py-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition font-mono"
            />
            <button 
              type="button" 
              @click="showToken = !showToken"
              class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition cursor-pointer"
              title="切换显示/隐藏"
            >
              <EyeOff v-if="showToken" class="w-4 h-4" />
              <Eye v-else class="w-4 h-4" />
            </button>
          </div>
          <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-tight">
            请输入您的 NovelAI 官方或反代 API 访问令牌（通常以 pst- 开头）。
          </p>
        </div>

        <!-- 2. API 接口地址 (反代地址) -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="block font-semibold text-gray-800 dark:text-gray-200 text-xs">
              API 接口地址（反代地址）
            </label>
            <button 
              type="button"
              @click="handleTestUrl"
              :disabled="isTestingUrl || !apiBaseUrl"
              class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 disabled:opacity-50 cursor-pointer"
            >
              <Loader2 v-if="isTestingUrl" class="w-3 h-3 animate-spin" />
              <Check v-else class="w-3 h-3" />
              <span>测试连通性</span>
            </button>
          </div>
          <div class="relative">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
              <Globe class="w-4 h-4" />
            </div>
            <input 
              type="text"
              v-model="apiBaseUrl"
              placeholder="https://image.novelai.net"
              class="w-full bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl pl-9 pr-3 py-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition font-mono"
            />
          </div>
          <div v-if="urlTestResult" class="text-[11px] font-medium" :class="urlTestResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-500'">
            {{ urlTestResult.message }}
          </div>
          <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-tight">
            官方默认接口为 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">https://image.novelai.net</code>。如有自建反向代理或加速通道，可在此填入代理地址。
          </p>
        </div>

        <!-- 3. 数据存储目录 -->
        <div class="space-y-2 p-3 sm:p-3.5 rounded-xl bg-gray-50/70 dark:bg-gray-800/40 border border-gray-200/80 dark:border-gray-700/60">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <label class="block font-semibold text-gray-800 dark:text-gray-200 text-xs">
                数据存储目录
              </label>
              <p class="text-[11px] text-gray-500 dark:text-gray-400">
                保存生图历史、角色库及存档数据库
              </p>
            </div>
            <div v-if="canManageStorage" class="flex items-center gap-1.5">
              <button 
                type="button" 
                @click="handlePickOrAuthorize" 
                :disabled="isPickingDirectory || isLoadingPaths"
                class="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs flex items-center gap-1 disabled:opacity-50 transition cursor-pointer"
              >
                <Loader2 v-if="isPickingDirectory" class="w-3 h-3 animate-spin" />
                <FolderPlus v-else class="w-3 h-3" />
                <span>{{ isPickingDirectory ? '等待授权...' : '添加授权' }}</span>
              </button>
              <button 
                type="button" 
                @click="fetchAuthorizedPaths" 
                :disabled="isLoadingPaths"
                class="px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 text-xs flex items-center gap-1 disabled:opacity-50 transition cursor-pointer"
                title="刷新已授权目录"
              >
                <RefreshCw class="w-3 h-3" :class="{ 'animate-spin': isLoadingPaths }" />
              </button>
            </div>
          </div>

          <p class="text-[11px] text-gray-500 dark:text-gray-400 break-all">
            当前预设：<code class="select-all font-mono">{{ originalStoragePath || '读取中...' }}</code>
          </p>

          <p v-if="!canManageStorage" class="text-[11px] text-amber-600 dark:text-amber-400">
            存储目录由飞牛系统管理员统一配置与授权。
          </p>
          <p v-if="authorizationWarning" role="status" class="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
            {{ authorizationWarning }}
          </p>
          <p v-if="actionFeedback" class="text-[11px] flex items-center gap-1" :class="actionFeedback.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
            <Check v-if="actionFeedback.success" class="w-3 h-3" />
            <AlertCircle v-else class="w-3 h-3" />
            <span>{{ actionFeedback.message }}</span>
          </p>

          <div v-if="canManageStorage" class="space-y-2">
            <CustomSelect 
              v-model="storagePath" 
              :options="storagePathOptions" 
              placeholder="选择存储目录"
            />
            <details class="text-[11px] text-gray-500 dark:text-gray-400">
              <summary class="cursor-pointer select-none py-0.5 hover:text-gray-700 dark:hover:text-gray-300">高级选项：手动指定已授权目录或子目录</summary>
              <div class="pt-1.5 space-y-1">
                <input 
                  v-model="storagePath" 
                  type="text" 
                  placeholder="输入绝对目录路径"
                  class="w-full px-2.5 py-1.5 font-mono text-xs rounded-lg bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100" 
                />
              </div>
            </details>
          </div>
        </div>

        <!-- 4. 图片保存子目录规则 -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="block font-semibold text-gray-800 dark:text-gray-200 text-xs">
              图片保存子目录规则
            </label>
            <button 
              type="button" 
              @click="imageSubdirPattern = '/{year}/{month}/'"
              class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            >
              默认 (/{year}/{month}/)
            </button>
          </div>
          <div class="relative">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
              <FolderTree class="w-4 h-4" />
            </div>
            <input 
              type="text"
              v-model="imageSubdirPattern"
              @input="handlePatternInput"
              @blur="handlePatternBlur"
              placeholder="/{year}/{month}/"
              class="w-full bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl pl-9 pr-3 py-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition font-mono"
            />
          </div>

          <!-- 变量快捷标签 -->
          <div class="space-y-1 pt-0.5">
            <div class="text-[10px] text-gray-400">点击标签快捷添加常用变量：</div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="v in AVAILABLE_VARIABLES"
                :key="v.name"
                type="button"
                @click="insertVariable(v.name)"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950 dark:hover:text-blue-300 text-gray-600 dark:text-gray-300 text-[11px] font-mono transition border border-gray-200 dark:border-gray-700 cursor-pointer"
                :title="v.desc"
              >
                <span>{{ v.name }}</span>
                <span class="text-[9px] text-gray-400 font-sans">({{ v.desc }})</span>
              </button>
            </div>
          </div>

          <!-- 实时保存路径预览 -->
          <div class="p-2.5 bg-gray-50/90 dark:bg-gray-950/60 rounded-xl border border-gray-200 dark:border-gray-800 space-y-0.5">
            <div class="text-[11px] font-medium text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
              <span>保存路径预览：</span>
            </div>
            <div class="font-mono text-[11px] text-blue-600 dark:text-blue-400 break-all select-all">
              {{ previewPath }}
            </div>
          </div>

          <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-tight">
            图片将自动分目录归档存放。反斜杠 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">\</code> 会自动转为正斜杠。
          </p>
        </div>
      </div>

      <!-- 底部操作按钮 -->
      <div class="p-4 bg-gray-50 dark:bg-gray-950/60 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between gap-3">
        <button 
          type="button"
          @click="handleSkip"
          class="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-3 py-2 rounded-lg hover:bg-gray-200/60 dark:hover:bg-gray-800 transition cursor-pointer"
        >
          暂不配置，先逛逛
        </button>
        <button 
          type="button"
          @click="handleSave"
          :disabled="isSaving"
          class="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl font-medium transition flex items-center gap-2 shadow-lg shadow-blue-600/20 text-xs sm:text-sm cursor-pointer"
        >
          <Loader2 v-if="isSaving" class="w-4 h-4 animate-spin" />
          <span v-else>完成配置并开始使用</span>
          <ArrowRight v-if="!isSaving" class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>
