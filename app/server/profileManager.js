const fs = require('fs');
const path = require('path');
const { getConfig, updateConfig, DEFAULT_IMAGE_SUBDIR_PATTERN, normalizeImageSubdirPattern } = require('./configManager');
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

  const allowEmptyAll = Boolean(data.allowEmpty);

  if (data.params && typeof data.params === 'object') {
    profileDb.saveSetting(db, 'params', data.params);
  }

  if (Array.isArray(data.promptHistory)) {
    const existing = profileDb.getAllPromptHistory(db);
    const allowEmpty = Boolean(data.allowEmptyPromptHistory || allowEmptyAll);
    if (data.promptHistory.length > 0 || (existing.length > 0 && allowEmpty)) {
      profileDb.savePromptHistory(db, data.promptHistory);
    } else if (data.promptHistory.length === 0 && existing.length > 0) {
      console.warn(`[ProfileManager] Ignored saving empty promptHistory for profile "${sanitized}" because DB contains ${existing.length} items (prevented accidental wipeout).`);
    } else if (existing.length === 0) {
      profileDb.savePromptHistory(db, []);
    }
  }

  if (Array.isArray(data.promptGroups)) {
    const existing = profileDb.getAllPromptGroups(db);
    const allowEmpty = Boolean(data.allowEmptyPromptGroups || allowEmptyAll);
    if (data.promptGroups.length > 0 || (existing.length > 0 && allowEmpty)) {
      profileDb.savePromptGroups(db, data.promptGroups);
    } else if (data.promptGroups.length === 0 && existing.length > 0) {
      console.warn(`[ProfileManager] Ignored saving empty promptGroups for profile "${sanitized}" because DB contains ${existing.length} items (prevented accidental wipeout).`);
    } else if (existing.length === 0) {
      profileDb.savePromptGroups(db, []);
    }
  } else if (Array.isArray(data.savedPromptGroups)) {
    const existing = profileDb.getAllPromptGroups(db);
    const allowEmpty = Boolean(data.allowEmptyPromptGroups || allowEmptyAll);
    if (data.savedPromptGroups.length > 0 || (existing.length > 0 && allowEmpty)) {
      profileDb.savePromptGroups(db, data.savedPromptGroups);
    } else if (data.savedPromptGroups.length === 0 && existing.length > 0) {
      console.warn(`[ProfileManager] Ignored saving empty savedPromptGroups for profile "${sanitized}" because DB contains ${existing.length} items (prevented accidental wipeout).`);
    } else if (existing.length === 0) {
      profileDb.savePromptGroups(db, []);
    }
  }

  if (Array.isArray(data.customCharacters)) {
    const existing = profileDb.getAllCharacters(db);
    const allowEmpty = Boolean(data.allowEmptyCharacters || allowEmptyAll);
    if (data.customCharacters.length > 0 || (existing.length > 0 && allowEmpty)) {
      profileDb.saveCharacters(db, data.customCharacters);
    } else if (data.customCharacters.length === 0 && existing.length > 0) {
      console.warn(`[ProfileManager] Ignored saving empty customCharacters for profile "${sanitized}" because DB contains ${existing.length} items (prevented accidental wipeout).`);
    } else if (existing.length === 0) {
      profileDb.saveCharacters(db, []);
    }
  }

  if (Array.isArray(data.customStyles)) {
    const existing = profileDb.getAllStyles(db);
    const allowEmpty = Boolean(data.allowEmptyStyles || allowEmptyAll);
    if (data.customStyles.length > 0 || (existing.length > 0 && allowEmpty)) {
      profileDb.saveStyles(db, data.customStyles);
    } else if (data.customStyles.length === 0 && existing.length > 0) {
      console.warn(`[ProfileManager] Ignored saving empty customStyles for profile "${sanitized}" because DB contains ${existing.length} items (prevented accidental wipeout).`);
    } else if (existing.length === 0) {
      profileDb.saveStyles(db, []);
    }
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
          cleanItem.id = imgId;
          cleanItem.url = saveGeneratedImageFile(sanitized, imgId, buf, cleanItem);
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

function findFileRecursive(dir, targetName, maxDepth = 6) {
  if (maxDepth <= 0 || !fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === targetName) {
        return path.join(dir, e.name);
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const found = findFileRecursive(path.join(dir, e.name), targetName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function findAllFilesRecursive(dir, targetName, maxDepth = 6) {
  const results = [];
  if (maxDepth <= 0 || !fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === targetName) {
        results.push(path.join(dir, e.name));
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        results.push(...findAllFilesRecursive(path.join(dir, e.name), targetName, maxDepth - 1));
      }
    }
  } catch {}
  return results;
}

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function isPathInside(parentDir, targetPath) {
  if (!parentDir || !targetPath) return false;
  const rel = path.relative(parentDir, targetPath);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '';
}

function isAllowedImageFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) return false;
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith('profile.db') || base.startsWith('data.json') || base.startsWith('.')) return false;
  return true;
}

