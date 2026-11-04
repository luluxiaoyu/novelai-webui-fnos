import { defineStore } from 'pinia';
import { ref, reactive, watch } from 'vue';
import { encryptedAxios, encryptedFetchStream, resolveApiUrl } from '../utils/api';
import JSZip from 'jszip';
import { useAuthStore } from './auth';
import { useProfileStore } from './profile';

export interface CharacterPrompt {
  id: string;
  prompt: string;
  uc?: string;
  center: { x: number; y: number };
  enabled?: boolean;
}

export interface GenerationParams {
  prompt: string;
  negative_prompt: string;
  model: string;
  width: number;
  height: number;
  steps: number;
  sampler: string;
  scale: number;
  seed: number;
  sm: boolean;
  sm_dyn: boolean;
  dynamic_thresholding: boolean;
  enable_stream: boolean;
  // Advanced Sampling & Noise Controls
  noise_schedule: string;
  cfg_rescale: number;
  uncond_scale: number;
  skip_cfg_above_sigma: number | null;
  prefer_brownian: boolean;
  // Character Prompts (V4, V4.5, V5)
  characters?: CharacterPrompt[];
  use_coords?: boolean;
  // Inpaint / Img2img
  image?: string; // Base64 or URL
  mask?: string;  // Base64
  strength?: number;
  noise?: number;
  auto_quality_presets?: boolean;
  transparent_bg?: boolean;
  is_upscaled?: boolean;
}

export const OFFICIAL_V5_POS_PRESET = ', no text, best quality, very aesthetic, absurdres, very aesthetic, masterpiece, no text';
export const OFFICIAL_V5_NEG_PRESET = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, bad feet, username, {bad}, fewer, extra, watermark, unfinished,displeasing, chromatic aberration, signature, extra digits, artistic error, scan, [abstract],logo,{big belly},';

export interface GeneratedImage {
  id: string;
  url: string;
  params: GenerationParams;
  timestamp: number;
  isNew?: boolean;
  isUpscaled?: boolean;
}

export const isImageUpscaled = (img?: GeneratedImage | null): boolean => {
  if (!img) return false;
  if (img.isUpscaled === true) return true;
  if (img.params?.is_upscaled === true) return true;
  if (img.params?.width && img.params?.height) {
    if (img.params.width * img.params.height > 1048576) {
      return true;
    }
  }
  return false;
};

// 多标签页跨页面同步通道
let tabSyncChannel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  try {
    tabSyncChannel = new BroadcastChannel('novelai_tab_sync');
  } catch (e) {
    console.warn('BroadcastChannel not supported', e);
  }
}

