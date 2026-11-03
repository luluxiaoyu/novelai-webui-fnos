const fs = require('fs');
const path = require('path');
const { getConfig, updateConfig } = require('./configManager');

function getStoragePath() {
  const cfg = getConfig();
  return cfg.storagePath || path.resolve(__dirname, '../../var/data');
}

function getProfilesDir() {
  const storagePath = getStoragePath();
  const dir = path.join(storagePath, 'profiles');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeProfileName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().replace(/[/\\?%*:|"<>.]/g, '');
}

function getProfileDir(profileName) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profilesDir = getProfilesDir();
  const targetDir = path.join(profilesDir, sanitized);
  const imagesDir = path.join(targetDir, 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }
  return targetDir;
}

function getProfileDataFile(profileName) {
  const profileDir = getProfileDir(profileName);
  return path.join(profileDir, 'data.json');
}

function getInitialData() {
  return {
    promptHistory: [],
    savedPromptGroups: [],
    customCharacters: [],
    customStyles: [],
    history: []
  };
}

function listProfiles() {
  const profilesDir = getProfilesDir();
  const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  const profiles = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => !name.startsWith('.'));

  if (!profiles.includes('Default')) {
    createProfile('Default');
    profiles.unshift('Default');
  }

  const cfg = getConfig();
  let activeProfile = cfg.activeProfile || 'Default';
  if (!profiles.includes(activeProfile)) {
    activeProfile = profiles[0] || 'Default';
    updateConfig({ activeProfile });
  }

  return {
    profiles,
    activeProfile
  };
}

function createProfile(name) {
  const sanitized = sanitizeProfileName(name);
  if (!sanitized) {
    throw new Error('无效的存档名称');
  }
  const profilesDir = getProfilesDir();
  const targetDir = path.join(profilesDir, sanitized);
  if (fs.existsSync(targetDir)) {
    throw new Error(`存档 "${sanitized}" 已存在`);
  }

  fs.mkdirSync(path.join(targetDir, 'images'), { recursive: true });
  const dataFile = path.join(targetDir, 'data.json');
  fs.writeFileSync(dataFile, JSON.stringify(getInitialData(), null, 2), 'utf8');
  return sanitized;
}

function deleteProfile(name) {
  const sanitized = sanitizeProfileName(name);
  if (sanitized === 'Default') {
    throw new Error('Default 存档受保护，不能删除');
  }
  const profilesDir = getProfilesDir();
  const targetDir = path.join(profilesDir, sanitized);
  if (!fs.existsSync(targetDir)) {
    return false;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });

  const cfg = getConfig();
  if (cfg.activeProfile === sanitized) {
    updateConfig({ activeProfile: 'Default' });
  }
  return true;
}

function renameProfile(oldName, newName) {
  const oldSanitized = sanitizeProfileName(oldName);
  const newSanitized = sanitizeProfileName(newName);
  if (oldSanitized === 'Default') {
    throw new Error('Default 存档受保护，不能重命名');
  }
  if (!newSanitized) {
    throw new Error('无效的新存档名称');
  }

  const profilesDir = getProfilesDir();
  const oldDir = path.join(profilesDir, oldSanitized);
  const newDir = path.join(profilesDir, newSanitized);

  if (!fs.existsSync(oldDir)) {
    throw new Error(`存档 "${oldSanitized}" 不存在`);
  }
  if (fs.existsSync(newDir)) {
    throw new Error(`存档 "${newSanitized}" 已存在`);
  }

  fs.renameSync(oldDir, newDir);

  const cfg = getConfig();
  if (cfg.activeProfile === oldSanitized) {
    updateConfig({ activeProfile: newSanitized });
  }
  return true;
}

function switchProfile(name) {
  const sanitized = sanitizeProfileName(name);
  const profilesDir = getProfilesDir();
  const targetDir = path.join(profilesDir, sanitized);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`存档 "${sanitized}" 不存在`);
  }
  updateConfig({ activeProfile: sanitized });
  return sanitized;
}