function resolveImageSubdir(rawPattern, metadata = {}) {
  const pattern = normalizeImageSubdirPattern(rawPattern);
  const meta = typeof metadata === 'object' && metadata !== null ? metadata : {};
  let d;
  if (meta.timestamp) {
    const num = Number(meta.timestamp);
    if (!isNaN(num) && num > 0) {
      d = new Date(num);
    } else {
      const parsed = new Date(meta.timestamp);
      d = isNaN(parsed.getTime()) ? new Date() : parsed;
    }
  } else {
    d = new Date();
  }

  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const rawModel = meta.model || meta.params?.model || '';
  const model = String(rawModel).trim().replace(/[/\\?%*:|"<>.]/g, '_') || 'default';

  const rawProfile = meta.profile || 'Default';
  const profile = sanitizeProfileName(rawProfile) || 'Default';

  let resolved = pattern
    .replace(/\{year\}/gi, year)
    .replace(/\{month\}/gi, month)
    .replace(/\{day\}/gi, day)
    .replace(/\{date\}/gi, dateStr)
    .replace(/\{model\}/gi, model)
    .replace(/\{profile\}/gi, profile);

  // Sanitize path separators and remove traversal
  resolved = resolved.replace(/\\/g, '/').replace(/[<>:"|?*\x00-\x1F]/g, '');
  const segments = resolved.split('/').map(s => s.trim()).filter(s => s && !/^\.+$/.test(s));

  if (segments.length === 0) {
    return `${year}/${month}`;
  }

  return segments.join('/');
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

function saveGeneratedImageFile(profileName, id, buffer, metadata = {}) {
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = getProfileDir(sanitized);

  const meta = typeof metadata === 'object' && metadata !== null ? metadata : {};
  let timestamp;
  if (meta.timestamp) {
    const num = Number(meta.timestamp);
    if (!isNaN(num) && num > 0) {
      timestamp = num;
    } else {
      const parsed = new Date(meta.timestamp);
      timestamp = isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
    }
  } else {
    timestamp = Date.now();
  }
  const model = meta.model || meta.params?.model || '';

  const cfg = getConfig();
  const pattern = cfg.imageSubdirPattern || DEFAULT_IMAGE_SUBDIR_PATTERN;
  const relativeSubdir = resolveImageSubdir(pattern, { ...meta, timestamp, model, profile: sanitized });

  const targetSubdir = path.resolve(profileDir, relativeSubdir);
  const safeSubdir = isPathInside(profileDir, targetSubdir) ? targetSubdir : profileDir;

  fs.mkdirSync(safeSubdir, { recursive: true });

  let cleanId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '').trim();
  if (!cleanId || /^\.+$/.test(cleanId) || cleanId === '.png') {
    cleanId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;
  const filePath = path.join(safeSubdir, fileName);
  fs.writeFileSync(filePath, buffer);

  const fileRelPath = path.relative(profileDir, filePath).replace(/\\/g, '/');
  const urlSegments = fileRelPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/api/images/${encodeURIComponent(sanitized)}/${urlSegments}`;
}

function deleteHistoryItem(profileName, id) {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;

  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = path.resolve(getProfileDir(sanitized));
  const db = profileDb.getDb(profileDir, sanitized);

  let fileDeleted = false;

  // 1. If id includes subpath (e.g. "2026/11/img123.png"), check direct relative path
  if (trimmed.includes('/')) {
    try {
      const decodedRel = decodeURIComponent(trimmed).replace(/\\/g, '/');
      const directTarget = path.resolve(profileDir, decodedRel);
      if (isPathInside(profileDir, directTarget) && isAllowedImageFile(directTarget) && fs.existsSync(directTarget) && fs.statSync(directTarget).isFile()) {
        fs.unlinkSync(directTarget);
        fileDeleted = true;
      }
    } catch {}
  }

  // 2. Resolve and delete by DB URL if recorded
  const historyUrl = profileDb.getHistoryUrlById(db, trimmed) || (trimmed.includes('/') ? profileDb.getHistoryUrlById(db, path.basename(trimmed)) : null);
  if (historyUrl) {
    try {
      const relFromUrl = decodeURIComponent(historyUrl.replace(/^.*\/api\/images\/[^/]+\//, ''));
      const targetPath = path.resolve(profileDir, relFromUrl);
      if (isPathInside(profileDir, targetPath) && isAllowedImageFile(targetPath) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        fs.unlinkSync(targetPath);
        fileDeleted = true;
      }
    } catch (e) {}
  }

  // 3. Check legacy and flat locations
  const cleanId = path.basename(trimmed).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (cleanId && !/^\.+$/.test(cleanId)) {
    const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;

    if (!fileDeleted && isAllowedImageFile(fileName)) {
      const legacyPath = path.join(profileDir, 'images', fileName);
      if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isFile()) {
        try { fs.unlinkSync(legacyPath); fileDeleted = true; } catch (e) {}
      }
    }
    if (!fileDeleted && isAllowedImageFile(fileName)) {
      const flatPath = path.join(profileDir, fileName);
      if (fs.existsSync(flatPath) && fs.statSync(flatPath).isFile()) {
        try { fs.unlinkSync(flatPath); fileDeleted = true; } catch (e) {}
      }
    }

    // 4. Fallback only if not deleted yet: find and delete lingering file with this name
    if (!fileDeleted && isAllowedImageFile(fileName)) {
      const lingering = findAllFilesRecursive(profileDir, fileName);
      for (const f of lingering) {
        if (isAllowedImageFile(f)) {
          try { fs.unlinkSync(f); fileDeleted = true; } catch (e) {}
        }
      }
    }
  }

  // Delete DB record for ID and any basename alias
  const res1 = profileDb.deleteHistoryItem(db, trimmed);
  if (trimmed.includes('/')) {
    profileDb.deleteHistoryItem(db, path.basename(trimmed));
    const withoutPng = path.basename(trimmed, '.png');
    if (withoutPng !== path.basename(trimmed)) {
      profileDb.deleteHistoryItem(db, withoutPng);
    }
  }
  return res1;
}

function batchDeleteHistoryItems(profileName, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = path.resolve(getProfileDir(sanitized));
  const db = profileDb.getDb(profileDir, sanitized);

  const urlMap = profileDb.getHistoryUrlsByIds(db, ids);

  for (const id of ids) {
    if (!id || typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed) continue;

    let fileDeleted = false;

    // 1. Direct path check if id contains slashes
    if (trimmed.includes('/')) {
      try {
        const decodedRel = decodeURIComponent(trimmed).replace(/\\/g, '/');
        const directTarget = path.resolve(profileDir, decodedRel);
        if (isPathInside(profileDir, directTarget) && isAllowedImageFile(directTarget) && fs.existsSync(directTarget) && fs.statSync(directTarget).isFile()) {
          fs.unlinkSync(directTarget);
          fileDeleted = true;
        }
      } catch {}
    }

    // 2. DB URL resolution
    const historyUrl = urlMap[trimmed] || urlMap[`${trimmed}.png`] ||
      (trimmed.endsWith('.png') ? urlMap[trimmed.slice(0, -4)] : null) ||
      (trimmed.includes('/') ? urlMap[path.basename(trimmed)] : null);

    if (historyUrl) {
      try {
        const relFromUrl = decodeURIComponent(historyUrl.replace(/^.*\/api\/images\/[^/]+\//, ''));
        const targetPath = path.resolve(profileDir, relFromUrl);
        if (isPathInside(profileDir, targetPath) && isAllowedImageFile(targetPath) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
          fs.unlinkSync(targetPath);
          fileDeleted = true;
        }
      } catch (e) {}
    }

    // 3. Legacy and flat locations
    const cleanId = path.basename(trimmed).replace(/[^a-zA-Z0-9_.-]/g, '');
    if (cleanId && !/^\.+$/.test(cleanId)) {
      const fileName = cleanId.endsWith('.png') ? cleanId : `${cleanId}.png`;

      if (!fileDeleted && isAllowedImageFile(fileName)) {
        const legacyPath = path.join(profileDir, 'images', fileName);
        if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isFile()) {
          try { fs.unlinkSync(legacyPath); fileDeleted = true; } catch (e) {}
        }
      }
      if (!fileDeleted && isAllowedImageFile(fileName)) {
        const flatPath = path.join(profileDir, fileName);
        if (fs.existsSync(flatPath) && fs.statSync(flatPath).isFile()) {
          try { fs.unlinkSync(flatPath); fileDeleted = true; } catch (e) {}
        }
      }

      // 4. Recursive lingering only if NOT yet deleted
      if (!fileDeleted && isAllowedImageFile(fileName)) {
        const lingering = findAllFilesRecursive(profileDir, fileName);
        for (const f of lingering) {
          if (isAllowedImageFile(f)) {
            try { fs.unlinkSync(f); fileDeleted = true; } catch (e) {}
          }
        }
      }
    }
  }

  // Also collect any base IDs for items with slashes
  const allDbIds = new Set(ids);
  for (const id of ids) {
    if (typeof id === 'string' && id.includes('/')) {
      allDbIds.add(path.basename(id));
      allDbIds.add(path.basename(id, '.png'));
    }
  }

  return profileDb.batchDeleteHistoryItems(db, Array.from(allDbIds));
}

function getImagePath(profileName, subpathOrId) {
  if (!subpathOrId || typeof subpathOrId !== 'string') return null;

  const sanitized = sanitizeProfileName(profileName) || 'Default';
  const profileDir = path.resolve(getProfileDir(sanitized));

  let decoded;
  try {
    decoded = decodeURIComponent(subpathOrId).replace(/\\/g, '/');
  } catch {
    return null;
  }

  if (decoded.includes('\0') || decoded.includes('\x00')) return null;

  // 1. Direct candidate inside profileDir (e.g. "2026/11/img123.png" or "img123.png")
  const directCandidate = path.resolve(profileDir, decoded);
  if (isPathInside(profileDir, directCandidate)) {
    if (isAllowedImageFile(directCandidate) && fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
      return directCandidate;
    }
    if (!directCandidate.endsWith('.png')) {
      const withPng = `${directCandidate}.png`;
      if (isPathInside(profileDir, withPng) && isAllowedImageFile(withPng) && fs.existsSync(withPng) && fs.statSync(withPng).isFile()) {
        return withPng;
      }
    }
  }

  // 2. Legacy flat candidate inside images/ subdir (e.g. "images/img123.png" or legacy direct id)
  const legacyDir = path.join(profileDir, 'images');
  const legacyCandidate = path.resolve(legacyDir, decoded);
  if (isPathInside(legacyDir, legacyCandidate)) {
    if (isAllowedImageFile(legacyCandidate) && fs.existsSync(legacyCandidate) && fs.statSync(legacyCandidate).isFile()) {
      return legacyCandidate;
    }
    if (!legacyCandidate.endsWith('.png')) {
      const withPng = `${legacyCandidate}.png`;
      if (isPathInside(legacyDir, withPng) && isAllowedImageFile(withPng) && fs.existsSync(withPng) && fs.statSync(withPng).isFile()) {
        return withPng;
      }
    }
  }

  // 3. Database URL lookup (by id or filename)
  try {
    const db = profileDb.getDb(profileDir, sanitized);
    const historyUrl = profileDb.getHistoryUrlById(db, decoded) || profileDb.getHistoryUrlById(db, path.basename(decoded));
    if (historyUrl && typeof historyUrl === 'string') {
      const relFromUrl = decodeURIComponent(historyUrl.replace(/^.*\/api\/images\/[^/]+\//, ''));
      const dbCandidate = path.resolve(profileDir, relFromUrl);
      if (isPathInside(profileDir, dbCandidate) && isAllowedImageFile(dbCandidate) && fs.existsSync(dbCandidate) && fs.statSync(dbCandidate).isFile()) {
        return dbCandidate;
      }
    }
  } catch {}

  // 4. Recursive search fallback for matching file name inside profileDir
  const cleanBase = path.basename(decoded).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (cleanBase && !/^\.+$/.test(cleanBase)) {
    const targetFileName = cleanBase.endsWith('.png') ? cleanBase : `${cleanBase}.png`;
    if (isAllowedImageFile(targetFileName)) {
      const found = findFileRecursive(profileDir, targetFileName);
      if (found && isPathInside(profileDir, found) && isAllowedImageFile(found)) {
        return found;
      }
    }
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
  resolveImageSubdir,
  addHistoryItem,
  getHistory,
  saveGeneratedImageFile,
  deleteHistoryItem,
  batchDeleteHistoryItems,
  getImagePath
};
