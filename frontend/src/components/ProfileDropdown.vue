<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useProfileStore } from '../stores/profile';
import { useGenerationStore } from '../stores/generation';
import { FolderHeart, ChevronDown, Check, Settings, Loader2 } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'manage'): void;
}>();

const profileStore = useProfileStore();
const genStore = useGenerationStore();
const isOpen = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const dropdownMenuRef = ref<HTMLElement | null>(null);
const dropdownStyle = ref<{ top: string; left: string }>({ top: '0px', left: '0px' });

const updatePosition = () => {
  if (!triggerRef.value) return;
  const rect = triggerRef.value.getBoundingClientRect();
  const menuWidth = 192; // w-48 = 12rem = 192px
  let left = rect.left;
  if (left + menuWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuWidth - 8);
  }
  dropdownStyle.value = {
    top: `${Math.round(rect.bottom + 6)}px`,
    left: `${Math.round(left)}px`,
  };
};

const toggleDropdown = async () => {
  if (isOpen.value) {
    isOpen.value = false;
  } else {
    updatePosition();
    isOpen.value = true;
    await nextTick();
    updatePosition();
  }
};

const handleSelect = (p: string) => {
  isOpen.value = false;
  profileStore.switchProfile(p);
};

const handleManage = () => {
  isOpen.value = false;
  emit('manage');
};

const handleClickOutside = (e: MouseEvent) => {
  if (!isOpen.value) return;
  const target = e.target as Node;
  if (
    triggerRef.value && !triggerRef.value.contains(target) &&
    dropdownMenuRef.value && !dropdownMenuRef.value.contains(target)
  ) {
    isOpen.value = false;
  }
};

const handleScrollOrResize = () => {
  if (isOpen.value) {
    updatePosition();
  }
};

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  window.addEventListener('resize', handleScrollOrResize);
  window.addEventListener('scroll', handleScrollOrResize, true);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  window.removeEventListener('resize', handleScrollOrResize);
  window.removeEventListener('scroll', handleScrollOrResize, true);
});
</script>

<template>
  <div class="relative inline-block text-left shrink-0" ref="triggerRef">
    <button 
      type="button"
      @click="toggleDropdown"
      class="flex items-center gap-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700/80 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 transition cursor-pointer select-none text-xs sm:text-sm font-medium text-gray-800 dark:text-gray-200"
      :title="profileStore.isLoading || genStore.isLoadingHistory ? '正在读取或切换 NAS 存档数据...' : '切换当前 NAS 本地存档'"
    >
      <Loader2 v-if="profileStore.isLoading || genStore.isLoadingHistory" class="w-4 h-4 text-blue-500 shrink-0 animate-spin" />
      <FolderHeart v-else class="w-4 h-4 text-blue-500 shrink-0" />
      <span class="max-w-[120px] truncate">{{ profileStore.currentProfile }}</span>
      <ChevronDown class="w-3.5 h-3.5 text-gray-400 transition-transform duration-150" :class="{ 'rotate-180': isOpen }" />
    </button>

    <Teleport to="body">
      <Transition
        enter-active-class="transition ease-out duration-100"
        enter-from-class="transform opacity-0 scale-95"
        enter-to-class="transform opacity-100 scale-100"
        leave-active-class="transition ease-in duration-75"
        leave-from-class="transform opacity-100 scale-100"
        leave-to-class="transform opacity-0 scale-95"
      >
        <div 
          v-if="isOpen"
          ref="dropdownMenuRef"
          :style="dropdownStyle"
          class="fixed z-[9999] w-48 origin-top-left rounded-xl bg-white dark:bg-gray-800 shadow-2xl ring-1 ring-black/10 dark:ring-white/10 p-1 divide-y divide-gray-100 dark:divide-gray-700/60"
        >
          <div class="py-1 max-h-56 overflow-y-auto custom-scrollbar">
            <button
              v-for="p in profileStore.profiles"
              :key="p"
              @click="handleSelect(p)"
              class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors"
              :class="p === profileStore.currentProfile ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'"
            >
              <span class="truncate">{{ p }}</span>
              <Check v-if="p === profileStore.currentProfile" class="w-3.5 h-3.5 text-blue-500 shrink-0 ml-1" />
            </button>
          </div>
          <div class="pt-1">
            <button
              @click="handleManage"
              class="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            >
              <Settings class="w-3.5 h-3.5" />
              <span>管理 / 新建存档...</span>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
