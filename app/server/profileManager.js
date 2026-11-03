const fs = require('fs');
const path = require('path');
const { getConfig, updateConfig } = require('./configManager');
const profileDb = require('./profileDb');

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

function getProfileDbPath(profileName) {
  const profileDir = getProfileDir(profileName);
  return path.join(profileDir, 'profile.db');
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

  // Ensure all existing profiles are initialized / silently migrated if data.json exists
  for (const p of profiles) {
    try {
      const pDir = path.join(profilesDir, p);
      profileDb.getDb(pDir, p);
    } catch (err) {
      console.warn(`[ProfileManager] Warning initializing DB for profile "${p}":`, err.message);
    }
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
  // Initialize SQLite database
  profileDb.getDb(targetDir, sanitized);
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

  // Close DB connection before deleting directory
  profileDb.closeDb(targetDir);

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

  // Close DB connection before renaming directory
  profileDb.closeDb(oldDir);

  fs.renameSync(oldDir, newDir);

  // Initialize DB connection with new directory
  const newDb = profileDb.getDb(newDir, newSanitized);
  profileDb.updateHistoryProfileUrl(newDb, oldSanitized, newSanitized);

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

function getProfileData(profileName, options = {}) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const targetDir = getProfileDir(sanitized);
  const db = profileDb.getDb(targetDir, sanitized);

  const promptHistory = profileDb.getAllPromptHistory(db);
  const promptGroups = profileDb.getAllPromptGroups(db);
  const customStyles = profileDb.getAllStyles(db);
  const customCharacters = profileDb.getAllCharacters(db);
  const historyResult = profileDb.getHistory(db, options);
  const settings = profileDb.getSettings(db);

  let params = {};
  if (settings.params) {
    try {
      params = JSON.parse(settings.params);
    } catch {}
  }

  const data = {
    params,
    promptHistory,
    savedPromptGroups: promptGroups.map(g => g.name),
    promptGroups,
    customCharacters,
    customStyles,
    history: historyResult.history
  };

  if (options.limit !== undefined || options.pageSize !== undefined || options.page !== undefined) {
    data.pagination = {
      total: historyResult.total,
      page: historyResult.page,
      pageSize: historyResult.pageSize,
      totalPages: historyResult.totalPages
    };
  }

  return data;
}

function saveProfileData(profileName, data) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');
  const db = profileDb.getDb(profileDir, sanitized);

  if (data.params && typeof data.params === 'object') {
    profileDb.saveSetting(db, 'params', data.params);
  }

  if (Array.isArray(data.promptHistory)) {
    profileDb.savePromptHistory(db, data.promptHistory);
  }

  if (Array.isArray(data.promptGroups) && data.promptGroups.length > 0) {
    profileDb.savePromptGroups(db, data.promptGroups);
  } else if (Array.isArray(data.savedPromptGroups)) {
    profileDb.savePromptGroups(db, data.savedPromptGroups);
  }

  if (Array.isArray(data.customCharacters)) {
    profileDb.saveCharacters(db, data.customCharacters);
  }

  if (Array.isArray(data.customStyles)) {
    profileDb.saveStyles(db, data.customStyles);
  }

  if (Array.isArray(data.history)) {
    const processedHistory = data.history.map(item => {
      if (!item) return item;
      const cleanItem = { ...item };
      delete cleanItem.isNew;
      let rawBase64 = null;
      if (typeof cleanItem.url === 'string' && cleanItem.url.startsWith('data:image/')) {
        rawBase64 = cleanItem.url.split(',')[1];
      } else if (typeof cleanItem.image === 'string' && cleanItem.image.startsWith('data:image/')) {
        rawBase64 = cleanItem.image.split(',')[1];
      }

      if (rawBase64) {
        try {
          const buf = Buffer.from(rawBase64, 'base64');
          const imgId = cleanItem.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const imgPath = path.join(imagesDir, `${imgId}.png`);
          fs.writeFileSync(imgPath, buf);
          cleanItem.id = imgId;
          cleanItem.url = `/api/images/${encodeURIComponent(sanitized)}/${encodeURIComponent(imgId)}.png`;
        } catch (e) {
          console.error('[ProfileManager] Failed to save base64 history image to disk:', e.message);
        }
      }
      return cleanItem;
    });

    profileDb.addHistoryItems(db, processedHistory);
  }

  return true;
}

function addHistoryItem(profileName, item) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const db = profileDb.getDb(profileDir, sanitized);
  return profileDb.addHistoryItem(db, item);
}

function getHistory(profileName, options) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const db = profileDb.getDb(profileDir, sanitized);
  return profileDb.getHistory(db, options);
}

function saveGeneratedImageFile(profileName, id, buffer) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');
  const cleanId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '') || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;
  const imgPath = path.join(imagesDir, fileName);
  fs.writeFileSync(imgPath, buffer);
  return `/api/images/${encodeURIComponent(sanitized)}/${encodeURIComponent(cleanId.endsWith('.png') ? cleanId.slice(0, -4) : cleanId)}.png`;
}

function deleteHistoryItem(profileName, id) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');
  const cleanId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '');
  const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;

  // Delete image file if exists
  const imgPath = path.join(imagesDir, fileName);
  if (fs.existsSync(imgPath)) {
    try {
      fs.unlinkSync(imgPath);
    } catch (e) {}
  }

  const db = profileDb.getDb(profileDir, sanitized);
  return profileDb.deleteHistoryItem(db, id);
}

function batchDeleteHistoryItems(profileName, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);
  const imagesDir = path.join(profileDir, 'images');

  for (const id of ids) {
    const cleanId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '');
    const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;
    const imgPath = path.join(imagesDir, fileName);
    if (fs.existsSync(imgPath)) {
      try {
        fs.unlinkSync(imgPath);
      } catch (e) {}
    }
  }

  const db = profileDb.getDb(profileDir, sanitized);
  return profileDb.batchDeleteHistoryItems(db, ids);
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
  getProfileDir,
  getProfileDbPath,
  getProfileDataFile,
  getInitialData,
  listProfiles,
  createProfile,
  deleteProfile,
  renameProfile,
  switchProfile,
  getProfileData,
  saveProfileData,
  addHistoryItem,
  getHistory,
  saveGeneratedImageFile,
  deleteHistoryItem,
  batchDeleteHistoryItems,
  getImagePath
};
