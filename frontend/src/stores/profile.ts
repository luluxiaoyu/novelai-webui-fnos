import { defineStore } from 'pinia';
import { ref } from 'vue';
import { encryptedAxios } from '../utils/api';
import { useGenerationStore } from './generation';

export const useProfileStore = defineStore('profile', () => {
  const currentProfile = ref<string>('Default');
  const profiles = ref<string[]>(['Default']);
  const isLoading = ref<boolean>(false);

  const fetchProfiles = async () => {
    try {
      isLoading.value = true;
      const res = await encryptedAxios({
        method: 'GET',
        url: '/api/profiles'
      });
      if (res.data && res.data.success) {
        profiles.value = res.data.profiles || ['Default'];
        if (res.data.activeProfile) {
          currentProfile.value = res.data.activeProfile;
        }
      }
    } catch (err: any) {
      console.warn('[ProfileStore] Failed to fetch profiles:', err.message);
    } finally {
      isLoading.value = false;
    }
  };

  const switchProfile = async (targetProfile: string) => {
    if (!targetProfile || targetProfile === currentProfile.value) return;
    try {
      isLoading.value = true;
      const res = await encryptedAxios({
        method: 'POST',
        url: '/api/profiles/switch',
        data: { profile: targetProfile }
      });
      if (res.data && res.data.success) {
        currentProfile.value = targetProfile;
        const genStore = useGenerationStore();
        await genStore.loadProfileData(targetProfile);
      }
    } catch (err: any) {
      console.error('[ProfileStore] Failed to switch profile:', err);
      alert(`切换存档失败: ${err.response?.data?.error || err.message}`);
    } finally {
      isLoading.value = false;
    }
  };

  const createProfile = async (name: string): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    try {
      isLoading.value = true;
      const res = await encryptedAxios({
        method: 'POST',
        url: '/api/profiles',
        data: { name: trimmed }
      });
      if (res.data && res.data.success) {
        if (!profiles.value.includes(trimmed)) {
          profiles.value.push(trimmed);
        }
        await switchProfile(trimmed);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('[ProfileStore] Failed to create profile:', err);
      alert(`创建存档失败: ${err.response?.data?.error || err.message}`);
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const deleteProfile = async (name: string): Promise<boolean> => {
    if (name === 'Default') {
      alert('不能删除 Default 默认存档！');
      return false;
    }
    try {
      isLoading.value = true;
      const res = await encryptedAxios({
        method: 'DELETE',
        url: `/api/profiles/${encodeURIComponent(name)}`
      });
      if (res.data && res.data.success) {
        profiles.value = profiles.value.filter(p => p !== name);
        if (currentProfile.value === name) {
          await switchProfile('Default');
        }
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('[ProfileStore] Failed to delete profile:', err);
      alert(`删除存档失败: ${err.response?.data?.error || err.message}`);
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const renameProfile = async (oldName: string, newName: string): Promise<boolean> => {
    if (oldName === 'Default') {
      alert('不能重命名 Default 默认存档！');
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed) return false;
    try {
      isLoading.value = true;
      const res = await encryptedAxios({
        method: 'POST',
        url: '/api/profiles/rename',
        data: { oldName, newName: trimmed }
      });
      if (res.data && res.data.success) {
        const idx = profiles.value.indexOf(oldName);
        if (idx !== -1) {
          profiles.value[idx] = trimmed;
        }
        if (currentProfile.value === oldName) {
          currentProfile.value = trimmed;
        }
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('[ProfileStore] Failed to rename profile:', err);
      alert(`重命名存档失败: ${err.response?.data?.error || err.message}`);
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  return {
    currentProfile,
    profiles,
    isLoading,
    fetchProfiles,
    switchProfile,
    createProfile,
    deleteProfile,
    renameProfile
  };
});
