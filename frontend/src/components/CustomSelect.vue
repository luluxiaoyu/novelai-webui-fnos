<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { ChevronDown, Check } from 'lucide-vue-next';

export interface SelectOption {
  value: string | number;
  label: string;
  sublabel?: string;
  badge?: string;
  badgeType?: 'success' | 'warning' | 'error' | 'default';
  icon?: any;
  disabled?: boolean;
}

const props = withDefaults(defineProps<{
  modelValue: string | number;
  options: (SelectOption | { value: string | number; label: string })[];
  variant?: 'default' | 'ghost';
  placement?: 'left' | 'right';
  size?: 'sm' | 'lg';
  placeholder?: string;
  disabled?: boolean;
}>(), {
  size: 'sm',
  placeholder: '请选择...'
});

const emit = defineEmits(['update:modelValue', 'change']);

const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

const currentOption = computed(() => {
  return (props.options as SelectOption[]).find(o => o.value === props.modelValue) || null;
});

const closeDropdown = (e: MouseEvent) => {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false;
  }
};

onMounted(() => document.addEventListener('click', closeDropdown));
onUnmounted(() => document.removeEventListener('click', closeDropdown));

const selectOption = (opt: SelectOption | { value: string | number; label: string }) => {
  if ('disabled' in opt && opt.disabled) return;
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  isOpen.value = false;
};
</script>

<template>
  <div 
    class="relative text-left" 
    :class="variant === 'ghost' ? 'inline-block' : 'block w-full'" 
    ref="dropdownRef"
  >
    <button 
      type="button" 
      @click="!disabled && (isOpen = !isOpen)"
      :disabled="disabled"
      :class="[
        variant === 'ghost' 
          ? 'text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 flex items-center gap-1 font-medium' 
          : 'w-full flex justify-between items-center bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors h-full text-gray-900 dark:text-gray-100',
        variant !== 'ghost' && size === 'sm' ? 'rounded-xl px-3 py-2 text-xs sm:text-sm' : '',
        variant !== 'ghost' && size === 'lg' ? 'rounded-xl px-3.5 py-3 text-sm' : '',
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
      ]"
    >
      <slot name="trigger" :selected="currentOption">
        <div class="flex items-center gap-2 min-w-0 flex-1 text-left mr-2">
          <component 
            v-if="currentOption?.icon" 
            :is="currentOption.icon" 
            class="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" 
          />
          <span class="truncate font-medium">
            {{ currentOption?.label || (modelValue ? String(modelValue) : placeholder) }}
          </span>
          <span 
            v-if="currentOption?.badge" 
            class="text-[10px] px-1.5 py-0.5 rounded font-normal shrink-0"
            :class="{
              'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60': currentOption.badgeType === 'success',
              'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60': currentOption.badgeType === 'warning',
              'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60': currentOption.badgeType === 'error',
              'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300': !currentOption.badgeType || currentOption.badgeType === 'default'
            }"
          >
            {{ currentOption.badge }}
          </span>
        </div>
      </slot>
      <ChevronDown 
        class="w-4 h-4 opacity-70 shrink-0 transition-transform duration-150" 
        :class="{ 'rotate-180': isOpen }" 
      />
    </button>

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
        class="absolute z-50 mt-1.5 max-h-64 overflow-y-auto w-full min-w-[200px] origin-top rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-xl ring-1 ring-black/5 dark:ring-white/10 focus:outline-none custom-scrollbar"
        :class="placement === 'right' ? 'right-0' : 'left-0'"
      >
        <div class="py-1">
          <button
            v-for="option in options"
            :key="option.value"
            @click="selectOption(option)"
            :disabled="'disabled' in option && option.disabled"
            type="button"
            class="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer flex items-center justify-between gap-2"
            :class="[
              option.value === modelValue 
                ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold' 
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/70',
              'disabled' in option && option.disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''
            ]"
          >
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <component 
                v-if="'icon' in option && option.icon" 
                :is="option.icon" 
                class="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-gray-500" 
              />
              <div class="flex flex-col min-w-0">
                <span class="truncate">{{ option.label }}</span>
                <span 
                  v-if="'sublabel' in option && option.sublabel" 
                  class="text-[10px] text-gray-400 dark:text-gray-500 font-mono truncate"
                >
                  {{ option.sublabel }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <span 
                v-if="'badge' in option && option.badge" 
                class="text-[10px] px-1.5 py-0.5 rounded font-normal"
                :class="{
                  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60': option.badgeType === 'success',
                  'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60': option.badgeType === 'warning',
                  'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60': option.badgeType === 'error',
                  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300': !option.badgeType || option.badgeType === 'default'
                }"
              >
                {{ option.badge }}
              </span>
              <Check v-if="option.value === modelValue" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
            </div>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
