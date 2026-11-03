const fs = require('fs');
const path = require('path');

const APP_DEST = process.env.TRIM_APPDEST || path.resolve(__dirname, '../..');
const PKG_VAR = process.env.TRIM_PKGVAR || path.join(APP_DEST, 'var');

// Detect fnOS user-facing shared directory (挂载到飞牛"文件管理"的共享文件夹)
function getDetectedShareDir() {
  if (process.env.NOVELAI_SHARE_DIR && fs.existsSync(process.env.NOVELAI_SHARE_DIR)) {
    return process.env.NOVELAI_SHARE_DIR;
  }
  if (process.env.TRIM_DATA_SHARE_PATHS && fs.existsSync(process.env.TRIM_DATA_SHARE_PATHS)) {
    return process.env.TRIM_DATA_SHARE_PATHS;
  }
  if (fs.existsSync('/var/apps/novelai/shares/NovelAI-WebUI')) {
    return '/var/apps/novelai/shares/NovelAI-WebUI';
  }
  const appDestShareWebUI = path.join(APP_DEST, 'shares/NovelAI-WebUI');
  if (fs.existsSync(appDestShareWebUI)) {
    return appDestShareWebUI;
  }
  if (fs.existsSync('/var/apps/novelai/shares/NovelAI')) {
    return '/var/apps/novelai/shares/NovelAI';
  }
  const appDestShare = path.join(APP_DEST, 'shares/NovelAI');
  if (fs.existsSync(appDestShare)) {
    return appDestShare;
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

const DEFAULT_CONFIG = {
  apiToken: '',
  apiBaseUrl: 'https://image.novelai.net',
  storagePath: DATA_DIR,
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

      // If user-facing share directory is available or invalid path, fallback to DATA_DIR
      const currentShare = getDetectedShareDir();
      if (
        !cachedConfig.storagePath ||
        cachedConfig.storagePath.startsWith('/tmp/') ||
        cachedConfig.storagePath.includes('/var/apps/novelai/var/data') ||
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
  const updated = { ...current, ...partial };
  saveConfig(updated);
  return updated;
}

module.exports = {
  APP_DEST,
  PKG_VAR,
  DATA_DIR,
  CONFIG_FILE,
  getConfig,
  updateConfig,
  saveConfig
};
