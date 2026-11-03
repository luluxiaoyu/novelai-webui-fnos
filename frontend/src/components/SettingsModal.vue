<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useProfileStore } from '../stores/profile';
import { encryptedAxios, setEncryptionConfig } from '../utils/api';
import { 
  X, Check, AlertCircle, Loader2, Save, Globe, 
  ShieldCheck, Cpu, FileText, Sun, Moon, 
  Trash2, Edit3, Plus, Eye, EyeOff
} from 'lucide-vue-next';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const authStore = useAuthStore();
const profileStore = useProfileStore();

const activeTab = ref<'general' | 'profiles' | 'security' | 'performance'>('general');

// Form state
const apiToken = ref('');
const showToken = ref(false);
const apiBaseUrl = ref('https://image.novelai.net');
const storagePath = ref('./data');
const enableEncryption = ref(false);
const encryptionKey = ref('nahida1027');
const maxConcurrency = ref(1);
const enableLogging = ref(true);

const isTestingToken = ref(false);
const tokenTestResult = ref<{ success: boolean; message: string } | null>(null);

const isTestingUrl = ref(false);
const urlTestResult = ref<{ success: boolean; message: string } | null>(null);

const isSaving = ref(false);
const saveMessage = ref<{ success: boolean; message: string } | null>(null);

// New profile input
const newProfileName = ref('');

// Load settings from backend
const loadSettings = async () => {
  try {
    const res = await encryptedAxios({
      method: 'GET',
      url: '/api/settings'
    });
    if (res.data && res.data.success) {
      const s = res.data.settings || res.data;
      apiToken.value = s.apiToken || authStore.token || '';
      apiBaseUrl.value = s.apiBaseUrl || 'https://image.novelai.net';
      storagePath.value = s.storagePath || './data';
      enableEncryption.value = !!s.enableEncryption;
      encryptionKey.value = s.encryptionKey || 'nahida1027';
      maxConcurrency.value = Number(s.maxConcurrency) || 1;
      enableLogging.value = s.enableLogging !== false;
    }
  } catch (err: any) {
    console.warn('[SettingsModal] Failed to load settings:', err.message);
  }
};

watch(() => props.modelValue, (val) => {
  if (val) {
    tokenTestResult.value = null;
    urlTestResult.value = null;
    saveMessage.value = null;
    loadSettings();
    profileStore.fetchProfiles();
  }
});

onMounted(() => {
  loadSettings();
});

// Test NovelAI Token
const handleTestToken = async () => {
  if (!apiToken.value || !apiToken.value.trim()) {
    tokenTestResult.value = { success: false, message: '请先填写 API Token' };
    return;
  }
  isTestingToken.value = true;
  tokenTestResult.value = null;
  try {
    const trimmed = apiToken.value.trim();
    const res = await encryptedAxios({
      method: 'GET',
      url: '/api/user/subscription',
      headers: {
        'Authorization': `Bearer ${trimmed}`
      }
    });
    if (res.data && (res.data.tier !== undefined || res.data.active !== undefined)) {
      const tierMap: Record<number, string> = { 1: 'Tablet', 2: 'Scroll', 3: 'Opus' };
      const tierStr = tierMap[res.data.tier] || `Tier ${res.data.tier}`;
      tokenTestResult.value = { 
        success: true, 
        message: `Token 有效！当前订阅：${tierStr} (${res.data.active ? '有效' : '已过期'})` 
      };
      authStore.token = trimmed;
      await authStore.fetchUserData(trimmed);
    } else {
      tokenTestResult.value = { success: true, message: 'Token 响应正常' };
    }
  } catch (err: any) {
    tokenTestResult.value = { 
      success: false, 
      message: `Token 验证失败: ${err.response?.data?.message || err.message}` 
    };
  } finally {
    isTestingToken.value = false;
  }
};

// Test API Base URL
const handleTestUrl = async () => {
  if (!apiBaseUrl.value || !apiBaseUrl.value.trim()) {
    urlTestResult.value = { success: false, message: '请填写反代地址' };
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
      urlTestResult.value = { success: true, message: `连通正常 (${res.data.latency || 0}ms)` };
    } else {
      urlTestResult.value = { success: false, message: res.data.error || '连通失败' };
    }
  } catch (err: any) {
    urlTestResult.value = { 
      success: false, 
      message: `测试失败: ${err.response?.data?.error || err.message}` 
    };
  } finally {
    isTestingUrl.value = false;
  }
};

