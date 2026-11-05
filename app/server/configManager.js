const fs = require('fs');
const path = require('path');

const APP_DEST = process.env.TRIM_APPDEST ? path.resolve(process.env.TRIM_APPDEST) : path.resolve(__dirname, '../..');
const PKG_VAR = process.env.TRIM_PKGVAR ? path.resolve(process.env.TRIM_PKGVAR) : path.join(APP_DEST, 'var');

// Detect fnOS user-facing shared directory (挂载到飞牛"文件管理"的共享文件夹)
function getDetectedShareDir() {
  if (process.env.NOVELAI_SHARE_DIR && fs.existsSync(process.env.NOVELAI_SHARE_DIR)) {
    return process.env.NOVELAI_SHARE_DIR;
  }
  if (process.env.TRIM_DATA_SHARE_PATHS) {
    const raw = process.env.TRIM_DATA_SHARE_PATHS.trim();
    if (fs.existsSync(raw)) {
      return raw;
    }
    const parts = raw.split(/[:;,\n\r]/).map(s => s.trim()).filter(Boolean);
    const existing = parts.find(p => fs.existsSync(p));
    if (existing) return existing;
  }
  // Singular /var/apps/novelai/share (official fnOS app share mount)
  if (fs.existsSync('/var/apps/novelai/share/NovelAI-WebUI')) {
    return '/var/apps/novelai/share/NovelAI-WebUI';
  }
  // Plural /var/apps/novelai/shares
  if (fs.existsSync('/var/apps/novelai/shares/NovelAI-WebUI')) {
    return '/var/apps/novelai/shares/NovelAI-WebUI';
  }
  const appDestShareWebUI = path.join(APP_DEST, 'share/NovelAI-WebUI');
  if (fs.existsSync(appDestShareWebUI)) {
    return appDestShareWebUI;
  }
  const appDestSharesWebUI = path.join(APP_DEST, 'shares/NovelAI-WebUI');
  if (fs.existsSync(appDestSharesWebUI)) {
    return appDestSharesWebUI;
  }
  for (let vol = 1; vol <= 9; vol++) {
    const volAppShare = `/vol${vol}/@appshare/NovelAI-WebUI`;
    if (fs.existsSync(volAppShare)) {
      return volAppShare;
    }
    const volShare = `/vol${vol}/shares/NovelAI-WebUI`;
    if (fs.existsSync(volShare)) {
      return volShare;
    }
    const volShareSingular = `/vol${vol}/share/NovelAI-WebUI`;
    if (fs.existsSync(volShareSingular)) {
      return volShareSingular;
    }
  }
  if (fs.existsSync('/var/apps/novelai/share/NovelAI')) {
    return '/var/apps/novelai/share/NovelAI';
  }
  if (fs.existsSync('/var/apps/novelai/shares/NovelAI')) {
    return '/var/apps/novelai/shares/NovelAI';
  }
  const appDestShare = path.join(APP_DEST, 'share/NovelAI');
  if (fs.existsSync(appDestShare)) {
    return appDestShare;
  }
  const appDestShares = path.join(APP_DEST, 'shares/NovelAI');
  if (fs.existsSync(appDestShares)) {
    return appDestShares;
  }
  return null;
}

const DETECTED_SHARE = getDetectedShareDir();
const DATA_DIR = DETECTED_SHARE || path.join(PKG_VAR, 'data');
const CONFIG_FILE = path.join(PKG_VAR, 'data/config.json');

// Ensure data directory exists
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const DEFAULT_IMAGE_SUBDIR_PATTERN = '/{year}/{month}/';

function normalizeImageSubdirPattern(rawPattern) {
  if (rawPattern === undefined || rawPattern === null || typeof rawPattern !== 'string') {
    return DEFAULT_IMAGE_SUBDIR_PATTERN;
  }
  let p = rawPattern.replace(/\\/g, '/').trim();
  if (!p) {
    return DEFAULT_IMAGE_SUBDIR_PATTERN;
  }
  // Disallow unsafe characters (keep safe characters and variable braces)
  p = p.replace(/[<>:"|?*\x00-\x1F]/g, '');
  // Disallow directory traversal & empty/dot-only segments
  const segments = p.split('/').map(s => s.trim()).filter(s => s && !/^\.+$/.test(s));
  if (segments.length === 0) {
    return DEFAULT_IMAGE_SUBDIR_PATTERN;
  }
  return '/' + segments.join('/') + '/';
}

const DEFAULT_CONFIG = {
  apiToken: '',
  apiBaseUrl: 'https://image.novelai.net',
  storagePath: DATA_DIR,
  imageSubdirPattern: DEFAULT_IMAGE_SUBDIR_PATTERN,
  activeProfile: 'Default',
  enableEncryption: false,
  encryptionKey: 'nahida1027',
  maxConcurrency: 1,
  enableLogging: true
};

let cachedConfig = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      cachedConfig = { ...DEFAULT_CONFIG, ...parsed };
      cachedConfig.imageSubdirPattern = normalizeImageSubdirPattern(cachedConfig.imageSubdirPattern);

      // If user-facing share directory is available or invalid path, fallback to DATA_DIR
      const currentShare = getDetectedShareDir();
      const internalVarData = path.join(PKG_VAR, 'data');
      if (
        !cachedConfig.storagePath ||
        cachedConfig.storagePath.startsWith('/tmp/') ||
        cachedConfig.storagePath.includes('/var/apps/novelai/var/data') ||
        (currentShare && (
          path.resolve(cachedConfig.storagePath) === path.resolve(internalVarData) ||
          cachedConfig.storagePath === './data' ||
          cachedConfig.storagePath.endsWith('/var/data') ||
          cachedConfig.storagePath.includes('@appdata')
        )) ||
        (!fs.existsSync(cachedConfig.storagePath) && (currentShare || DATA_DIR))
      ) {
        cachedConfig.storagePath = currentShare || DATA_DIR;
        saveConfig(cachedConfig);
      }
      return cachedConfig;
    }
  } catch (err) {
    console.error('[ConfigManager] Error reading config.json:', err.message);
  }
  cachedConfig = { ...DEFAULT_CONFIG };
  saveConfig(cachedConfig);
  return cachedConfig;
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    cachedConfig = { ...config };
    return true;
  } catch (err) {
    console.error('[ConfigManager] Error saving config.json:', err.message);
    return false;
  }
}

function getConfig() {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

function updateConfig(partial) {
  const current = getConfig();
  const toMerge = { ...partial };
  if (toMerge.imageSubdirPattern !== undefined) {
    toMerge.imageSubdirPattern = normalizeImageSubdirPattern(toMerge.imageSubdirPattern);
  }
  const updated = { ...current, ...toMerge };
  saveConfig(updated);
  return updated;
}

module.exports = {
  APP_DEST,
  PKG_VAR,
  DATA_DIR,
  CONFIG_FILE,
  DEFAULT_IMAGE_SUBDIR_PATTERN,
  normalizeImageSubdirPattern,
  getConfig,
  updateConfig,
  saveConfig
};
