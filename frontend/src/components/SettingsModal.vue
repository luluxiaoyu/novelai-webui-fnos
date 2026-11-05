<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useProfileStore } from '../stores/profile';
import { useGenerationStore } from '../stores/generation';
import { encryptedAxios, setEncryptionConfig } from '../utils/api';
import { getReduceMobileEffectsSetting, setReduceMobileEffectsSetting } from '../utils/mobilePerf';
import { isInsideFnOS, isFnosHostBridgeSupported, pickSharedDirectory, openFnOSAppSetting, openAppAuthRoute, checkAppAuthCallback } from '../utils/fnosBridge';
import CustomSelect from './CustomSelect.vue';
import { 
  X, Check, AlertCircle, Loader2, Save, Globe, 
  ShieldCheck, Cpu, FileText, Sun, Moon, 
  Trash2, Edit3, Plus, Eye, EyeOff, Smartphone, FolderTree,
  SlidersHorizontal, FolderArchive, RefreshCw, FolderPlus, ExternalLink,
  GitMerge, ArrowRightLeft, CheckCircle2, Copy, HelpCircle
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
const imageSubdirPattern = ref('/{year}/{month}/');
const enableEncryption = ref(false);
const encryptionKey = ref('nahida1027');
const maxConcurrency = ref(1);
const enableLogging = ref(true);
const reduceMobileEffects = ref(getReduceMobileEffectsSetting());

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
  const profile = profileStore.currentProfile || 'Default';

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

watch(reduceMobileEffects, (val) => {
  setReduceMobileEffectsSetting(val);
});

const isTestingToken = ref(false);
const tokenTestResult = ref<{ success: boolean; message: string } | null>(null);

const isTestingUrl = ref(false);
const urlTestResult = ref<{ success: boolean; message: string } | null>(null);

const isSaving = ref(false);
const saveMessage = ref<{ success: boolean; message: string } | null>(null);

// New profile input
const newProfileName = ref('');

// Storage directory management state
interface AuthorizedPathItem {
  path: string;
  mountPath?: string | null;
  name: string;
  type: 'app_share' | 'share' | 'appdata' | 'custom';
  exists: boolean;
  writable: boolean;
  reason?: string | null;
  isCurrent?: boolean;
}

const authorizedPaths = ref<AuthorizedPathItem[]>([]);
const isLoadingPaths = ref(false);
const isManualMode = ref(false);
const manualPathInput = ref('');
const isValidatingPath = ref(false);
const pathValidationResult = ref<{ success: boolean; message?: string; error?: string } | null>(null);
const isSwitchingPath = ref(false);
const isPickingDirectory = ref(false);
const isOpeningAppSetting = ref(false);
const isOpeningAuthRoute = ref(false);
const appSettingActionFeedback = ref<{ success: boolean; message: string } | null>(null);
const showAuthGuideModal = ref(false);
const authGuideReason = ref<string | null>(null);
const originalStoragePath = ref('');
const isBridgeSupported = ref<boolean | null>(null);
const hasCopiedGuide = ref(false);
const authGuideText = '飞牛系统权限机制：如需使用其他共享文件夹，请在飞牛系统【应用中心】->【已安装】->【NovelAI WebUI】->【设置】->【访问权限】中添加并设为读写。添加后点击【刷新】即可在下拉列表中选择。';

const handleCopyAuthGuide = async () => {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(authGuideText);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = authGuideText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    hasCopiedGuide.value = true;
    setTimeout(() => {
      hasCopiedGuide.value = false;
    }, 2000);
  } catch (err) {
    console.warn('[SettingsModal] Failed to copy auth guide:', err);
  }
};

const checkBridgeSupport = async () => {
  isBridgeSupported.value = await isFnosHostBridgeSupported(300);
};

// Incremental merge state
const showMergeConfirmModal = ref(false);
const pendingSwitchPath = ref('');
const isMerging = ref(false);
const mergeProgress = ref<{
  jobId: string | null;
  status: 'idle' | 'scanning' | 'merging' | 'completed' | 'failed';
  progress: number;
  current: number;
  total: number;
  detail: string;
  error?: string | null;
  stats?: { filesCopied: number; recordsMerged: number } | null;
} | null>(null);
let mergePollTimer: any = null;

onUnmounted(() => {
  if (mergePollTimer) {
    clearTimeout(mergePollTimer);
    mergePollTimer = null;
  }
});

const currentPathInfo = computed(() => {
  const current = storagePath.value?.trim();
  if (!current) return null;
  return authorizedPaths.value.find(p => p.path === current || p.mountPath === current) || null;
});

const isKnownPath = computed(() => {
  return !!currentPathInfo.value;
});