// Save All Settings
const handleSaveSettings = async () => {
  isSaving.value = true;
  saveMessage.value = null;
  try {
    const payload = {
      apiToken: apiToken.value.trim(),
      apiBaseUrl: apiBaseUrl.value.trim(),
      storagePath: storagePath.value.trim(),
      enableEncryption: enableEncryption.value,
      encryptionKey: encryptionKey.value.trim(),
      maxConcurrency: Number(maxConcurrency.value) || 1,
      enableLogging: enableLogging.value
    };

    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/settings',
      data: payload
    });

    if (res.data && res.data.success) {
      saveMessage.value = { success: true, message: '设置已成功保存并立即生效！' };
      setEncryptionConfig(payload.enableEncryption, payload.encryptionKey);
      if (payload.apiToken) {
        authStore.token = payload.apiToken;
      }
      setTimeout(() => {
        saveMessage.value = null;
      }, 3000);
    } else {
      saveMessage.value = { success: false, message: res.data.error || '保存失败' };
    }
  } catch (err: any) {
    saveMessage.value = { 
      success: false, 
      message: `保存失败: ${err.response?.data?.error || err.message}` 
    };
  } finally {
    isSaving.value = false;
  }
};

// Profile Actions
const handleCreateProfile = async () => {
  const name = newProfileName.value.trim();
  if (!name) return;
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(name)) {
    alert('存档名称仅支持中文、英文、数字、下划线及短横线');
    return;
  }
  const ok = await profileStore.createProfile(name);
  if (ok) {
    newProfileName.value = '';
  }
};

const handleRenameProfile = async (oldName: string) => {
  const newName = prompt(`请输入存档 "${oldName}" 的新名称:`, oldName);
  if (newName && newName.trim() && newName.trim() !== oldName) {
    await profileStore.renameProfile(oldName, newName.trim());
  }
};

const handleDeleteProfile = async (name: string) => {
  if (confirm(`确定要彻底删除存档 "${name}" 吗？该存档在 NAS 磁盘上的所有独立词库、预设和生图历史将被永久清除！此操作不可恢复！`)) {
    await profileStore.deleteProfile(name);
  }
};
</script>

