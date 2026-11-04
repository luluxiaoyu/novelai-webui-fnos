<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { encryptedAxios } from '../utils/api';
import { 
  Sparkles, KeyRound, Globe, Folder, Eye, EyeOff, 
  Check, Loader2, AlertCircle, ArrowRight, FolderTree
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
const storagePath = ref('./data');
const imageSubdirPattern = ref('/{year}/{month}/');

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

  const cleanBase = (storagePath.value || './data').replace(/\/+$/, '');
  return `${cleanBase}/profiles/${profile}/${resolved}/image_example.png`.replace(/\/+/g, '/');
});

const isTestingUrl = ref(false);
const urlTestResult = ref<{ success: boolean; message: string } | null>(null);

const isSaving = ref(false);
const errorMessage = ref('');

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
      if (s.storagePath) storagePath.value = s.storagePath;
      if (s.imageSubdirPattern) imageSubdirPattern.value = s.imageSubdirPattern;
    }
  } catch (err: any) {
    console.warn('[WelcomeModal] Failed to load settings:', err.message);
  }
};

watch(() => props.modelValue, (val) => {
  if (val) {
    errorMessage.value = '';
    urlTestResult.value = null;
    loadDefaults();
  }
});

onMounted(() => {
  if (props.modelValue) {
    loadDefaults();
  }
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
    const payload = {
      apiToken: tokenTrimmed,
      apiBaseUrl: apiBaseUrl.value.trim() || 'https://image.novelai.net',
      storagePath: storagePath.value.trim() || './data',
      imageSubdirPattern: imageSubdirPattern.value.trim() || '/{year}/{month}/'
    };

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
              class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition"
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
              class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 disabled:opacity-50"
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
        <div class="space-y-1.5">
          <label class="block font-semibold text-gray-800 dark:text-gray-200 text-xs">
            数据与图片存储目录
          </label>
          <div class="relative">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
              <Folder class="w-4 h-4" />
            </div>
            <input 
              type="text"
              v-model="storagePath"
              placeholder="./data"
              class="w-full bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl pl-9 pr-3 py-2.5 text-xs sm:text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition font-mono"
            />
          </div>
          <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-tight">
            画作原图、生成记录与预设将持久化保存在此目录，系统已自动预设飞牛 OS 共享路径。
          </p>
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
              class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
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
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950 dark:hover:text-blue-300 text-gray-600 dark:text-gray-300 text-[11px] font-mono transition border border-gray-200 dark:border-gray-700"
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
          class="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-3 py-2 rounded-lg hover:bg-gray-200/60 dark:hover:bg-gray-800 transition"
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