const storagePathOptions = computed(() => {
  const hasAppShare = authorizedPaths.value.some(p => p.type === 'app_share' && p.writable);
  let filtered = authorizedPaths.value.filter(p => {
    // When App Shared Directory is available and writable, hide internal private directory (@appdata) completely
    if (hasAppShare && (p.type === 'appdata' || p.path.includes('/var/data') || p.path.includes('@appdata'))) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    filtered = authorizedPaths.value;
  }

  const list: Array<{
    value: string;
    label: string;
    sublabel?: string;
    badge?: string;
    badgeType?: 'success' | 'warning' | 'error' | 'default';
    icon?: any;
  }> = filtered.map(item => ({
    value: item.path,
    label: item.name,
    sublabel: item.path,
    badge: item.writable ? '读写正常' : (!item.exists ? '目录不存在' : '无写入权限'),
    badgeType: item.writable ? 'success' : 'error',
    icon: item.type === 'app_share' ? FolderArchive : (item.type === 'share' ? FolderTree : FolderPlus)
  }));

  // If currently active path is not in authorized list, display it as a custom path option (unless it is hidden appdata)
  if (!isKnownPath.value && storagePath.value) {
    if (!hasAppShare || (!storagePath.value.includes('/var/data') && !storagePath.value.includes('@appdata'))) {
      list.unshift({
        value: storagePath.value,
        label: `当前配置目录: ${storagePath.value}`,
        sublabel: storagePath.value,
        badge: '自定义',
        badgeType: 'warning' as const,
        icon: FolderTree
      });
    }
  }

  return list;
});

const isStoragePathChanged = computed(() => {
  if (!originalStoragePath.value || !storagePath.value) return false;
  const current = storagePath.value.trim();
  const orig = originalStoragePath.value.trim();
  if (current === orig) return false;

  const curInfo = authorizedPaths.value.find(p => p.path === current || p.mountPath === current);
  const origInfo = authorizedPaths.value.find(p => p.path === orig || p.mountPath === orig);
  if (curInfo && origInfo && curInfo.path === origInfo.path) {
    return false;
  }
  return true;
});

const fetchAuthorizedPaths = async () => {
  isLoadingPaths.value = true;
  try {
    const res = await encryptedAxios({
      method: 'GET',
      url: '/api/storage/authorized-paths'
    });
    if (res.data && res.data.success) {
      authorizedPaths.value = res.data.paths || [];
      const backendCurrent = res.data.currentPath;
      // If current storagePath is empty, initialize from backend currentPath
      if (!storagePath.value && backendCurrent) {
        storagePath.value = backendCurrent;
        originalStoragePath.value = backendCurrent;
        manualPathInput.value = backendCurrent;
      } else if (storagePath.value) {
        // If current storagePath matches a known path's mountPath or realpath, align to canonical path
        const matched = authorizedPaths.value.find(p => 
          p.path === storagePath.value || 
          p.mountPath === storagePath.value ||
          (p.isCurrent && backendCurrent === p.path)
        );
        if (matched) {
          storagePath.value = matched.path;
          if (originalStoragePath.value === matched.mountPath || originalStoragePath.value === storagePath.value || !originalStoragePath.value) {
            originalStoragePath.value = matched.path;
          }
          manualPathInput.value = matched.path;
        }
      }
    }
  } catch (err: any) {
    console.warn('[SettingsModal] Failed to fetch authorized paths:', err.message);
  } finally {
    isLoadingPaths.value = false;
  }
};

const promptDirectorySwitch = (targetPath: string) => {
  if (!targetPath || !targetPath.trim()) return;
  const cleanTarget = targetPath.trim();
  const current = originalStoragePath.value?.trim();

  // If target equals current canonical path, no need to prompt
  const curInfo = authorizedPaths.value.find(p => p.path === current || p.mountPath === current);
  const targetInfo = authorizedPaths.value.find(p => p.path === cleanTarget || p.mountPath === cleanTarget);
  if (curInfo && targetInfo && curInfo.path === targetInfo.path) {
    storagePath.value = cleanTarget;
    manualPathInput.value = cleanTarget;
    return;
  }
  if (cleanTarget === current) {
    storagePath.value = cleanTarget;
    manualPathInput.value = cleanTarget;
    return;
  }

  pendingSwitchPath.value = cleanTarget;
  storagePath.value = cleanTarget;
  manualPathInput.value = cleanTarget;
  showMergeConfirmModal.value = true;
};

const cancelDirectorySwitch = () => {
  storagePath.value = originalStoragePath.value;
  manualPathInput.value = originalStoragePath.value;
  pendingSwitchPath.value = '';
  showMergeConfirmModal.value = false;
};

const handleSelectPath = (val: string | number) => {
  const targetVal = String(val);
  if (!targetVal) return;
  pathValidationResult.value = null;
  if (originalStoragePath.value && targetVal !== originalStoragePath.value) {
    promptDirectorySwitch(targetVal);
  } else {
    storagePath.value = targetVal;
    manualPathInput.value = targetVal;
  }
};

const handleOpenAppSetting = async () => {
  isOpeningAppSetting.value = true;
  appSettingActionFeedback.value = null;
  try {
    const res = await openFnOSAppSetting();
    if (res.success) {
      appSettingActionFeedback.value = {
        success: true,
        message: '已成功向飞牛系统发起打开设置请求，请查看飞牛桌面'
      };
      setTimeout(() => {
        appSettingActionFeedback.value = null;
      }, 5000);
    } else {
      authGuideReason.value = res.error || '调起系统设置未响应，请在飞牛系统应用中心手动配置';
      appSettingActionFeedback.value = {
        success: false,
        message: res.error || '调起系统设置未响应，请按指引在飞牛桌面【应用中心】手动打开'
      };
      showAuthGuideModal.value = true;
    }
  } finally {
    isOpeningAppSetting.value = false;
  }
};

const handleOpenAppAuthRoute = async () => {
  isOpeningAuthRoute.value = true;
  try {
    const res = await openAppAuthRoute('pickSharedFile');
    if (res.success) {
      authGuideReason.value = '已在浏览器新窗口中打开系统授权页面，完成授权后请返回此处点击【刷新目录列表】';
    } else {
      authGuideReason.value = res.error || '调起系统授权页面失败，请通过下方指引在应用中心手动配置';
    }
  } finally {
    isOpeningAuthRoute.value = false;
  }
};

const handleTestManualPath = async () => {
  const target = manualPathInput.value.trim();
  if (!target) return;
  isValidatingPath.value = true;
  pathValidationResult.value = null;
  try {
    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/storage/validate-path',
      data: { path: target, createIfMissing: true }
    });
    if (res.data && res.data.success) {
      pathValidationResult.value = { success: true, message: '路径有效，读写权限正常 (W_OK 通过)' };
      await fetchAuthorizedPaths();
    } else {
      pathValidationResult.value = { success: false, error: res.data?.error || '无读写权限' };
    }
  } catch (err: any) {
    pathValidationResult.value = { success: false, error: err.response?.data?.error || err.message };
  } finally {
    isValidatingPath.value = false;
  }
};

const handleApplyManualPath = async () => {
  const target = manualPathInput.value.trim();
  if (!target) return;
  isValidatingPath.value = true;
  pathValidationResult.value = null;
  try {
    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/storage/validate-path',
      data: { path: target, createIfMissing: true }
    });
    if (res.data && res.data.success) {
      pathValidationResult.value = { success: true, message: '路径有效，读写权限正常 (W_OK 通过)' };
      await fetchAuthorizedPaths();
      if (originalStoragePath.value && target !== originalStoragePath.value) {
        promptDirectorySwitch(target);
      } else {
        storagePath.value = target;
      }
    } else {
      pathValidationResult.value = { success: false, error: res.data?.error || '无读写权限' };
    }
  } catch (err: any) {
    pathValidationResult.value = { success: false, error: err.response?.data?.error || err.message };
  } finally {
    isValidatingPath.value = false;
  }
};

const executeSwitchPath = async (targetPath: string): Promise<boolean> => {
  if (!targetPath || !targetPath.trim()) return false;
  isSwitchingPath.value = true;
  try {
    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/storage/switch',
      data: { path: targetPath.trim() }
    });
    if (res.data && res.data.success) {
      storagePath.value = res.data.storagePath || targetPath.trim();
      originalStoragePath.value = storagePath.value;
      manualPathInput.value = storagePath.value;
      saveMessage.value = { success: true, message: '存储目录已成功切换并即时生效' };
      await fetchAuthorizedPaths();
      await profileStore.fetchProfiles();
      const genStore = useGenerationStore();
      genStore.cancelPendingSave();
      genStore.isProfileDataLoaded = false;
      await genStore.loadProfileData(profileStore.currentProfile);
      setTimeout(() => {
        saveMessage.value = null;
      }, 3000);
      return true;
    } else {
      storagePath.value = originalStoragePath.value;
      manualPathInput.value = originalStoragePath.value;
      alert(`切换存储目录失败: ${res.data?.error || '未知错误'}`);
      return false;
    }
  } catch (err: any) {
    storagePath.value = originalStoragePath.value;
    manualPathInput.value = originalStoragePath.value;
    alert(`切换存储目录失败: ${err.response?.data?.error || err.message}`);
    return false;
  } finally {
    isSwitchingPath.value = false;
  }
};

const switchWithoutMerge = async (targetPath?: string) => {
  const pathToGo = targetPath || pendingSwitchPath.value;
  showMergeConfirmModal.value = false;
  if (!pathToGo) return;
  const ok = await executeSwitchPath(pathToGo);
  if (!ok) {
    storagePath.value = originalStoragePath.value;
    manualPathInput.value = originalStoragePath.value;
  }
};