<template>
  <div v-if="modelValue" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
      
      <!-- Modal Header -->
      <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50/80 dark:bg-gray-950/60">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <Globe class="w-4 h-4" />
          </div>
          <div>
            <h3 class="font-bold text-gray-900 dark:text-white text-base">NovelAI WebUI 设置</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400">飞牛 fnOS 本地运行服务配置</p>
          </div>
        </div>
        <button 
          @click="emit('update:modelValue', false)"
          class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Navigation Tabs -->
      <div class="flex border-b border-gray-200 dark:border-gray-800 px-6 gap-6 bg-gray-50/40 dark:bg-gray-950/40 text-sm">
        <button 
          @click="activeTab = 'general'"
          class="py-3 font-medium transition relative"
          :class="activeTab === 'general' ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'"
        >
          常规与服务
        </button>
        <button 
          @click="activeTab = 'profiles'"
          class="py-3 font-medium transition relative"
          :class="activeTab === 'profiles' ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'"
        >
          多存档管理
        </button>
        <button 
          @click="activeTab = 'security'"
          class="py-3 font-medium transition relative"
          :class="activeTab === 'security' ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'"
        >
          安全与防嗅探
        </button>
        <button 
          @click="activeTab = 'performance'"
          class="py-3 font-medium transition relative"
          :class="activeTab === 'performance' ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'"
        >
          并发与日志
        </button>
      </div>

      <!-- Tab Content Area -->
      <div class="p-6 overflow-y-auto space-y-6 flex-1 text-sm">
        
        <!-- Tab 1: 常规与服务 -->
        <div v-if="activeTab === 'general'" class="space-y-5 animate-fade-in">
          <!-- API Token -->
          <div class="space-y-2">
            <label class="block font-medium text-gray-700 dark:text-gray-300">
              NovelAI API Token
              <span class="text-xs font-normal text-gray-400 ml-1">(保存在 NAS 后端，任意设备打开免重复输入)</span>
            </label>
            <div class="flex gap-2">
              <div class="relative flex-1">
                <input 
                  :type="showToken ? 'text' : 'password'"
                  v-model="apiToken"
                  placeholder="pst-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  class="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl pr-10 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                />
                <button 
                  type="button"
                  @click="showToken = !showToken"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  <EyeOff v-if="showToken" class="w-4 h-4" />
                  <Eye v-else class="w-4 h-4" />
                </button>
              </div>
              <button 
                type="button"
                @click="handleTestToken"
                :disabled="isTestingToken"
                class="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded-xl font-medium transition flex items-center gap-1.5 shrink-0"
              >
                <Loader2 v-if="isTestingToken" class="w-4 h-4 animate-spin" />
                <span v-else>连通测试</span>
              </button>
            </div>
            <p v-if="tokenTestResult" class="text-xs flex items-center gap-1.5" :class="tokenTestResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
              <Check v-if="tokenTestResult.success" class="w-3.5 h-3.5" />
              <AlertCircle v-else class="w-3.5 h-3.5" />
              <span>{{ tokenTestResult.message }}</span>
            </p>
          </div>

          <!-- API 反代基准地址 -->
          <div class="space-y-2">
            <label class="block font-medium text-gray-700 dark:text-gray-300">
              API 反代基准地址
              <span class="text-xs font-normal text-gray-400 ml-1">(默认官方单一基准域名: https://image.novelai.net)</span>
            </label>
            <div class="flex gap-2">
              <input 
                type="text"
                v-model="apiBaseUrl"
                placeholder="https://image.novelai.net"
                class="flex-1 px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              />
              <button 
                type="button"
                @click="handleTestUrl"
                :disabled="isTestingUrl"
                class="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded-xl font-medium transition flex items-center gap-1.5 shrink-0"
              >
                <Loader2 v-if="isTestingUrl" class="w-4 h-4 animate-spin" />
                <span v-else>测速测试</span>
              </button>
            </div>
            <p v-if="urlTestResult" class="text-xs flex items-center gap-1.5" :class="urlTestResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
              <Check v-if="urlTestResult.success" class="w-3.5 h-3.5" />
              <AlertCircle v-else class="w-3.5 h-3.5" />
              <span>{{ urlTestResult.message }}</span>
            </p>
            <p class="text-xs text-gray-400">
              官方生成、流式中间帧、超分、标签补全及点数订阅查询全功能均经由此反代基准地址直连。支持填写自建反代或 Cloudflare Worker 地址。
            </p>
          </div>

          <!-- NAS 本地存储路径 -->
          <div class="space-y-2">
            <label class="block font-medium text-gray-700 dark:text-gray-300">
              NAS 本地存储目录
            </label>
            <input 
              type="text"
              v-model="storagePath"
              placeholder="./data"
              class="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
            />
            <p class="text-xs text-gray-400">
              所有存档的数据索引文件及高清生图 PNG 均物理保存在此路径下的 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">profiles/</code> 子目录中。
            </p>
          </div>

          <!-- 主题模式说明 -->
          <div class="p-3.5 bg-gray-50/80 dark:bg-gray-950/40 rounded-xl border border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <Sun class="w-5 h-5 text-amber-500 dark:hidden" />
              <Moon class="w-5 h-5 text-blue-400 hidden dark:block" />
              <div>
                <div class="font-medium text-gray-800 dark:text-gray-200 text-xs">界面外观风格</div>
                <div class="text-[11px] text-gray-400">默认自动跟随浏览器/操作系统（亮白 / 暗黑模式），可通过顶部导航栏太阳/月亮按钮随时快速切换。</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 2: 多存档管理 -->
        <div v-if="activeTab === 'profiles'" class="space-y-5 animate-fade-in">
          <div class="p-3.5 bg-blue-50/60 dark:bg-blue-950/30 rounded-xl border border-blue-200 dark:border-blue-900/40 text-xs text-blue-800 dark:text-blue-300">
            多存档功能在 NAS 磁盘上按物理文件夹完全隔离。各存档专属的 Tag 词库、常用分组、自定义角色、画风预设及历史图片 100% 独立，互不混杂串扰。
          </div>

          <!-- 新建存档 -->
          <div class="space-y-2">
            <label class="block font-medium text-gray-700 dark:text-gray-300">新建独立存档</label>
            <div class="flex gap-2">
              <input 
                type="text"
                v-model="newProfileName"
                placeholder="输入新存档名称 (如 Anime_V5, Realistic, Project_A)"
                class="flex-1 px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              />
              <button 
                type="button"
                @click="handleCreateProfile"
                :disabled="!newProfileName.trim() || profileStore.isLoading"
                class="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl font-medium transition flex items-center gap-1.5 shrink-0 shadow-sm"
              >
                <Plus class="w-4 h-4" />
                <span>新建</span>
              </button>
            </div>
          </div>

          <!-- 存档列表 -->
          <div class="space-y-2">
            <label class="block font-medium text-gray-700 dark:text-gray-300">现有存档列表</label>
            <div class="divide-y divide-gray-200 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950/40">
              <div 
                v-for="p in profileStore.profiles" 
                :key="p"
                class="px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
              >
                <div class="flex items-center gap-2.5">
                  <div 
                    class="w-2.5 h-2.5 rounded-full"
                    :class="profileStore.currentProfile === p ? 'bg-emerald-500 ring-4 ring-emerald-500/20' : 'bg-gray-300 dark:bg-gray-600'"
                  ></div>
                  <span class="font-medium text-gray-800 dark:text-gray-200 text-sm">{{ p }}</span>
                  <span v-if="profileStore.currentProfile === p" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 font-semibold">
                    当前使用中
                  </span>
                  <span v-if="p === 'Default'" class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    默认底包
                  </span>
                </div>
                <div class="flex items-center gap-1.5">
                  <button 
                    v-if="profileStore.currentProfile !== p"
                    @click="profileStore.switchProfile(p)"
                    class="px-2.5 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded-lg transition"
                  >
                    切换至此
                  </button>
                  <button 
                    v-if="p !== 'Default'"
                    @click="handleRenameProfile(p)"
                    class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                    title="重命名存档"
                  >
                    <Edit3 class="w-4 h-4" />
                  </button>
                  <button 
                    v-if="p !== 'Default'"
                    @click="handleDeleteProfile(p)"
                    class="p-1.5 text-rose-400 hover:text-rose-600 dark:hover:text-rose-300 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/50 transition"
                    title="彻底删除存档"
                  >
                    <Trash2 class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 3: 安全与防嗅探 -->
        <div v-if="activeTab === 'security'" class="space-y-5 animate-fade-in">
          <div class="flex items-start justify-between p-4 bg-gray-50/80 dark:bg-gray-950/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1 pr-4">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <ShieldCheck class="w-4 h-4 text-emerald-500" />
                <span>防嗅探双向数据传输加密</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                启用后，前端与 NAS 后端之间的所有通信（生图参数、正负提示词、SSE 流式中间帧及响应数据）均采用全双工二进制 XOR 动态混淆加密，有效阻断内网中间人 Wireshark / Fiddler 抓包明文嗅探。
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
              <input type="checkbox" v-model="enableEncryption" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          <div v-if="enableEncryption" class="space-y-2 animate-fade-in">
            <label class="block font-medium text-gray-700 dark:text-gray-300">
              加密通信共享密钥 (Encryption Key)
            </label>
            <input 
              type="text"
              v-model="encryptionKey"
              placeholder="nahida1027"
              class="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm transition-colors"
            />
            <p class="text-xs text-gray-400">
              用于端到端流式混淆的双向对称密码，默认为 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">nahida1027</code>。
            </p>
          </div>
        </div>

        <!-- Tab 4: 并发与日志 -->
        <div v-if="activeTab === 'performance'" class="space-y-5 animate-fade-in">
          <!-- 并发排队 -->
          <div class="space-y-3 p-4 bg-gray-50/80 dark:bg-gray-950/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <Cpu class="w-4 h-4 text-blue-500" />
                <span>任务并发排队机制 (Concurrency Queue)</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                当家庭或局域网中有多人/多标签页同时提交生图时，自动进入 FIFO 先进先出队列，并在画布与按钮实时显示「排队中 (前方 X 人)...」，保护 NovelAI 官方账号不被并发风控。
              </p>
            </div>
            <div class="pt-2 flex items-center justify-between border-t border-gray-200/50 dark:border-gray-700/50">
              <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">最大并行生图数:</span>
              <div class="flex items-center gap-3">
                <input 
                  type="range" 
                  min="1" 
                  max="4" 
                  v-model.number="maxConcurrency"
                  class="w-32 accent-blue-600"
                />
                <span class="text-sm font-bold text-blue-600 dark:text-blue-400 w-8 text-right">{{ maxConcurrency }}</span>
              </div>
            </div>
          </div>

          <!-- 生图参数日志记录 -->
          <div class="flex items-start justify-between p-4 bg-gray-50/80 dark:bg-gray-950/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1 pr-4">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <FileText class="w-4 h-4 text-amber-500" />
                <span>生图参数日志记录 (Generation Logging)</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                每次生成完成后，在 NAS <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">logs/generation/YYYY-MM/</code> 中安全记录请求时间戳、客户端 IP、模型名称、分辨率、采样器及正反提示词。会自动剥离清洗巨型 Base64，绝不冗余占用存储。
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
              <input type="checkbox" v-model="enableLogging" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

      </div>

      <!-- Modal Footer -->
      <div class="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50/80 dark:bg-gray-950/60">
        <div>
          <span v-if="saveMessage" class="text-xs font-medium flex items-center gap-1.5" :class="saveMessage.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
            <Check v-if="saveMessage.success" class="w-3.5 h-3.5" />
            <AlertCircle v-else class="w-3.5 h-3.5" />
            <span>{{ saveMessage.message }}</span>
          </span>
        </div>
        <div class="flex items-center gap-2.5">
          <button 
            type="button"
            @click="emit('update:modelValue', false)"
            class="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition"
          >
            关闭
          </button>
          <button 
            type="button"
            @click="handleSaveSettings"
            :disabled="isSaving"
            class="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-xl transition flex items-center gap-2 shadow-sm"
          >
            <Loader2 v-if="isSaving" class="w-4 h-4 animate-spin" />
            <Save v-else class="w-4 h-4" />
            <span>保存配置</span>
          </button>
        </div>
      </div>

    </div>
  </div>
</template>