export const useGenerationStore = defineStore('generation', () => {
  const authStore = useAuthStore();
  const profileStore = useProfileStore();

  const params = reactive<GenerationParams>({
    prompt: '',
    negative_prompt: '',
    model: 'nai-diffusion-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    sampler: 'k_euler_ancestral',
    scale: 7.0,
    seed: -1,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    enable_stream: true,
    noise_schedule: 'karras',
    cfg_rescale: 0,
    uncond_scale: 0,
    skip_cfg_above_sigma: null,
    prefer_brownian: true,
    characters: [],
    use_coords: false,
    image: undefined,
    mask: undefined,
    strength: 0.7,
    noise: 0.0,
    auto_quality_presets: true,
    transparent_bg: false
  });

  const history = ref<GeneratedImage[]>([]);
  const promptHistory = ref<Array<{ 
    id: string; 
    prompt: string; 
    negative_prompt?: string; 
    timestamp: number;
    characters?: CharacterPrompt[];
    use_coords?: boolean;
    note?: string;
    isFavorite?: boolean;
    group?: string;
  }>>([]);
  const savedPromptGroups = ref<string[]>([]);

  const customCharacters = ref<Array<{ id: string; name: string; category: string; prompt: string; uc?: string; isFavorite?: boolean; isBuiltin?: boolean; updatedAt?: number }>>([]);
  const customStyles = ref<Array<{ id: string; name: string; category: string; prompt: string; uc?: string; isFavorite?: boolean }>>([]);
  const enableTagSuggestions = ref(false);
  const enableStreamThrottle = ref(false);
  const isGenerating = ref(false);
  const isUpscaling = ref(false);
  const queueInfo = ref<{ waiting: number; active: number; isBusy: boolean } | null>(null);
  let queuePollTimer: any = null;

  const startQueuePolling = () => {
    stopQueuePolling();
    const poll = async () => {
      try {
        const headers: Record<string, string> = {};
        if (authStore.siteAccessKey) headers['x-access-key'] = authStore.siteAccessKey;
        if (authStore.token) headers['Authorization'] = authStore.token === '__BUILTIN__' ? '__BUILTIN__' : `Bearer ${authStore.token}`;
        const res = await encryptedAxios({
          method: 'GET',
          url: '/api/queue-status',
          headers
        });
        if (res.data && res.data.success) {
          queueInfo.value = {
            waiting: res.data.waiting,
            active: res.data.active,
            isBusy: res.data.isBusy
          };
        }
      } catch (e) {}
    };
    poll();
    queuePollTimer = setInterval(poll, 1500);
  };

  const stopQueuePolling = () => {
    if (queuePollTimer) {
      clearInterval(queuePollTimer);
      queuePollTimer = null;
    }
    queueInfo.value = null;
  };

  const streamPreviewUrl = ref<string | null>(null);
  const error = ref('');
  const currentImage = ref<GeneratedImage | null>(null);

  const batchCount = ref(1);
  const batchTotal = ref(1);
  const batchCurrent = ref(0);

  const isLoadingHistory = ref(false);
  const isProfileDataLoaded = ref(false);
  let loadProfilePromise: Promise<void> | null = null;

  // 防抖保存活动存档元数据至 NAS（带合并缓冲队列与显式删除标志）
  let saveTimer: any = null;
  let pendingSaveData: Record<string, any> = {};

  const saveProfileData = async (partialData?: Record<string, any>) => {
    if (loadProfilePromise) {
      await loadProfilePromise;
    }
    if (!isProfileDataLoaded.value) {
      console.warn('[GenStore] saveProfileData skipped: profile data has not finished loading');
      return;
    }
    try {
      const current = profileStore.currentProfile || 'Default';
      let payloadData: Record<string, any>;
      if (partialData && typeof partialData === 'object' && Object.keys(partialData).length > 0) {
        payloadData = { ...partialData };
      } else {
        const cleanParams = { ...params };
        delete cleanParams.image;
        delete cleanParams.mask;
        payloadData = { params: cleanParams };
      }
      await encryptedAxios({
        method: 'POST',
        url: '/api/profiles/data',
        data: {
          profile: current,
          data: payloadData
        }
      });
    } catch (err: any) {
      console.warn('[GenStore] Failed to save profile data to NAS:', err.message);
    }
  };

  const flushPendingSave = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!isProfileDataLoaded.value) return;
    const keys = Object.keys(pendingSaveData);
    if (keys.length === 0) return;
    const toSend = { ...pendingSaveData };
    pendingSaveData = {};
    await saveProfileData(toSend);
  };

  const cancelPendingSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingSaveData = {};
  };

  const saveProfileDataDebounced = (partialData?: Record<string, any>) => {
    if (!isProfileDataLoaded.value) return;
    if (partialData && typeof partialData === 'object') {
      Object.assign(pendingSaveData, partialData);
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPendingSave, 600);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      flushPendingSave();
    });
  }

  // 监听核心绘图参数变动，自动同步到活动存档（仅在数据加载完成后同步 params）
  watch(
    () => [
      params.prompt,
      params.negative_prompt,
      params.model,
      params.width,
      params.height,
      params.steps,
      params.sampler,
      params.scale,
      params.seed,
      params.noise_schedule,
      params.cfg_rescale,
      params.uncond_scale
    ],
    () => {
      if (!isProfileDataLoaded.value) return;
      const cleanParams = { ...params };
      delete cleanParams.image;
      delete cleanParams.mask;
      saveProfileDataDebounced({ params: cleanParams });
    }
  );

  const saveCustomCharacters = async (allowEmpty = false) => {
    await saveProfileData({ customCharacters: customCharacters.value, allowEmptyCharacters: allowEmpty });
  };

  const saveCustomStyles = async (allowEmpty = false) => {
    await saveProfileData({ customStyles: customStyles.value, allowEmptyStyles: allowEmpty });
  };

  const toggleCharacterFavorite = async (preset: any) => {
    preset.favorite = !preset.favorite;
    await saveProfileData({ customCharacters: customCharacters.value });
  };

  const toggleStyleFavorite = async (preset: any) => {
    preset.favorite = !preset.favorite;
    await saveProfileData({ customStyles: customStyles.value });
  };

  // 从 NAS 加载活动存档数据
  const loadProfileData = async (profileName?: string) => {
    const target = profileName || profileStore.currentProfile || 'Default';
    loadProfilePromise = (async () => {
      try {
        isLoadingHistory.value = true;
        const res = await encryptedAxios({
          method: 'GET',
          url: `/api/profiles/data?profile=${encodeURIComponent(target)}`
        });
        if (res.data && res.data.success) {
          const d = res.data.data || {};
          promptHistory.value = Array.isArray(d.promptHistory) ? d.promptHistory : [];
          savedPromptGroups.value = Array.isArray(d.savedPromptGroups) ? d.savedPromptGroups : [];
          customCharacters.value = Array.isArray(d.customCharacters) ? d.customCharacters.map((c: any) => ({ ...c, category: c.category || '自定义' })) : [];
          customStyles.value = Array.isArray(d.customStyles) ? d.customStyles : [];
          if (Array.isArray(d.history)) {
            history.value = d.history.map((item: any) => ({
              ...item,
              url: resolveApiUrl(item.url),
              isNew: false
            }));
            if (history.value.length > 0 && !currentImage.value) {
              currentImage.value = history.value[0];
            }
          }

          // 自动恢复上一次的绘图参数与设置
          if (d.params && typeof d.params === 'object' && Object.keys(d.params).length > 0) {
            useParams(d.params, true);
          } else if (history.value.length > 0 && history.value[0]?.params) {
            useParams(history.value[0].params, false);
          }
          isProfileDataLoaded.value = true;
        }
      } catch (err: any) {
        console.warn('[GenStore] Failed to load profile data:', err.message);
      } finally {
        isLoadingHistory.value = false;
        loadProfilePromise = null;
      }
    })();
    return loadProfilePromise;
  };

  const deletePromptHistory = (id: string) => {
    promptHistory.value = promptHistory.value.filter(p => p.id !== id);
    saveProfileDataDebounced({ promptHistory: promptHistory.value, allowEmptyPromptHistory: true });
  };

  const toggleFavoritePrompt = (id: string) => {
    const item = promptHistory.value.find(p => p.id === id);
    if (item) {
      item.isFavorite = !item.isFavorite;
      saveProfileDataDebounced({ promptHistory: promptHistory.value });
    }
  };

  const updatePromptNote = (id: string, note: string) => {
    const item = promptHistory.value.find(p => p.id === id);
    if (item) {
      item.note = note;
      saveProfileDataDebounced({ promptHistory: promptHistory.value });
    }
  };

  const updatePromptGroup = (id: string, group: string) => {
    const trimmed = group.trim();
    const item = promptHistory.value.find(p => p.id === id);
    if (item) {
      item.group = trimmed || undefined;
      if (trimmed && !savedPromptGroups.value.includes(trimmed)) {
        savedPromptGroups.value.push(trimmed);
      }
      saveProfileDataDebounced({ promptHistory: promptHistory.value, savedPromptGroups: savedPromptGroups.value });
    }
  };

  const pushGeneratedImage = async (generated: GeneratedImage) => {
    if (!history.value.some(h => h.id === generated.id)) {
      history.value.unshift(generated);
    }
    currentImage.value = generated;

    const current = profileStore.currentProfile || 'Default';
    if (typeof generated.url === 'string' && generated.url.startsWith('data:image/')) {
      try {
        const res = await encryptedAxios({
          method: 'POST',
          url: '/api/profiles/images/save',
          data: {
            profile: current,
            item: {
              id: generated.id,
              image: generated.url,
              params: generated.params,
              timestamp: generated.timestamp || Date.now()
            }
          }
        });
        if (res.data && res.data.success && res.data.url) {
          generated.url = resolveApiUrl(res.data.url);
        }
      } catch (err: any) {
        console.warn('[GenStore] Failed to save image to NAS disk:', err.message);
      }
    }

    const cleanParams = { ...params };
    delete cleanParams.image;
    delete cleanParams.mask;
    saveProfileDataDebounced({ params: cleanParams });
    if (tabSyncChannel) {
      try {
        tabSyncChannel.postMessage({ type: 'ADD_IMAGE', image: generated });
      } catch (e) {}
    }
  };

  const deleteHistory = async (id: string) => {
    const current = profileStore.currentProfile || 'Default';
    history.value = history.value.filter(i => i.id !== id);
    if (currentImage.value?.id === id) {
      currentImage.value = history.value.length > 0 ? history.value[0] : null;
    }
    try {
      await encryptedAxios({
        method: 'DELETE',
        url: `/api/profiles/images/${encodeURIComponent(id)}?profile=${encodeURIComponent(current)}`
      });
    } catch (err: any) {
      console.warn('[GenStore] Failed to delete image on NAS:', err.message);
    }
    if (tabSyncChannel) {
      try {
        tabSyncChannel.postMessage({ type: 'DELETE_IMAGE', id });
      } catch (e) {}
    }
  };

  const deleteBatchHistory = async (ids: string[]) => {
    if (!ids || ids.length === 0) return;
    const current = profileStore.currentProfile || 'Default';
    const idSet = new Set(ids);
    history.value = history.value.filter(i => !idSet.has(i.id));
    if (currentImage.value && idSet.has(currentImage.value.id)) {
      currentImage.value = history.value.length > 0 ? history.value[0] : null;
    }
    try {
      await encryptedAxios({
        method: 'POST',
        url: '/api/profiles/images/delete-batch',
        data: {
          profile: current,
          ids
        }
      });
    } catch (err: any) {
      console.warn('[GenStore] Failed to delete batch images on NAS:', err.message);
    }
    if (tabSyncChannel) {
      try {
        for (const id of ids) {
          tabSyncChannel.postMessage({ type: 'DELETE_IMAGE', id });
        }
      } catch (e) {}
    }
  };

  const clearHistory = async () => {
    const allIds = history.value.map(i => i.id);
    history.value = [];
    currentImage.value = null;
    if (allIds.length > 0) {
      await deleteBatchHistory(allIds);
    }
  };

  const clearFilteredHistory = async (idsToKeep: string[]) => {
    const idSet = new Set(idsToKeep);
    const toDelete = history.value.filter(i => !idSet.has(i.id)).map(i => i.id);
    if (toDelete.length > 0) {
      await deleteBatchHistory(toDelete);
    }
  };

  const addCharacter = () => {
    if (!params.characters) params.characters = [];
    const count = params.characters.length;
    let defaultX = 0.5;
    if (count === 0) defaultX = 0.35;
    else if (count === 1) defaultX = 0.65;
    else if (count === 2) defaultX = 0.5;

    params.characters.push({
      id: `char-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      prompt: '',
      uc: '',
      center: { x: defaultX, y: 0.5 },
      enabled: true
    });
  };

  const removeCharacter = (id: string) => {
    if (!params.characters) return;
    params.characters = params.characters.filter(c => c.id !== id);
  };

  const clearCharacters = () => {
    params.characters = [];
  };

  const resetAdvancedParams = () => {
    params.steps = 28;
    params.sampler = 'k_euler_ancestral';
    params.scale = 7.0;
    params.seed = -1;
    params.noise_schedule = 'karras';
    params.cfg_rescale = 0;
    params.uncond_scale = 0;
    params.skip_cfg_above_sigma = null;
    params.prefer_brownian = true;
    params.dynamic_thresholding = false;
    params.sm = false;
    params.sm_dyn = false;
    params.strength = 0.7;
    params.noise = 0.0;
    params.characters = [];
    params.use_coords = false;
    params.auto_quality_presets = true;
    params.transparent_bg = false;
  };

  const sendToInpaint = async (imgUrl: string, preserveMask = false) => {
    let base64 = imgUrl;
    if (base64.includes('base64,')) {
      base64 = base64.split('base64,')[1];
    } else if (base64.startsWith('http://') || base64.startsWith('https://') || base64.startsWith('/')) {
      try {
        const fullUrl = resolveApiUrl(base64);
        const res = await fetch(fullUrl);
        const blob = await res.blob();
        base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = (reader.result as string) || '';
            resolve(result.includes('base64,') ? result.split('base64,')[1] : result);
          };
          reader.readAsDataURL(blob);
        });
      } catch (err) {
        console.warn('[GenStore] Failed to fetch image as base64 for inpaint:', err);
      }
    }
    params.image = base64;
    if (!preserveMask) {
      params.mask = undefined;
    }

    // 同步检测图片真实尺寸并对齐至 64 整数倍，保证生图参数与涂鸦遮罩基准一致
    if (base64) {
      try {
        const img = new Image();
        const src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
        await new Promise<void>((resolve) => {
          img.onload = () => {
            const nw = img.naturalWidth || img.width;
            const nh = img.naturalHeight || img.height;
            if (nw > 0 && nh > 0) {
              params.width = Math.max(64, Math.round(nw / 64) * 64);
              params.height = Math.max(64, Math.round(nh / 64) * 64);
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = src;
        });
      } catch (e) {}
    }
  };

  const useParams = (p: GenerationParams | GeneratedImage | any, keepSeed = false) => {
    const targetParams = p?.params ? p.params : p;
    if (!targetParams) return;
    Object.assign(params, targetParams);
    if (!keepSeed) {
      params.seed = -1; // 默认还原为随机种子(-1)，防止复用参数时误锁死固定种子
    }
    if (params.characters) {
      params.characters = params.characters.map(c => ({
        ...c,
        id: c.id || `char-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      }));
    }
  };

  const usePrompt = (p: { prompt: string; negative_prompt?: string; characters?: CharacterPrompt[]; use_coords?: boolean }) => {
    params.prompt = p.prompt;
    if (p.negative_prompt !== undefined) {
      params.negative_prompt = p.negative_prompt;
    }
    if (p.characters) {
      params.characters = JSON.parse(JSON.stringify(p.characters));
      params.use_coords = p.use_coords ?? false;
    }
  };

  const generate = async () => {
    if (isGenerating.value) return;
    if (loadProfilePromise) {
      await loadProfilePromise;
    }
    error.value = '';
    isGenerating.value = true;
    startQueuePolling();

    const totalToGenerate = batchCount.value;
    batchTotal.value = totalToGenerate;
    batchCurrent.value = 0;

    try {
      for (let i = 0; i < totalToGenerate; i++) {
        batchCurrent.value = i + 1;
        await generateSingle();
      }
    } finally {
      isGenerating.value = false;
      stopQueuePolling();
      batchCurrent.value = 0;
      batchTotal.value = 1;
    }
  };

  const generateSingle = async () => {
    const seedToUse = params.seed === -1 ? Math.floor(Math.random() * 4294967295) : params.seed;
    const isV4OrV5 = params.model.includes('-4') || params.model.includes('-5') || params.model.includes('v4') || params.model.includes('v5');
    const isV5 = params.model.includes('diffusion-5') || params.model.includes('v5');

    let action: 'generate' | 'img2img' | 'infill' = 'generate';
    if (params.mask && params.image) {
      action = 'infill';
    } else if (params.image) {
      action = 'img2img';
    }

    let modelToUse = params.model;
    if (action === 'infill') {
      if (!modelToUse.endsWith('-inpainting')) {
        modelToUse = `${modelToUse}-inpainting`;
      }
    }

    let parameters: any = {
      width: params.width,
      height: params.height,
      steps: params.steps,
      sampler: params.sampler,
      scale: params.scale,
      seed: seedToUse,
      n_samples: 1,
      dynamic_thresholding: params.dynamic_thresholding,
      noise_schedule: params.noise_schedule || 'karras',
      cfg_rescale: params.cfg_rescale ?? 0,
      uncond_scale: params.uncond_scale ?? 0,
      prefer_brownian: params.prefer_brownian ?? true,
    };

    if (params.image) {
      let rawImage = params.image;
      if (rawImage.includes('base64,')) {
        rawImage = rawImage.split('base64,')[1];
      }
      parameters.image = rawImage;
      parameters.strength = params.strength ?? 0.7;
      parameters.noise = params.noise ?? 0.0;
      parameters.extra_noise_seed = seedToUse;
      if (params.mask) {
        let rawMask = params.mask;
        if (rawMask.includes('base64,')) {
          rawMask = rawMask.split('base64,')[1];
        }
        parameters.mask = rawMask;
      }
    }

    let finalPrompt = (params.prompt || '').trim();
    let finalNegPrompt = (params.negative_prompt || '').trim();

    if (params.transparent_bg && !finalPrompt.includes('transparent background')) {
      if (finalPrompt && !finalPrompt.endsWith(',')) {
        finalPrompt += ', ';
      }
      finalPrompt += 'transparent background';
    }

    if (params.auto_quality_presets !== false) {
      if (finalPrompt && !finalPrompt.includes('very aesthetic') && !finalPrompt.includes('absurdres')) {
        finalPrompt = `${finalPrompt}${OFFICIAL_V5_POS_PRESET}`;
      } else if (!finalPrompt) {
        finalPrompt = OFFICIAL_V5_POS_PRESET.replace(/^,\s*/, '');
      }

      const presetTags = OFFICIAL_V5_NEG_PRESET.split(',').map(t => t.trim()).filter(Boolean);
      const userTags = finalNegPrompt.split(',').map(t => t.trim()).filter(Boolean);
      const presetSet = new Set(presetTags);
      
      const customUserTags = userTags.filter(t => !presetSet.has(t));
      finalNegPrompt = [...presetTags, ...customUserTags].join(', ');
    }

    if (isV4OrV5) {
      parameters.use_coords = false;
      parameters.noise_schedule = params.noise_schedule || "karras";

      if (params.skip_cfg_above_sigma !== undefined && params.skip_cfg_above_sigma !== null && params.skip_cfg_above_sigma > 0) {
        parameters.skip_cfg_above_sigma = params.skip_cfg_above_sigma;
      } else if (params.skip_cfg_above_sigma === 0 || params.skip_cfg_above_sigma === null) {
        parameters.skip_cfg_above_sigma = null;
      } else {
        parameters.skip_cfg_above_sigma = isV5 ? null : 19.343056794463642;
      }

      parameters.cfg_sched_eligibility = "enable_for_post_summer_samplers";
      parameters.prefer_brownian = params.prefer_brownian ?? true;
      parameters.deliberate_euler_ancestral_bug = false;
      parameters.uncond_per_vibe = true;
      parameters.wonky_vibe_correlation = true;
      parameters.legacy_v3_extend = false;
      parameters.controlnet_strength = 1;
      parameters.cfg_rescale = params.cfg_rescale ?? 0;
      parameters.uncond_scale = params.uncond_scale ?? 0;

      parameters.uc = finalNegPrompt;
      parameters.negative_prompt = finalNegPrompt;
      parameters.tag_hint_uc_preset = finalNegPrompt.length > 50 ? 2 : (finalNegPrompt ? 1 : 0);
      parameters.tag_hint_qt = 1;
      parameters.version = 1;

      const activeChars = (params.characters || []).filter(c => c.enabled !== false && c.prompt && c.prompt.trim());
      const charCaptions = activeChars.map(c => ({
        char_caption: c.prompt.trim(),
        centers: [
          {
            x: Math.max(0, Math.min(1, typeof c.center?.x === 'number' ? c.center.x : 0.5)),
            y: Math.max(0, Math.min(1, typeof c.center?.y === 'number' ? c.center.y : 0.5))
          }
        ]
      }));

      const charUcCaptions = activeChars.map(c => ({
        char_caption: (c.uc || '').trim(),
        centers: [
          {
            x: Math.max(0, Math.min(1, typeof c.center?.x === 'number' ? c.center.x : 0.5)),
            y: Math.max(0, Math.min(1, typeof c.center?.y === 'number' ? c.center.y : 0.5))
          }
        ]
      }));

      const useCoords = params.use_coords === true;

      parameters.v4_prompt = {
        caption: {
          base_caption: finalPrompt,
          char_captions: charCaptions
        },
        use_coords: useCoords,
        use_order: true,
        legacy_uc: false
      };
      parameters.v4_negative_prompt = {
        caption: {
          base_caption: finalNegPrompt,
          char_captions: charUcCaptions
        },
        use_coords: useCoords,
        use_order: false,
        legacy_uc: false
      };

      if (action === 'infill') {
        parameters.params_version = 4;
        parameters.ucPresetId = "heavy";
        parameters.qualityPresetId = "standard";
        parameters.autoSmea = false;
        parameters.legacy = false;
        parameters.add_original_image = true;
        parameters.cfg_rescale = 0;
      } else {
        parameters.params_version = 3;
        parameters.qualityToggle = true;
      }
    } else {
      parameters.negative_prompt = finalNegPrompt;
      parameters.uc = finalNegPrompt;
      parameters.sm = params.sm;
      parameters.sm_dyn = params.sm_dyn;
      if (action === 'infill') {
        parameters.add_original_image = true;
      }
    }

    const payload = {
      input: finalPrompt,
      model: modelToUse,
      action,
      parameters
    };

    const baseHeaders: Record<string, string> = {
      'x-profile': profileStore.currentProfile || 'Default'
    };
    if (authStore.token) {
      baseHeaders['Authorization'] = authStore.token.startsWith('Bearer ') ? authStore.token : `Bearer ${authStore.token}`;
    }
    if (authStore.siteAccessKey) {
      baseHeaders['x-access-key'] = authStore.siteAccessKey;
    }

    try {
      if (params.enable_stream) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        let activeBlobUrl: string | null = null;

        try {
          const fetchHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            ...baseHeaders
          };

          const response = await encryptedFetchStream('/api/generate-image-stream', {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            let errMsg = '流式生成失败';
            try {
              const errData = await response.json();
              errMsg = errData.message || errData.error || (typeof errData === 'object' ? JSON.stringify(errData) : String(errData));
            } catch {
              try {
                const text = await response.text();
                if (text) errMsg = text;
              } catch {}
            }
            throw new Error(errMsg);
          }

          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let streamResultSaved = false;
          let lastRenderTime = 0;
          let lastBase64: string | null = null;
          const THROTTLE_INTERVAL_MS = 125;

          const updateStreamPreviewBlob = (b64Data: string) => {
            try {
              const binStr = atob(b64Data);
              const len = binStr.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binStr.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: 'image/png' });
              const newUrl = URL.createObjectURL(blob);
              if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);
              activeBlobUrl = newUrl;
              streamPreviewUrl.value = newUrl;
            } catch (e) {
              streamPreviewUrl.value = `data:image/png;base64,${b64Data}`;
            }
          };

          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              let newlineIdx = buffer.indexOf('\n');
              while (newlineIdx !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                newlineIdx = buffer.indexOf('\n');

                if (!line.startsWith('data:')) continue;
                const dataStr = line.slice(5).trim();
                if (!dataStr) continue;

                try {
                  const parsed = JSON.parse(dataStr);
                  const rawErr = parsed.error || (parsed.message && !parsed.ptr && !parsed.b64 && !parsed.image && !parsed.document ? parsed.message : null);
                  if (rawErr) {
                    const errMsg = typeof rawErr === 'object' ? (rawErr.message || rawErr.error || JSON.stringify(rawErr)) : String(rawErr);
                    throw new Error(errMsg);
                  }

                  const eventType = parsed.event_type || parsed.event;

                  // 智能提取 base64
                  let b64 = parsed.document || parsed.b64 || parsed.image || parsed.ptr;
                  if (!b64) {
                    for (const key in parsed) {
                      if (typeof parsed[key] === 'string' && parsed[key].length > 500) {
                        b64 = parsed[key];
                        break;
                      }
                    }
                  }

                  if (b64) {
                    if (b64.startsWith('UEsDB')) {
                      const zip = new JSZip();
                      const loadedZip = await zip.loadAsync(b64, { base64: true });
                      const files = Object.keys(loadedZip.files);
                      if (files.length > 0) {
                        const file = loadedZip.files[files[0]];
                        b64 = await file.async('base64');
                      }
                    }

                    lastBase64 = b64;

                    const isFinal = eventType === 'final' || eventType === 'done' || parsed.success === true;
                    if (isFinal) {
                      const finalUrl = `data:image/png;base64,${b64}`;
                      const generated: GeneratedImage = {
                        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        url: finalUrl,
                        params: JSON.parse(JSON.stringify({ ...params, seed: seedToUse })),
                        timestamp: Date.now(),
                        isNew: batchTotal.value > 1
                      };
                      pushGeneratedImage(generated);
                      if (activeBlobUrl) {
                        URL.revokeObjectURL(activeBlobUrl);
                        activeBlobUrl = null;
                      }
                      streamPreviewUrl.value = null;
                      streamResultSaved = true;
                    } else {
                      if (enableStreamThrottle.value) {
                        const now = performance.now();
                        if (now - lastRenderTime < THROTTLE_INTERVAL_MS) continue;
                        lastRenderTime = now;
                      }
                      updateStreamPreviewBlob(b64);
                    }
                  } else if (eventType === 'final' || eventType === 'done' || parsed.success === true) {
                    if (parsed.item || parsed.url) {
                      const finalItem = parsed.item || {
                        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        url: parsed.url,
                        params: JSON.parse(JSON.stringify({ ...params, seed: seedToUse })),
                        timestamp: Date.now(),
                        isNew: batchTotal.value > 1
                      };
                      pushGeneratedImage(finalItem);
                      if (activeBlobUrl) {
                        URL.revokeObjectURL(activeBlobUrl);
                        activeBlobUrl = null;
                      }
                      streamPreviewUrl.value = null;
                      streamResultSaved = true;
                    } else if (lastBase64) {
                      const finalUrl = `data:image/png;base64,${lastBase64}`;
                      const generated: GeneratedImage = {
                        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        url: finalUrl,
                        params: JSON.parse(JSON.stringify({ ...params, seed: seedToUse })),
                        timestamp: Date.now(),
                        isNew: batchTotal.value > 1
                      };
                      pushGeneratedImage(generated);
                      if (activeBlobUrl) {
                        URL.revokeObjectURL(activeBlobUrl);
                        activeBlobUrl = null;
                      }
                      streamPreviewUrl.value = null;
                      streamResultSaved = true;
                    }
                  }
                } catch (e: any) {
                  if (e.message && !e.message.includes('JSON')) {
                    throw e;
                  }
                  console.warn('Failed to parse stream chunk', e);
                }
              }
            }
          }

          if (!streamResultSaved && lastBase64) {
            const finalUrl = `data:image/png;base64,${lastBase64}`;
            const generated: GeneratedImage = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              url: finalUrl,
              params: JSON.parse(JSON.stringify({ ...params, seed: seedToUse })),
              timestamp: Date.now(),
              isNew: batchTotal.value > 1
            };
            pushGeneratedImage(generated);
            streamResultSaved = true;
          }

          if (!streamResultSaved) {
            throw new Error('流式生成结束，但未收到有效图像数据。请查看后台运行日志以排查原因。');
          }
        } finally {
          clearTimeout(timeoutId);
          if (activeBlobUrl) {
            URL.revokeObjectURL(activeBlobUrl);
            activeBlobUrl = null;
          }
          streamPreviewUrl.value = null;
        }
      } else {
        // 常规生图
        const fetchHeaders: Record<string, string> = {
          'Accept': 'application/zip',
          ...baseHeaders
        };

        const res = await encryptedAxios({
          method: 'POST',
          url: '/api/generate-image',
          data: payload,
          headers: fetchHeaders,
          responseType: 'arraybuffer'
        });

        const zip = new JSZip();
        const loadedZip = await zip.loadAsync(res.data);
        const files = Object.keys(loadedZip.files);
        if (files.length > 0) {
          const file = loadedZip.files[files[0]];
          const base64Data = await file.async('base64');
          const dataUrl = `data:image/png;base64,${base64Data}`;
          const generated: GeneratedImage = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            url: dataUrl,
            params: JSON.parse(JSON.stringify({ ...params, seed: seedToUse })),
            timestamp: Date.now(),
            isNew: batchTotal.value > 1
          };
          pushGeneratedImage(generated);
        } else {
          throw new Error('未在返回的压缩包中找到图像文件');
        }
      }

      // 记录提示词历史
      if (params.prompt.trim()) {
        const charStr = JSON.stringify(params.characters || []);
        const existingIdx = promptHistory.value.findIndex(p => 
          p.prompt === params.prompt && 
          p.negative_prompt === params.negative_prompt &&
          JSON.stringify(p.characters || []) === charStr
        );
        let preservedNote = undefined;
        let preservedFav = false;
        let preservedGroup = undefined;
        let preservedId = Date.now().toString();

        if (existingIdx !== -1) {
          const existing = promptHistory.value[existingIdx];
          preservedNote = existing.note;
          preservedFav = !!existing.isFavorite;
          preservedGroup = existing.group;
          preservedId = existing.id;
          promptHistory.value.splice(existingIdx, 1);
        }

        promptHistory.value.unshift({
          id: preservedId,
          prompt: params.prompt,
          negative_prompt: params.negative_prompt,
          timestamp: Date.now(),
          characters: params.characters && params.characters.length > 0 ? JSON.parse(JSON.stringify(params.characters)) : undefined,
          use_coords: params.use_coords,
          note: preservedNote,
          isFavorite: preservedFav,
          group: preservedGroup
        });

        if (promptHistory.value.length > 300) {
          promptHistory.value = promptHistory.value.slice(0, 300);
        }
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        const cleanParams = { ...params };
        delete cleanParams.image;
        delete cleanParams.mask;
        await saveProfileData({
          params: cleanParams,
          promptHistory: promptHistory.value,
          savedPromptGroups: savedPromptGroups.value
        });
      }

      try {
        await authStore.fetchUserData();
      } catch (e) {}
    } catch (e: any) {
      console.error('Generation failed:', e);
      let rawMsg = '';
      if (e.response && e.response.data) {
        try {
          let data = e.response.data;
          if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            const text = new TextDecoder().decode(new Uint8Array(data));
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          if (typeof data === 'object' && data !== null) {
            rawMsg = data.message || data.error || JSON.stringify(data);
          } else {
            rawMsg = String(data);
          }
        } catch {
          rawMsg = '生成失败，网络异常或服务不可用';
        }
      } else {
        rawMsg = e.message || '生成失败';
      }

      if (typeof rawMsg === 'string' && rawMsg.startsWith('{') && rawMsg.includes('"message"')) {
        try {
          const inner = JSON.parse(rawMsg);
          if (inner.message) rawMsg = inner.message;
        } catch {}
      }

      error.value = rawMsg || '生成失败，请检查设置或服务状态';
      throw e;
    }
  };

  const upscaleImage = async (options: {
    image: string;
    width: number;
    height: number;
    scale: 2 | 4;
    originalPrompt?: string;
    originalParams?: any;
  }): Promise<GeneratedImage> => {
    isUpscaling.value = true;
    error.value = '';

    try {
      const headers: Record<string, string> = {
        'x-profile': profileStore.currentProfile || 'Default'
      };
      if (authStore.token) {
        headers['Authorization'] = authStore.token.startsWith('Bearer ') ? authStore.token : `Bearer ${authStore.token}`;
      }
      if (authStore.siteAccessKey) {
        headers['x-access-key'] = authStore.siteAccessKey;
      }

      const modelToUse = options.originalParams?.model || params.model || 'nai-diffusion-5-full';

      let rawImage = options.image;
      if (rawImage.startsWith('blob:')) {
        try {
          const blobRes = await fetch(rawImage);
          const blobData = await blobRes.blob();
          rawImage = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = (reader.result as string) || '';
              resolve(result.includes('base64,') ? result.split('base64,')[1] : result);
            };
            reader.readAsDataURL(blobData);
          });
        } catch (blobErr) {
          console.warn('[GenStore] Failed to resolve blob URL to base64 for upscale:', blobErr);
        }
      } else if (rawImage.includes('base64,')) {
        rawImage = rawImage.split('base64,')[1];
      }

      const res = await encryptedAxios({
        method: 'POST',
        url: '/api/upscale',
        data: {
          image: rawImage,
          width: options.width,
          height: options.height,
          scale: options.scale,
          model: modelToUse,
          profile: profileStore.currentProfile || 'Default',
          originalPrompt: options.originalPrompt,
          originalParams: options.originalParams
        },
        headers
      });

      let generated: GeneratedImage;
      if (res.data && res.data.success && res.data.item) {
        generated = res.data.item;
        generated.url = resolveApiUrl(generated.url);
      } else if (res.data && res.data.url) {
        const baseParams = options.originalParams ? JSON.parse(JSON.stringify(options.originalParams)) : { ...params };
        baseParams.width = options.width * options.scale;
        baseParams.height = options.height * options.scale;
        baseParams.is_upscaled = true;
        if (options.originalPrompt) baseParams.prompt = options.originalPrompt;

        generated = {
          id: res.data.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          url: resolveApiUrl(res.data.url),
          params: baseParams,
          timestamp: Date.now(),
          isNew: false,
          isUpscaled: true
        };
      } else {
        const serverError = res.data?.error || res.data?.errmsg || res.data?.message;
        throw new Error(serverError || '超分放大返回数据无效');
      }

      pushGeneratedImage(generated);
      try {
        await authStore.fetchUserData();
      } catch (e) {}

      return generated;
    } catch (err: any) {
      let errMsg = err.message || '超分放大失败';
      if (err.response?.data?.error) errMsg = err.response.data.error;
      else if (err.response?.data?.errmsg) errMsg = err.response.data.errmsg;
      error.value = errMsg;
      throw new Error(errMsg);
    } finally {
      isUpscaling.value = false;
    }
  };

  return {
    params,
    history,
    promptHistory,
    savedPromptGroups,
    customCharacters,
    customStyles,
    enableTagSuggestions,
    enableStreamThrottle,
    isGenerating,
    queueInfo,
    batchCount,
    batchTotal,
    batchCurrent,
    streamPreviewUrl,
    error,
    currentImage,
    generate,
    useParams,
    usePrompt,
    sendToInpaint,
    isUpscaling,
    upscaleImage,
    deletePromptHistory,
    toggleFavoritePrompt,
    updatePromptNote,
    updatePromptGroup,
    deleteHistory,
    deleteBatchHistory,
    clearHistory,
    clearFilteredHistory,
    resetAdvancedParams,
    addCharacter,
    removeCharacter,
    clearCharacters,
    isLoadingHistory,
    isProfileDataLoaded,
    loadProfileData,
    saveProfileData,
    saveProfileDataDebounced,
    flushPendingSave,
    cancelPendingSave,
    saveCustomCharacters,
    saveCustomStyles,
    toggleCharacterFavorite,
    toggleStyleFavorite
  };
}, {
  persist: {
    pick: ['params', 'enableTagSuggestions', 'enableStreamThrottle'],
    storage: localStorage,
    serializer: {
      serialize: (state: any) => {
        try {
          const copy = { ...state };
          if (copy.params) {
            copy.params = { ...copy.params, image: undefined, mask: undefined };
          }
          return JSON.stringify(copy);
        } catch {
          return '';
        }
      },
      deserialize: (str: string) => {
        try {
          return JSON.parse(str);
        } catch {
          return {};
        }
      }
    }
  }
});