const startIncrementalMerge = async (targetPath?: string) => {
  const pathToGo = targetPath || pendingSwitchPath.value;
  if (!pathToGo) return;

  if (mergePollTimer) {
    clearTimeout(mergePollTimer);
    mergePollTimer = null;
  }

  isMerging.value = true;
  showMergeConfirmModal.value = false;
  mergeProgress.value = {
    jobId: null,
    status: 'scanning',
    progress: 0,
    current: 0,
    total: 0,
    detail: '正在扫描文件与历史档案...'
  };

  try {
    const res = await encryptedAxios({
      method: 'POST',
      url: '/api/storage/merge',
      data: {
        sourcePath: originalStoragePath.value,
        targetPath: pathToGo,
        switchOnComplete: true
      }
    });

    if (res.data && res.data.success) {
      const jobId = res.data.jobId;
      if (mergeProgress.value) {
        mergeProgress.value.jobId = jobId;
      }

      const pollStatus = async () => {
        try {
          const pollRes = await encryptedAxios({
            method: 'GET',
            url: `/api/storage/merge-status?jobId=${jobId}`
          });
          if (pollRes.data && pollRes.data.success) {
            const data = pollRes.data;
            mergeProgress.value = {
              jobId: data.jobId,
              status: data.status,
              progress: data.progress ?? 0,
              current: data.current ?? 0,
              total: data.total ?? 0,
              detail: data.detail || '',
              error: data.error,
              stats: data.stats
            };

            if (data.status === 'completed') {
              storagePath.value = data.targetPath || pathToGo;
              originalStoragePath.value = storagePath.value;
              manualPathInput.value = storagePath.value;
              await fetchAuthorizedPaths();
              await profileStore.fetchProfiles();
              const genStore = useGenerationStore();
              genStore.cancelPendingSave();
              genStore.isProfileDataLoaded = false;
              await genStore.loadProfileData(profileStore.currentProfile);
              setTimeout(() => {
                isMerging.value = false;
                mergeProgress.value = null;
              }, 2000);
              return;
            } else if (data.status === 'failed') {
              storagePath.value = originalStoragePath.value;
              manualPathInput.value = originalStoragePath.value;
              return;
            }
          }
        } catch (pollErr: any) {
          console.warn('[SettingsModal] Poll merge status error:', pollErr.message);
        }

        mergePollTimer = setTimeout(pollStatus, 350);
      };

      mergePollTimer = setTimeout(pollStatus, 200);
    } else {
      storagePath.value = originalStoragePath.value;
      manualPathInput.value = originalStoragePath.value;
      mergeProgress.value = {
        jobId: null,
        status: 'failed',
        progress: 0,
        current: 0,
        total: 0,
        detail: '启动合并任务失败',
        error: res.data?.error || '启动合并任务失败'
      };
    }
  } catch (err: any) {
    storagePath.value = originalStoragePath.value;
    manualPathInput.value = originalStoragePath.value;
    mergeProgress.value = {
      jobId: null,
      status: 'failed',
      progress: 0,
      current: 0,
      total: 0,
      detail: '请求增量合并失败',
      error: err.response?.data?.error || err.message || '请求增量合并失败'
    };
  }
};

const handlePickOrAuthorize = async () => {
  if (isInsideFnOS()) {
    isPickingDirectory.value = true;
    try {
      const res = await pickSharedDirectory();
      if (res.supported && res.success && res.path) {
        promptDirectorySwitch(res.path.trim());
        return;
      } else if (res.canceled) {
        return;
      } else {
        authGuideReason.value = res.error || '系统文件选择器未响应（当前宿主版本未开放该通信接口）';
        showAuthGuideModal.value = true;
      }
    } catch (e: any) {
      console.warn('[SettingsModal] Native picker call error:', e);
      authGuideReason.value = e?.message || '调起文件选择器异常';
      showAuthGuideModal.value = true;
    } finally {
      isPickingDirectory.value = false;
    }
  } else {
    authGuideReason.value = '当前在独立浏览器窗口运行，请按指引在飞牛应用中心配置访问权限';
    showAuthGuideModal.value = true;
  }
};

const handleRefreshAfterAuth = async () => {
  const previousPaths = new Set(authorizedPaths.value.map(p => p.path));
  await fetchAuthorizedPaths();
  // Intelligently select newly added path if found
  const newlyAdded = authorizedPaths.value.find(p => !previousPaths.has(p.path) && p.writable);
  if (newlyAdded) {
    storagePath.value = newlyAdded.path;
    manualPathInput.value = newlyAdded.path;
  } else if (!currentPathInfo.value || !currentPathInfo.value.writable) {
    const valid = authorizedPaths.value.find(p => p.writable && p.type === 'share') ||
                  authorizedPaths.value.find(p => p.writable);
    if (valid) {
      storagePath.value = valid.path;
      manualPathInput.value = valid.path;
    }
  }
  showAuthGuideModal.value = false;
  authGuideReason.value = null;
};

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
      originalStoragePath.value = s.storagePath || './data';
      manualPathInput.value = s.storagePath || './data';
      imageSubdirPattern.value = s.imageSubdirPattern || '/{year}/{month}/';
      enableEncryption.value = !!s.enableEncryption;
      encryptionKey.value = s.encryptionKey || 'nahida1027';
      maxConcurrency.value = Number(s.maxConcurrency) || 1;
      enableLogging.value = s.enableLogging !== false;
    }
  } catch (err: any) {
    console.warn('[SettingsModal] Failed to load settings:', err.message);
  } finally {
    await fetchAuthorizedPaths();
  }
};

watch(() => props.modelValue, (val) => {
  if (val) {
    tokenTestResult.value = null;
    urlTestResult.value = null;
    saveMessage.value = null;
    pathValidationResult.value = null;
    checkBridgeSupport();
    loadSettings();
    profileStore.fetchProfiles();
  }
});

onMounted(async () => {
  checkBridgeSupport();
  await loadSettings();
  const authCallback = checkAppAuthCallback();
  if (authCallback.hasCallback && authCallback.status === 'success' && authCallback.path) {
    const newlyPicked = authCallback.path.trim();
    if (originalStoragePath.value && newlyPicked !== originalStoragePath.value) {
      promptDirectorySwitch(newlyPicked);
    } else {
      storagePath.value = newlyPicked;
      manualPathInput.value = newlyPicked;
    }
  }
});

// Test NovelAI Token
const handleTestToken = async () => {
  if (!apiToken.value || !apiToken.value.trim()) {
    tokenTestResult.value = { success: false, message: '请先输入 API 访问令牌' };
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
        message: `验证成功，当前订阅：${tierStr}（${res.data.active ? '生效中' : '已过期'}）` 
      };
      authStore.token = trimmed;
      await authStore.fetchUserData(trimmed);
    } else {
      tokenTestResult.value = { success: true, message: '连接成功，令牌有效' };
    }
  } catch (err: any) {
    tokenTestResult.value = { 
      success: false, 
      message: `验证失败：${err.response?.data?.message || err.message}` 
    };
  } finally {
    isTestingToken.value = false;
  }
};

