const fs = require('fs');
const path = require('path');

const APP_DEST = process.env.TRIM_APPDEST ? path.resolve(process.env.TRIM_APPDEST) : path.resolve(__dirname, '../..');
const PKG_VAR = process.env.TRIM_PKGVAR ? path.resolve(process.env.TRIM_PKGVAR) : path.join(APP_DEST, 'var');

// Detect fnOS user-facing shared directory (挂载到飞牛"文件管理"的共享文件夹)
function getDetectedShareDir() {
  const raw = process.env.TRIM_DATA_SHARE_PATHS || '';
  let sharedPaths = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) sharedPaths = parsed.filter(p => typeof p === 'string');
  } catch {
    sharedPaths = fs.existsSync(raw) ? [raw] : raw.split(/[:;,\n\r]/).map(p => p.trim()).filter(Boolean);
  }
  const candidates = [
    process.env.NOVELAI_SHARE_DIR,
    ...sharedPaths,
    '/var/apps/novelai/shares/NovelAI-WebUI',
    '/var/apps/novelai/share/NovelAI-WebUI',
    path.join(APP_DEST, 'shares/NovelAI-WebUI'),
    path.join(APP_DEST, 'share/NovelAI-WebUI')
  ];
  return candidates.find(p => {
    try { return p && fs.statSync(p).isDirectory(); } catch { return false; }
  }) || null;
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

      // An unavailable disk or revoked grant must not silently change the user's storage.
      if (typeof cachedConfig.storagePath !== 'string' || !cachedConfig.storagePath.trim()) {
        cachedConfig.storagePath = DATA_DIR;
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
  if (!saveConfig(updated)) throw new Error('保存应用配置失败');
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