function getProfileData(profileName) {
  const dataFile = getProfileDataFile(profileName);
  if (fs.existsSync(dataFile)) {
    try {
      const content = fs.readFileSync(dataFile, 'utf8');
      const parsed = JSON.parse(content);
      const data = { ...getInitialData(), ...parsed };
      if (Array.isArray(data.history)) {
        data.history = data.history.map(item => {
          if (item && item.isNew !== undefined) {
            const clean = { ...item };
            delete clean.isNew;
            return clean;
          }
          return item;
        });
      }
      return data;
    } catch (err) {
      console.error(`[ProfileManager] Error reading ${dataFile}:`, err.message);
    }
  }
  return getInitialData();
}

function saveProfileData(profileName, data) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const dataFile = getProfileDataFile(sanitized);
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');

  // Read current existing data so partial updates don't overwrite history
  const current = getProfileData(sanitized);
  const merged = { ...current };

  if (Array.isArray(data.promptHistory)) merged.promptHistory = data.promptHistory;
  if (Array.isArray(data.savedPromptGroups)) merged.savedPromptGroups = data.savedPromptGroups;
  if (Array.isArray(data.customCharacters)) merged.customCharacters = data.customCharacters;
  if (Array.isArray(data.customStyles)) merged.customStyles = data.customStyles;

  if (Array.isArray(data.history)) {
    // Process history: if any item has a data URL, persist as PNG file to disk and replace url
    const processedHistory = data.history.map(item => {
      if (!item) return item;
      const cleanItem = { ...item };
      delete cleanItem.isNew;
      if (typeof cleanItem.url === 'string' && cleanItem.url.startsWith('data:image/')) {
        try {
          const base64Data = cleanItem.url.split(',')[1];
          if (base64Data) {
            const buf = Buffer.from(base64Data, 'base64');
            const imgId = cleanItem.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const imgPath = path.join(imagesDir, `${imgId}.png`);
            fs.writeFileSync(imgPath, buf);
            return {
              ...cleanItem,
              id: imgId,
              url: `/api/images/${encodeURIComponent(sanitized)}/${encodeURIComponent(imgId)}.png`
            };
          }
        } catch (e) {
          console.error('[ProfileManager] Failed to save base64 history image to disk:', e.message);
        }
      }
      return cleanItem;
    });
    merged.history = processedHistory;
  }

  fs.writeFileSync(dataFile, JSON.stringify(merged, null, 2), 'utf8');
  return true;
}

function saveGeneratedImageFile(profileName, id, buffer) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');
  const imgPath = path.join(imagesDir, `${id}.png`);
  fs.writeFileSync(imgPath, buffer);
  return `/api/images/${encodeURIComponent(sanitized)}/${encodeURIComponent(id)}.png`;
}

function deleteHistoryItem(profileName, id) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');
  const cleanId = String(id).replace(/[^a-zA-Z0-9_-]/g, '');

  // Delete image file if exists
  const imgPath = path.join(imagesDir, `${cleanId}.png`);
  if (fs.existsSync(imgPath)) {
    try {
      fs.unlinkSync(imgPath);
    } catch (e) {}
  }

  // Also remove from data.json history
  const data = getProfileData(sanitized);
  if (Array.isArray(data.history)) {
    data.history = data.history.filter(h => h && String(h.id) !== String(id));
    const dataFile = getProfileDataFile(sanitized);
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
  }
  return true;
}

function batchDeleteHistoryItems(profileName, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');

  const idSet = new Set(ids.map(i => String(i)));

  for (const id of ids) {
    const cleanId = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    const imgPath = path.join(imagesDir, `${cleanId}.png`);
    if (fs.existsSync(imgPath)) {
      try {
        fs.unlinkSync(imgPath);
      } catch (e) {}
    }
  }

  const data = getProfileData(sanitized);
  if (Array.isArray(data.history)) {
    data.history = data.history.filter(h => h && !idSet.has(String(h.id)));
    const dataFile = getProfileDataFile(sanitized);
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
  }
  return true;
}

function getImagePath(profileName, id) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const cleanId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '');
  const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;
  const imgPath = path.join(profileDir, 'images', fileName);
  if (fs.existsSync(imgPath)) {
    return imgPath;
  }
  return null;
}

module.exports = {
  getProfilesDir,
  listProfiles,
  createProfile,
  deleteProfile,
  renameProfile,
  switchProfile,
  getProfileData,
  saveProfileData,
  saveGeneratedImageFile,
  deleteHistoryItem,
  batchDeleteHistoryItems,
  getImagePath
};