// Test API Base URL
const handleTestUrl = async () => {
  if (!apiBaseUrl.value || !apiBaseUrl.value.trim()) {
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
      urlTestResult.value = { success: true, message: `连接成功 (延迟 ${res.data.latency || 0}ms)` };
    } else {
      urlTestResult.value = { success: false, message: res.data.error || '连接失败' };
    }
  } catch (err: any) {
    urlTestResult.value = { 
      success: false, 
      message: `测试失败：${err.response?.data?.error || err.message}` 
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
    if (isManualMode.value && manualPathInput.value.trim()) {
      storagePath.value = manualPathInput.value.trim();
    }
    const newStorage = storagePath.value.trim();
    if (newStorage && isStoragePathChanged.value) {
      isSaving.value = false;
      promptDirectorySwitch(newStorage);
      return;
    }

    const payload = {
      apiToken: apiToken.value.trim(),
      apiBaseUrl: apiBaseUrl.value.trim(),
      storagePath: storagePath.value.trim(),
      imageSubdirPattern: imageSubdirPattern.value.trim() || '/{year}/{month}/',
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
      saveMessage.value = { success: true, message: '设置已保存并生效' };
      setEncryptionConfig(payload.enableEncryption, payload.encryptionKey);
      if (payload.apiToken) {
        authStore.token = payload.apiToken;
      }
      if (res.data.settings?.imageSubdirPattern) {
        imageSubdirPattern.value = res.data.settings.imageSubdirPattern;
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
      message: `保存失败：${err.response?.data?.error || err.message}` 
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
    alert('存档名称仅支持中英文、数字、下划线及短横线');
    return;
  }
  const ok = await profileStore.createProfile(name);
  if (ok) {
    newProfileName.value = '';
  }
};

const handleRenameProfile = async (oldName: string) => {
  const newName = prompt(`请输入存档“${oldName}”的新名称：`, oldName);
  if (newName && newName.trim() && newName.trim() !== oldName) {
    await profileStore.renameProfile(oldName, newName.trim());
  }
};

const handleDeleteProfile = async (name: string) => {
  if (confirm(`确定要删除存档“${name}”吗？该存档包含的配置与历史图片将被移除，此操作无法撤销。`)) {
    await profileStore.deleteProfile(name);
  }
};
</script>

<template>
  <div v-if="modelValue" class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-2xl max-h-[92vh] sm:max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
      
      <!-- Modal Header -->
      <div class="px-4 py-3 sm:px-6 sm:py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50/80 dark:bg-gray-900">
        <div class="flex items-center gap-2 sm:gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Globe class="w-4 h-4" />
          </div>
          <div>
            <h3 class="font-bold text-gray-900 dark:text-white text-sm sm:text-base leading-tight">NovelAI WebUI 设置</h3>
            <p class="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 leading-tight">服务连接与存储配置</p>
          </div>
        </div>
        <button 
          @click="emit('update:modelValue', false)"
          class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Navigation Tabs (响应式防折行与全宽均衡排版) -->
      <div class="border-b border-gray-200 dark:border-gray-800 px-3 sm:px-6 bg-gray-50/50 dark:bg-gray-900/50 select-none">
        <div class="grid grid-cols-4 sm:flex sm:justify-start sm:gap-8">
          <button 
            v-for="tab in [
              { id: 'general', label: '常规设置', icon: SlidersHorizontal },
              { id: 'profiles', label: '存档管理', icon: FolderArchive },
              { id: 'security', label: '安全传输', icon: ShieldCheck },
              { id: 'performance', label: '任务与日志', icon: FileText }
            ]"
            :key="tab.id"
            @click="activeTab = tab.id as any"
            type="button"
            class="py-3 sm:py-3.5 px-1 text-xs sm:text-sm font-medium transition-colors relative outline-none focus:outline-none focus:ring-0 flex items-center justify-center sm:justify-start gap-1.5 cursor-pointer"
            :class="activeTab === tab.id ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'"
          >
            <component :is="tab.icon" class="w-4 h-4 shrink-0 hidden sm:block" />
            <span class="whitespace-nowrap">{{ tab.label }}</span>
            <!-- 激活下划线指示条 (保证准确贴底对齐且永不被浏览器黑框遮挡) -->
            <div 
              v-if="activeTab === tab.id" 
              class="absolute -bottom-px left-1.5 right-1.5 sm:left-0 sm:right-0 h-0.5 bg-blue-600 dark:bg-blue-400 rounded-full"
            ></div>
          </button>
        </div>
      </div>

      <!-- Tab Content Area -->
      <div class="p-4 sm:p-6 overflow-y-auto space-y-5 sm:space-y-6 flex-1 text-xs sm:text-sm bg-white dark:bg-gray-900">
        
        <!-- Tab 1: 常规设置 -->
        <div v-if="activeTab === 'general'" class="space-y-5 animate-fade-in">
          <!-- API Token -->
          <div class="space-y-1.5 sm:space-y-2">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2">
              <label class="block font-medium text-gray-700 dark:text-gray-300">
                NovelAI API Token
              </label>
              <span class="text-xs text-gray-400 leading-tight">保存在本地 NAS，同网络各终端免重复配置</span>
            </div>
            <div class="flex gap-2">
              <div class="relative flex-1 min-w-0">
                <input 
                  :type="showToken ? 'text' : 'password'"
                  v-model="apiToken"
                  placeholder="请输入 API 访问令牌 (pst-...)"
                  class="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl pr-10 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-xs sm:text-sm"
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
                class="px-3 sm:px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded-xl font-medium transition flex items-center gap-1.5 shrink-0 text-xs sm:text-sm whitespace-nowrap"
              >
                <Loader2 v-if="isTestingToken" class="w-4 h-4 animate-spin" />
                <span v-else>验证连接</span>
              </button>
            </div>
            <p v-if="tokenTestResult" class="text-xs flex items-center gap-1.5" :class="tokenTestResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
              <Check v-if="tokenTestResult.success" class="w-3.5 h-3.5" />
              <AlertCircle v-else class="w-3.5 h-3.5" />
              <span>{{ tokenTestResult.message }}</span>
            </p>
          </div>

          <!-- API 接口地址 -->
          <div class="space-y-1.5 sm:space-y-2">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2">
              <label class="block font-medium text-gray-700 dark:text-gray-300">
                API 接口地址
              </label>
              <span class="text-xs text-gray-400 leading-tight">默认使用官方接口</span>
            </div>
            <div class="flex gap-2">
              <input 
                type="text"
                v-model="apiBaseUrl"
                placeholder="https://image.novelai.net"
                class="flex-1 min-w-0 px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-xs sm:text-sm"
              />
              <button 
                type="button"
                @click="handleTestUrl"
                :disabled="isTestingUrl"
                class="px-3 sm:px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded-xl font-medium transition flex items-center gap-1.5 shrink-0 text-xs sm:text-sm whitespace-nowrap"
              >
                <Loader2 v-if="isTestingUrl" class="w-4 h-4 animate-spin" />
                <span v-else>测速</span>
              </button>
            </div>
            <p v-if="urlTestResult" class="text-xs flex items-center gap-1.5" :class="urlTestResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
              <Check v-if="urlTestResult.success" class="w-3.5 h-3.5" />
              <AlertCircle v-else class="w-3.5 h-3.5" />
              <span>{{ urlTestResult.message }}</span>
            </p>
            <p class="text-xs text-gray-400 leading-relaxed">
              用于生图请求、流式传输、超分辨率放大等核心功能的接口通信。如配置了自建代理或加速节点，可在此填入代理地址。
            </p>
          </div>

          <!-- NAS 本地存储路径与可视化授权 -->
          <div class="space-y-2.5 p-3 sm:p-4 rounded-xl bg-gray-50/70 dark:bg-gray-800/40 border border-gray-200/80 dark:border-gray-700/60">
            <!-- Header with Title & Action Buttons -->
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <label class="block font-medium text-gray-800 dark:text-gray-200 text-xs sm:text-sm">
                  数据存储目录
                </label>
                <p class="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
                  用于持久化保存生图历史、角色库及 SQLite 存档数据库
                </p>
              </div>

              <!-- Action buttons group -->
              <div class="flex items-center gap-1.5 self-start sm:self-auto shrink-0 flex-wrap">
                <button
                  type="button"
                  @click="fetchAuthorizedPaths"
                  :disabled="isLoadingPaths"
                  class="px-2.5 py-1.5 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 font-medium text-xs flex items-center gap-1 transition shadow-sm cursor-pointer disabled:opacity-50"
                  title="刷新已授权目录列表"
                >
                  <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isLoadingPaths }" />
                  <span>刷新</span>
                </button>
                <button
                  type="button"
                  @click="showAuthGuideModal = true"
                  class="px-2.5 py-1.5 bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 font-medium text-xs flex items-center gap-1 transition shadow-sm cursor-pointer"
                  title="查看飞牛存储目录授权与配置指引"
                >
                  <HelpCircle class="w-3.5 h-3.5 text-blue-500" />
                  <span>授权指引</span>
                </button>
                <button
                  v-if="isBridgeSupported"
                  type="button"
                  @click="handlePickOrAuthorize"
                  :disabled="isPickingDirectory"
                  class="px-2.5 py-1.5 bg-blue-50 dark:bg-blue-900/40 hover:bg-blue-100 dark:hover:bg-blue-800/50 border border-blue-200 dark:border-blue-700/50 rounded-lg text-blue-700 dark:text-blue-300 font-medium text-xs flex items-center gap-1 transition shadow-sm cursor-pointer disabled:opacity-50"
                  title="在飞牛系统中选择或授权存储文件夹"
                >
                  <Loader2 v-if="isPickingDirectory" class="w-3.5 h-3.5 animate-spin" />
                  <FolderPlus v-else class="w-3.5 h-3.5" />
                  <span>{{ isPickingDirectory ? '调起授权中...' : '文件夹授权' }}</span>
                </button>
                <button
                  v-if="isBridgeSupported"
                  type="button"
                  @click="handleOpenAppSetting"
                  :disabled="isOpeningAppSetting"
                  class="px-2.5 py-1.5 bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 font-medium text-xs flex items-center gap-1 transition shadow-sm cursor-pointer disabled:opacity-50"
                  title="调起飞牛系统应用设置（授权与配置）"
                >
                  <Loader2 v-if="isOpeningAppSetting" class="w-3.5 h-3.5 animate-spin" />
                  <ExternalLink v-else class="w-3.5 h-3.5" />
                  <span>{{ isOpeningAppSetting ? '调起设置中...' : '系统设置' }}</span>
                </button>
                <button
                  type="button"
                  @click="isManualMode = !isManualMode"
                  class="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white rounded-lg text-xs font-medium flex items-center gap-1 transition cursor-pointer"
                  :title="isManualMode ? '切换为预设列表' : '手动输入路径'"
                >
                  <FolderTree v-if="isManualMode" class="w-3.5 h-3.5" />
                  <Edit3 v-else class="w-3.5 h-3.5" />
                  <span>{{ isManualMode ? '选择预设目录' : '手动输入路径' }}</span>
                </button>
              </div>
            </div>

            <!-- Feedback alert if system setting call has status -->
            <div 
              v-if="appSettingActionFeedback" 
              class="px-3 py-2 rounded-lg text-xs flex items-center justify-between transition-all"
              :class="appSettingActionFeedback.success ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300'"
            >
              <span class="flex items-center gap-1.5 min-w-0">
                <Check v-if="appSettingActionFeedback.success" class="w-3.5 h-3.5 shrink-0" />
                <AlertCircle v-else class="w-3.5 h-3.5 shrink-0" />
                <span class="truncate">{{ appSettingActionFeedback.message }}</span>
              </span>
              <button 
                type="button" 
                @click="appSettingActionFeedback = null" 
                class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 ml-2"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Hint if picking takes time in desktop -->
            <div v-if="isPickingDirectory" class="px-2.5 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs flex items-center justify-between text-blue-700 dark:text-blue-300">
              <span class="flex items-center gap-1.5">
                <Loader2 class="w-3.5 h-3.5 animate-spin" />
                正在调起系统文件选择器...
              </span>
              <button 
                type="button" 
                @click="isPickingDirectory = false; showAuthGuideModal = true" 
                class="underline hover:text-blue-800 dark:hover:text-blue-200 cursor-pointer"
              >
                未弹出？查看授权指引
              </button>
            </div>

            <!-- Mode 1: CustomSelect Dropdown Mode (Default) -->
            <div v-if="!isManualMode" class="pt-0.5">
              <CustomSelect
                v-model="storagePath"
                :options="storagePathOptions"
                placeholder="正在获取已授权存储目录..."
                @change="handleSelectPath"
              />
            </div>

            <!-- Mode 2: Manual Path Input Mode -->
            <div v-else class="space-y-2 pt-0.5">
              <div class="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  v-model="manualPathInput"
                  placeholder="/vol1/shares/NovelAI-WebUI"
                  class="flex-1 min-w-0 px-3.5 py-2.5 bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors font-mono text-xs sm:text-sm shadow-sm"
                />
                <div class="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    @click="handleTestManualPath"
                    :disabled="isValidatingPath || !manualPathInput.trim()"
                    class="flex-1 sm:flex-initial px-3 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium transition flex items-center justify-center gap-1.5 text-xs whitespace-nowrap cursor-pointer disabled:opacity-50 border border-gray-200 dark:border-gray-700"
                    title="测试路径是否存在且具备读写权限"
                  >
                    <Loader2 v-if="isValidatingPath" class="w-3.5 h-3.5 animate-spin" />
                    <ShieldCheck v-else class="w-3.5 h-3.5 text-blue-500" />
                    <span>测试权限</span>
                  </button>
                  <button
                    type="button"
                    @click="handleApplyManualPath"
                    :disabled="isValidatingPath || isSwitchingPath || isMerging || !manualPathInput.trim()"
                    class="flex-1 sm:flex-initial px-3.5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition flex items-center justify-center gap-1.5 text-xs whitespace-nowrap cursor-pointer disabled:opacity-50 shadow-sm"
                    title="验证并切换至该存储路径"
                  >
                    <Loader2 v-if="isSwitchingPath || isMerging" class="w-3.5 h-3.5 animate-spin" />
                    <span v-else>应用切换</span>
                  </button>
                </div>
              </div>
              <p v-if="pathValidationResult" class="text-xs flex items-center gap-1.5" :class="pathValidationResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
                <Check v-if="pathValidationResult.success" class="w-3.5 h-3.5 shrink-0" />
                <AlertCircle v-else class="w-3.5 h-3.5 shrink-0" />
                <span>{{ pathValidationResult.message || pathValidationResult.error }}</span>
              </p>
            </div>

            <!-- Status Indicator -->
            <div class="pt-0.5">
              <div v-if="currentPathInfo" class="text-xs">
                <div v-if="currentPathInfo.writable" class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <Check class="w-3.5 h-3.5 shrink-0" />
                  <span>读写权限正常（已获得飞牛系统授权，可正常存放生图历史与数据）</span>
                </div>
                <div v-else class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-2 rounded-lg">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <AlertCircle class="w-3.5 h-3.5 shrink-0" />
                    <span class="truncate">{{ currentPathInfo.reason || '未获得写入权限，请在飞牛系统应用中心授予读写权限' }}</span>
                  </div>
                  <div class="flex items-center gap-2.5 shrink-0 flex-wrap">
                    <button
                      v-if="isBridgeSupported"
                      type="button"
                      @click="handlePickOrAuthorize"
                      :disabled="isPickingDirectory"
                      class="underline font-medium hover:text-amber-700 dark:hover:text-amber-300 cursor-pointer disabled:opacity-50"
                    >
                      {{ isPickingDirectory ? '正在调起...' : '调起授权' }}
                    </button>
                    <button
                      v-if="isBridgeSupported"
                      type="button"
                      @click="handleOpenAppSetting"
                      :disabled="isOpeningAppSetting"
                      class="underline font-medium hover:text-amber-700 dark:hover:text-amber-300 cursor-pointer disabled:opacity-50"
                    >
                      {{ isOpeningAppSetting ? '正在调起...' : '系统设置' }}
                    </button>
                    <button
                      type="button"
                      @click="showAuthGuideModal = true"
                      class="underline font-medium hover:text-amber-700 dark:hover:text-amber-300 cursor-pointer"
                    >
                      查看授权指引
                    </button>
                  </div>
                </div>
              </div>

              <!-- Quick Switch button when selected differs from active config -->
              <div v-if="isStoragePathChanged" class="mt-2 flex items-center justify-between bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 p-2.5 rounded-lg text-xs">
                <span class="text-blue-700 dark:text-blue-300">
                  存储目录已变更，保存设置或点击立即应用切换。
                </span>
                <button
                  type="button"
                  @click="promptDirectorySwitch(storagePath)"
                  :disabled="isSwitchingPath || isMerging"
                  class="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-md font-medium text-xs flex items-center gap-1 transition shadow-sm shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Loader2 v-if="isSwitchingPath || isMerging" class="w-3 h-3 animate-spin" />
                  <span>立即切换</span>
                </button>
              </div>
            </div>

            <!-- Copyable Guide Card -->
            <div class="p-3 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/70 dark:border-blue-900/50 space-y-1.5 text-xs">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5 font-semibold text-blue-900 dark:text-blue-200">
                  <ShieldCheck class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span>飞牛系统权限机制说明</span>
                </div>
                <button
                  type="button"
                  @click="handleCopyAuthGuide"
                  class="text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 font-medium flex items-center gap-1 transition cursor-pointer"
                  title="复制权限配置指引"
                >
                  <Check v-if="hasCopiedGuide" class="w-3 h-3 text-emerald-500" />
                  <Copy v-else class="w-3 h-3" />
                  <span>{{ hasCopiedGuide ? '已复制指引' : '复制指引' }}</span>
                </button>
              </div>
              <p class="text-blue-800/90 dark:text-blue-300/90 leading-relaxed text-[11px] sm:text-xs">
                如需使用其他共享文件夹，请在飞牛系统【应用中心】->【已安装】->【NovelAI WebUI】->【设置】->【访问权限】中添加并设为读写。添加后点击【刷新】即可在下拉列表中选择。
              </p>
            </div>

            <!-- Path explanation -->
            <p class="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 leading-relaxed pt-0.5">
              当前配置路径：<code class="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-mono text-gray-700 dark:text-gray-300 select-all">{{ storagePath }}</code>。系统存档将存放在此路径的 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">profiles/</code> 文件夹中。
            </p>
          </div>

          <!-- 存档图片保存子目录结构 -->
          <div class="space-y-2 sm:space-y-2.5">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2">
              <label class="block font-medium text-gray-700 dark:text-gray-300">
                图片存档子目录规则
              </label>
              <button 
                type="button" 
                @click="imageSubdirPattern = '/{year}/{month}/'"
                class="text-xs text-blue-600 dark:text-blue-400 hover:underline self-start sm:self-auto"
              >
                恢复默认 (/{year}/{month}/)
              </button>
            </div>
            <input 
              type="text"
              v-model="imageSubdirPattern"
              @input="handlePatternInput"
              @blur="handlePatternBlur"
              placeholder="/{year}/{month}/"
              class="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors font-mono text-xs"
            />

            <!-- 变量标签 Chips -->
            <div class="space-y-1.5">
              <div class="text-[11px] text-gray-500 dark:text-gray-400">点击下方变量标签可快速插入：</div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="v in AVAILABLE_VARIABLES"
                  :key="v.name"
                  type="button"
                  @click="insertVariable(v.name)"
                  class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950 dark:hover:text-blue-300 text-gray-700 dark:text-gray-300 text-xs font-mono transition border border-gray-200 dark:border-gray-700"
                  :title="v.desc"
                >
                  <span class="font-semibold">{{ v.name }}</span>
                  <span class="text-[10px] text-gray-400 font-sans">({{ v.desc }})</span>
                </button>
              </div>
            </div>

            <!-- 实时路径预览 -->
            <div class="p-3 bg-gray-50/90 dark:bg-gray-950/60 rounded-xl border border-gray-200 dark:border-gray-800 space-y-1">
              <div class="text-xs font-medium text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
                <FolderTree class="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span>实时保存路径预览：</span>
              </div>
              <div class="font-mono text-xs text-blue-600 dark:text-blue-400 break-all select-all pl-5">
                {{ previewPath }}
              </div>
            </div>

            <p class="text-xs text-gray-400 leading-relaxed">
              生成的图片将按此规则自动分类存放。严禁包含 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">..</code> 跨目录路径，反斜杠 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">\</code> 将自动修正为正斜杠。
            </p>
          </div>

          <!-- 外观主题说明 -->
          <div class="p-3.5 bg-gray-50/80 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <Sun class="w-5 h-5 text-amber-500 dark:hidden" />
              <Moon class="w-5 h-5 text-blue-400 hidden dark:block" />
              <div>
                <div class="font-medium text-gray-800 dark:text-gray-200 text-xs">外观主题</div>
                <div class="text-[11px] text-gray-400">支持浅色与深色模式，默认跟随操作系统。可在主界面右上角随时手动切换。</div>
              </div>
            </div>
          </div>

          <!-- 手机端飞牛 App 弱化效果开关 -->
          <div class="flex items-start justify-between p-4 bg-gray-50/80 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1 pr-4">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <Smartphone class="w-4 h-4 text-purple-500" />
                <span>手机端飞牛 App 内弱化显示效果</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                在飞牛 App 内精简视觉特效，提升移动端浏览与操作流畅度。
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
              <input type="checkbox" v-model="reduceMobileEffects" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

        <!-- Tab 2: 存档管理 -->
        <div v-if="activeTab === 'profiles'" class="space-y-5 animate-fade-in">
          <div class="p-3.5 bg-blue-50/60 dark:bg-blue-950/30 rounded-xl border border-blue-200 dark:border-blue-900/40 text-xs text-blue-800 dark:text-blue-300 leading-relaxed">
            支持创建多个独立存档。各存档的提示词库、常用分组、自定义角色、画风预设及历史图片彼此隔离，便于按不同画风或项目分类管理。
          </div>

          <!-- 新建存档 -->
          <div class="space-y-2">
            <label class="block font-medium text-gray-700 dark:text-gray-300">新建存档</label>
            <div class="flex gap-2">
              <input 
                type="text"
                v-model="newProfileName"
                placeholder="输入新存档名称（如：二次元、真实插画、项目A）"
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
            <label class="block font-medium text-gray-700 dark:text-gray-300">已创建存档</label>
            <div class="divide-y divide-gray-200 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950/40">
              <div 
                v-for="p in profileStore.profiles" 
                :key="p"
                class="px-3.5 sm:px-4 py-3 flex items-center justify-between gap-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
              >
                <div class="flex items-center gap-2 sm:gap-2.5 min-w-0">
                  <div 
                    class="w-2.5 h-2.5 rounded-full shrink-0"
                    :class="profileStore.currentProfile === p ? 'bg-emerald-500 ring-4 ring-emerald-500/20' : 'bg-gray-300 dark:bg-gray-600'"
                  ></div>
                  <span class="font-medium text-gray-800 dark:text-gray-200 text-xs sm:text-sm truncate max-w-[110px] sm:max-w-xs">{{ p }}</span>
                  <span v-if="profileStore.currentProfile === p" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 font-semibold shrink-0">
                    使用中
                  </span>
                  <span v-if="p === 'Default'" class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 shrink-0">
                    默认
                  </span>
                </div>
                <div class="flex items-center gap-1 sm:gap-1.5 shrink-0">
                  <button 
                    v-if="profileStore.currentProfile !== p"
                    @click="profileStore.switchProfile(p)"
                    class="px-2.5 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded-lg transition"
                  >
                    切换
                  </button>
                  <button 
                    v-if="p !== 'Default'"
                    @click="handleRenameProfile(p)"
                    class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                    title="重命名"
                  >
                    <Edit3 class="w-4 h-4" />
                  </button>
                  <button 
                    v-if="p !== 'Default'"
                    @click="handleDeleteProfile(p)"
                    class="p-1.5 text-rose-400 hover:text-rose-600 dark:hover:text-rose-300 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/50 transition"
                    title="删除存档"
                  >
                    <Trash2 class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 3: 安全传输 -->
        <div v-if="activeTab === 'security'" class="space-y-5 animate-fade-in">
          <div class="flex items-start justify-between p-4 bg-gray-50/80 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1 pr-4">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <ShieldCheck class="w-4 h-4 text-emerald-500" />
                <span>数据传输加密</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                开启后，网页端与 NAS 之间交互的请求参数、提示词及图像流将进行双向混淆加密，提高在局域网复杂环境下的数据传输安全性。
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
              <input type="checkbox" v-model="enableEncryption" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          <div v-if="enableEncryption" class="space-y-2 animate-fade-in">
            <label class="block font-medium text-gray-700 dark:text-gray-300">
              通信加密密钥
            </label>
            <input 
              type="text"
              v-model="encryptionKey"
              placeholder="请输入通信加密密钥"
              class="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm transition-colors"
            />
            <p class="text-xs text-gray-400 leading-relaxed">
              网页端与后端之间用于数据传输加解密的共享密钥，两端密钥保持一致即可正常通信。
            </p>
          </div>
        </div>

        <!-- Tab 4: 任务与日志 -->
        <div v-if="activeTab === 'performance'" class="space-y-5 animate-fade-in">
          <!-- 任务并发排队 -->
          <div class="space-y-3 p-4 bg-gray-50/80 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <Cpu class="w-4 h-4 text-blue-500" />
                <span>任务并发排队</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                当多个设备或标签页同时提交生成任务时，自动按顺序排队执行，并在界面实时显示等待状态，避免因并发请求过多被官方接口限制。
              </p>
            </div>
            <div class="pt-2 flex items-center justify-between border-t border-gray-200/50 dark:border-gray-700/50">
              <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">最大并行任务数：</span>
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

          <!-- 生成任务日志 -->
          <div class="flex items-start justify-between p-4 bg-gray-50/80 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-800">
            <div class="space-y-1 pr-4">
              <div class="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                <FileText class="w-4 h-4 text-amber-500" />
                <span>生成任务日志</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                生成完成后，在 NAS 的 <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-gray-700 dark:text-gray-300">logs/generation/</code> 目录下按月记录任务参数与运行耗时（仅记录文本元数据，不包含图像数据），便于回溯查看。
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
      <div class="px-4 py-3 sm:px-6 sm:py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between gap-2 bg-gray-50/80 dark:bg-gray-900">
        <div class="min-w-0 flex-1">
          <span v-if="saveMessage" class="text-xs font-medium flex items-center gap-1.5 truncate" :class="saveMessage.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'">
            <Check v-if="saveMessage.success" class="w-3.5 h-3.5 shrink-0" />
            <AlertCircle v-else class="w-3.5 h-3.5 shrink-0" />
            <span class="truncate">{{ saveMessage.message }}</span>
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button 
            type="button"
            @click="emit('update:modelValue', false)"
            class="px-3.5 sm:px-4 py-2 text-xs sm:text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition"
          >
            关闭
          </button>
          <button 
            type="button"
            @click="handleSaveSettings"
            :disabled="isSaving"
            class="px-4 sm:px-5 py-2 text-xs sm:text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-xl transition flex items-center gap-1.5 sm:gap-2 shadow-sm whitespace-nowrap"
          >
            <Loader2 v-if="isSaving" class="w-4 h-4 animate-spin shrink-0" />
            <Save v-else class="w-4 h-4 shrink-0" />
            <span>保存配置</span>
          </button>
        </div>
      </div>

    </div>

    <!-- 存储目录切换与增量合并确认弹窗 -->
    <div 
      v-if="showMergeConfirmModal && !isMerging" 
      class="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
    >
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl flex flex-col space-y-4">
        <!-- Title bar -->
        <div class="flex items-center justify-between pb-3 border-b border-gray-200 dark:border-gray-800">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <GitMerge class="w-4 h-4" />
            </div>
            <div>
              <h4 class="font-bold text-gray-900 dark:text-white text-sm sm:text-base leading-tight">切换数据存储目录</h4>
              <p class="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">检测到存储路径变更，请选择数据迁移策略</p>
            </div>
          </div>
          <button 
            type="button"
            @click="cancelDirectorySwitch"
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition cursor-pointer"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Path Comparison Cards -->
        <div class="space-y-2 text-xs sm:text-sm">
          <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 space-y-1.5">
            <div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>当前存储目录</span>
              <span class="text-[11px] text-gray-400">原有数据源</span>
            </div>
            <div class="font-mono text-gray-800 dark:text-gray-200 text-xs sm:text-sm break-all font-medium">
              {{ originalStoragePath }}
            </div>
          </div>

          <div class="flex justify-center -my-1 text-gray-400 dark:text-gray-500">
            <ArrowRightLeft class="w-4 h-4" />
          </div>

          <div class="p-3 rounded-xl bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200/70 dark:border-blue-900/40 space-y-1.5">
            <div class="flex items-center justify-between text-xs text-blue-600 dark:text-blue-400 font-medium">
              <span>目标存储目录</span>
              <span class="text-[11px] text-blue-500/80">切换目标</span>
            </div>
            <div class="font-mono text-blue-950 dark:text-blue-200 text-xs sm:text-sm break-all font-medium">
              {{ pendingSwitchPath }}
            </div>
          </div>
        </div>

        <!-- Strategy Description Box -->
        <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 space-y-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
          <div class="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <ShieldCheck class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>增量合并保障</span>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            增量合并：仅复制目标目录不存在的文件与记录，保留全部历史图片与档案，绝不覆盖已有文件。若目标目录已有同名历史记录，将优先保留目标记录，无主键冲突风险。
          </p>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-col sm:flex-row items-center justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            @click="cancelDirectorySwitch"
            class="w-full sm:w-auto px-4 py-2 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-xl transition cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            @click="switchWithoutMerge()"
            class="w-full sm:w-auto px-4 py-2 text-xs font-medium border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <ArrowRightLeft class="w-3.5 h-3.5" />
            <span>仅切换目录（不迁移数据）</span>
          </button>
          <button
            type="button"
            @click="startIncrementalMerge()"
            class="w-full sm:w-auto px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
          >
            <GitMerge class="w-3.5 h-3.5" />
            <span>合并数据并切换</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 增量合并实时进度弹窗 -->
    <div 
      v-if="isMerging" 
      class="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl flex flex-col space-y-4">
        <!-- Title bar -->
        <div class="flex items-center gap-2.5 pb-3 border-b border-gray-200 dark:border-gray-800">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" :class="mergeProgress?.status === 'completed' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : (mergeProgress?.status === 'failed' ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400')">
            <CheckCircle2 v-if="mergeProgress?.status === 'completed'" class="w-4 h-4" />
            <AlertCircle v-else-if="mergeProgress?.status === 'failed'" class="w-4 h-4" />
            <Loader2 v-else class="w-4 h-4 animate-spin" />
          </div>
          <div>
            <h4 class="font-bold text-gray-900 dark:text-white text-sm sm:text-base leading-tight">
              {{ mergeProgress?.status === 'completed' ? '数据增量合并完成' : (mergeProgress?.status === 'failed' ? '数据增量合并失败' : '正在增量合并存储数据') }}
            </h4>
            <p class="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
              {{ mergeProgress?.status === 'completed' ? '两侧数据已同步完成，新存储目录已生效' : (mergeProgress?.status === 'failed' ? '合并过程遇到错误' : '正在安全扫描与复制未同步文件，合并 SQLite 历史') }}
            </p>
          </div>
        </div>

        <!-- Progress Bar & Status -->
        <div class="space-y-3 py-1">
          <!-- Percent row -->
          <div class="flex items-center justify-between text-xs">
            <span class="font-medium text-gray-700 dark:text-gray-300">
              {{ mergeProgress?.status === 'completed' ? '合并已就绪' : (mergeProgress?.status === 'failed' ? '任务中断' : '同步处理中') }}
            </span>
            <span class="font-mono font-semibold" :class="mergeProgress?.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'">
              {{ mergeProgress?.progress ?? 0 }}%
            </span>
          </div>

          <!-- Progress Bar Track -->
          <div class="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-3 overflow-hidden p-0.5 border border-gray-200/50 dark:border-gray-700/50">
            <div 
              class="h-full rounded-full transition-all duration-300 ease-out"
              :class="mergeProgress?.status === 'completed' ? 'bg-emerald-500' : (mergeProgress?.status === 'failed' ? 'bg-rose-500' : 'bg-blue-600')"
              :style="{ width: `${Math.max(3, mergeProgress?.progress ?? 0)}%` }"
            ></div>
          </div>

          <!-- Counters & Detailed message -->
          <div class="flex items-center justify-between text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 font-mono">
            <span>已处理: {{ mergeProgress?.current ?? 0 }} / {{ mergeProgress?.total ?? 0 }} 项</span>
            <span v-if="mergeProgress?.stats" class="text-emerald-600 dark:text-emerald-400 font-medium font-sans">
              复制 {{ mergeProgress.stats.filesCopied }} 文件 / 合并 {{ mergeProgress.stats.recordsMerged }} 记录
            </span>
          </div>

          <!-- Detail Message Box -->
          <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-xs">
            <div v-if="mergeProgress?.error" class="text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
              <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
              <span class="break-all">{{ mergeProgress.error }}</span>
            </div>
            <div v-else class="text-gray-600 dark:text-gray-300 flex items-center gap-2 truncate">
              <Loader2 v-if="mergeProgress?.status !== 'completed'" class="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
              <Check v-else class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span class="truncate font-mono">{{ mergeProgress?.detail || '正在处理数据...' }}</span>
            </div>
          </div>
        </div>

        <!-- Action / Close row when finished -->
        <div v-if="mergeProgress?.status === 'completed' || mergeProgress?.status === 'failed'" class="flex justify-end pt-2 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            @click="isMerging = false; mergeProgress = null"
            class="px-4 py-2 text-xs font-medium rounded-xl transition cursor-pointer"
            :class="mergeProgress?.status === 'completed' ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'"
          >
            {{ mergeProgress?.status === 'completed' ? '完成' : '关闭' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 飞牛存储授权向导弹窗 -->
    <div 
      v-if="showAuthGuideModal" 
      class="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
    >
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl flex flex-col space-y-4">
        <div class="flex items-center justify-between pb-3 border-b border-gray-200 dark:border-gray-800">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <FolderTree class="w-4 h-4" />
            </div>
            <div>
              <h4 class="font-bold text-gray-900 dark:text-white text-sm sm:text-base leading-tight">飞牛存储目录授权指引</h4>
              <p class="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">为应用配置 NAS 共享文件夹读写权限</p>
            </div>
          </div>
          <button 
            type="button"
            @click="showAuthGuideModal = false"
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition cursor-pointer"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Diagnostic Reason if triggered by failed action -->
        <div v-if="authGuideReason" class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
          <span class="leading-relaxed">{{ authGuideReason }}</span>
        </div>

        <!-- 3-Step Guide -->
        <div class="space-y-3.5 text-xs sm:text-sm">
          <div class="flex gap-3 items-start bg-gray-50 dark:bg-gray-950 p-3 rounded-xl border border-gray-200 dark:border-gray-800">
            <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">1</span>
            <div class="space-y-1.5 flex-1">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-gray-900 dark:text-gray-100">打开飞牛系统【应用设置】</span>
                <button
                  v-if="isBridgeSupported"
                  type="button"
                  @click="handleOpenAppSetting"
                  :disabled="isOpeningAppSetting"
                  class="px-2.5 py-1 text-xs font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800/40 border border-blue-200 dark:border-blue-700/50 rounded-lg transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                >
                  <Loader2 v-if="isOpeningAppSetting" class="w-3 h-3 animate-spin" />
                  <ExternalLink v-else class="w-3 h-3" />
                  <span>{{ isOpeningAppSetting ? '调起中...' : '呼出应用设置' }}</span>
                </button>
              </div>
              <div class="text-gray-500 dark:text-gray-400 text-xs leading-relaxed">
                在飞牛 OS 桌面中打开【应用中心】->【已安装】，找到【NovelAI WebUI】图标，点击右上角【设置】按钮。
              </div>
            </div>
          </div>

          <div class="flex gap-3 items-start bg-gray-50 dark:bg-gray-950 p-3 rounded-xl border border-gray-200 dark:border-gray-800">
            <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">2</span>
            <div class="space-y-1.5 flex-1">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-gray-900 dark:text-gray-100">添加共享文件夹读写授权</span>
                <button
                  type="button"
                  @click="handleOpenAppAuthRoute"
                  :disabled="isOpeningAuthRoute"
                  class="px-2.5 py-1 text-xs font-medium bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-800/40 border border-purple-200 dark:border-purple-700/50 rounded-lg transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  title="使用飞牛原生 App Auth 授权路由打开选择器"
                >
                  <Loader2 v-if="isOpeningAuthRoute" class="w-3 h-3 animate-spin" />
                  <FolderPlus v-else class="w-3 h-3" />
                  <span>{{ isOpeningAuthRoute ? '打开中...' : 'Web授权页面' }}</span>
                </button>
              </div>
              <div class="text-gray-500 dark:text-gray-400 text-xs leading-relaxed">
                切换至【访问权限】选项卡，点击【+ 添加】，勾选需要作为存储的共享文件夹，并将权限设为【读写】。亦可点击上方按钮尝试在新页面直接授权。
              </div>
            </div>
          </div>

          <div class="flex gap-3 items-start bg-gray-50 dark:bg-gray-950 p-3 rounded-xl border border-gray-200 dark:border-gray-800">
            <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">3</span>
            <div class="space-y-0.5 flex-1">
              <div class="font-semibold text-gray-900 dark:text-gray-100">保存设置并刷新目录列表</div>
              <div class="text-gray-500 dark:text-gray-400 text-xs leading-relaxed">
                在飞牛系统中完成授权配置后返回此处，点击下方按钮刷新，新增文件夹将自动进入下拉列表。
              </div>
            </div>
          </div>
        </div>

        <!-- Action buttons -->
        <div class="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2 border-t border-gray-200 dark:border-gray-800">
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <button
              v-if="isBridgeSupported"
              type="button"
              @click="handleOpenAppSetting"
              :disabled="isOpeningAppSetting"
              class="w-full sm:w-auto px-3.5 py-2 text-xs font-medium bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Loader2 v-if="isOpeningAppSetting" class="w-3.5 h-3.5 animate-spin" />
              <ExternalLink v-else class="w-3.5 h-3.5" />
              <span>{{ isOpeningAppSetting ? '正在调起系统设置...' : '打开系统应用设置' }}</span>
            </button>
            <button
              type="button"
              @click="handleCopyAuthGuide"
              class="px-3 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-xl transition flex items-center gap-1 cursor-pointer"
            >
              <Check v-if="hasCopiedGuide" class="w-3.5 h-3.5 text-emerald-500" />
              <Copy v-else class="w-3.5 h-3.5" />
              <span>{{ hasCopiedGuide ? '已复制指引' : '复制配置指引' }}</span>
            </button>
          </div>

          <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
            <button
              type="button"
              @click="isManualMode = true; showAuthGuideModal = false;"
              class="px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition cursor-pointer"
            >
              手动指定路径
            </button>
            <button
              type="button"
              @click="handleRefreshAfterAuth"
              :disabled="isLoadingPaths"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium text-xs flex items-center justify-center gap-1.5 transition shadow-sm cursor-pointer disabled:opacity-50"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isLoadingPaths }" />
              <span>刷新目录列表</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
