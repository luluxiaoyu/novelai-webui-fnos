const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { getConfig } = require('./configManager');

const pad = n => n.toString().padStart(2, '0');

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatYearMonth(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatTimestamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getStoragePath() {
  const cfg = getConfig();
  const sp = cfg.storagePath;
  if (sp && !sp.startsWith('/tmp/') && (fs.existsSync(sp) || !sp.includes('/tmp/'))) {
    return sp;
  }
  return path.resolve(__dirname, '../../var/data');
}

/**
 * 实时追加运行日志至 logs/server.log
 */
function writeServerLog(level, message, details) {
  try {
    const storagePath = getStoragePath();
    const logsDir = path.join(storagePath, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const serverLogFile = path.join(logsDir, 'server.log');
    const now = new Date();
    const ts = `[${formatDate(now)} ${formatTime(now)}]`;
    let detailStr = '';
    if (details !== undefined && details !== null) {
      let cleanDetails = details;
      if (Buffer.isBuffer(details) || details instanceof ArrayBuffer || ArrayBuffer.isView(details)) {
        cleanDetails = Buffer.from(details).toString('utf8');
      }
      if (typeof cleanDetails === 'object') {
        try {
          detailStr = `\n  Details: ${JSON.stringify(cleanDetails, null, 2)}`;
        } catch {
          detailStr = `\n  Details: ${String(cleanDetails)}`;
        }
      } else {
        detailStr = `\n  Details: ${cleanDetails}`;
      }
    }
    const line = `${ts} [${level.toUpperCase()}] ${message}${detailStr}\n`;
    fs.appendFileSync(serverLogFile, line, 'utf8');
  } catch (e) {}
}

/**
 * 确保生图参数日志按 [年份-月份] 分类存储 (例如: logs/generation/2026-11/generation_2026-11-02.log)
 */
function getGenerationLogFile(now = new Date()) {
  const storagePath = getStoragePath();
  const yearMonth = formatYearMonth(now);
  const dateStr = formatDate(now);

  const genDir = path.join(storagePath, 'logs', 'generation', yearMonth);
  if (!fs.existsSync(genDir)) {
    fs.mkdirSync(genDir, { recursive: true });
  }

  return path.join(genDir, `generation_${dateStr}.log`);
}

/**
 * 将已过期的历史单日日志压缩为 .tar.gz 并删除原 .log 文件
 */
async function compressLogFileToTarGz(sourceLogPath, targetTarGzPath) {
  return new Promise((resolve, reject) => {
    const tempTarGz = targetTarGzPath + '.tmp';
    const output = fs.createWriteStream(tempTarGz);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });

    output.on('close', () => {
      try {
        fs.renameSync(tempTarGz, targetTarGzPath);
        if (fs.existsSync(sourceLogPath)) {
          fs.unlinkSync(sourceLogPath);
        }
        resolve(true);
      } catch (err) {
        reject(err);
      }
    });

    archive.on('error', (err) => {
      try {
        if (fs.existsSync(tempTarGz)) fs.unlinkSync(tempTarGz);
      } catch {}
      reject(err);
    });

    archive.pipe(output);
    archive.file(sourceLogPath, { name: path.basename(sourceLogPath) });
    archive.finalize();
  });
}

/**
 * 历史生图日志归档维护：
 * 1. 扫描 logs/generation 各 YYYY-MM 目录以及 logs/ 根目录下的历史日志；
 * 2. 凡是早于当天的 generation_YYYY-MM-DD.log 一律使用 tar.gz 打包并删除原文件；
 * 3. 兼容将根目录散落的历史日志按月份分类迁移归档。
 */
async function archivePastGenerationLogs() {
  try {
    const storagePath = getStoragePath();
    const logsBaseDir = path.join(storagePath, 'logs');
    if (!fs.existsSync(logsBaseDir)) return;

    const todayStr = formatDate(new Date());

    // 1. 处理 logs/ 根目录遗留的历史日志文件（如有则迁移至 generation/YYYY-MM 目录下）
    try {
      const rootFiles = fs.readdirSync(logsBaseDir);
      for (const file of rootFiles) {
        const match = file.match(/^generation_(\d{4}-\d{2})-\d{2}\.log$/);
        if (match) {
          const ym = match[1];
          const targetDir = path.join(logsBaseDir, 'generation', ym);
          fs.mkdirSync(targetDir, { recursive: true });
          const oldPath = path.join(logsBaseDir, file);
          const newPath = path.join(targetDir, file);
          try {
            fs.renameSync(oldPath, newPath);
          } catch {}
        }
      }
    } catch {}

    // 2. 遍历 logs/generation/ 下的所有月份文件夹
    const genBaseDir = path.join(logsBaseDir, 'generation');
    if (!fs.existsSync(genBaseDir)) return;

    const ymDirs = fs.readdirSync(genBaseDir, { withFileTypes: true });
    for (const dirEntry of ymDirs) {
      if (!dirEntry.isDirectory()) continue;

      const ymPath = path.join(genBaseDir, dirEntry.name);
      const files = fs.readdirSync(ymPath);

      for (const file of files) {
        const match = file.match(/^generation_(\d{4}-\d{2}-\d{2})\.log$/);
        if (match) {
          const logDate = match[1];
          // 如果是今天以前的历史日志，打包归档
          if (logDate < todayStr) {
            const logFilePath = path.join(ymPath, file);
            const tarGzPath = path.join(ymPath, `generation_${logDate}.tar.gz`);

            if (!fs.existsSync(tarGzPath)) {
              try {
                await compressLogFileToTarGz(logFilePath, tarGzPath);
                console.log(`[Logger] Successfully archived historical log to ${tarGzPath}`);
              } catch (err) {
                console.error(`[Logger] Failed to archive ${file}:`, err.message);
              }
            } else {
              // 若 .tar.gz 已存在且正常，删除遗留的 .log
              try {
                if (fs.statSync(tarGzPath).size > 0) {
                  fs.unlinkSync(logFilePath);
                }
              } catch {}
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Logger] Error archiving past generation logs:', err.message);
  }
}

/**
 * 运行日志轮转维护：
 * 保留最新 5 份历史归档日志 + 1 份当前运行中的 server.log
 */
function rotateServerLogs(maxKeep = 5) {
  try {
    const storagePath = getStoragePath();
    const logsDir = path.join(storagePath, 'logs');
    if (!fs.existsSync(logsDir)) return;

    const files = fs.readdirSync(logsDir);
    const archivedLogs = [];

    for (const file of files) {
      if (file.startsWith('server_') && file.endsWith('.log')) {
        const filePath = path.join(logsDir, file);
        try {
          const stat = fs.statSync(filePath);
          archivedLogs.push({ name: file, path: filePath, mtime: stat.mtimeMs });
        } catch {}
      }
    }

    // 按修改时间从新到旧排序
    archivedLogs.sort((a, b) => b.mtime - a.mtime);

    // 超过 5 份的旧日志予以清理
    if (archivedLogs.length > maxKeep) {
      const toDelete = archivedLogs.slice(maxKeep);
      for (const item of toDelete) {
        try {
          fs.unlinkSync(item.path);
          console.log(`[Logger] Pruned old server log: ${item.name}`);
        } catch (e) {}
      }
    }

    // 检查当前运行中的 server.log 大小（如单文件超过 20MB 则热切分轮转）
    const activeLogPath = path.join(logsDir, 'server.log');
    if (fs.existsSync(activeLogPath)) {
      const activeStat = fs.statSync(activeLogPath);
      if (activeStat.size > 20 * 1024 * 1024) {
        const rotatedName = `server_${formatTimestamp(new Date())}.log`;
        const rotatedPath = path.join(logsDir, rotatedName);
        fs.renameSync(activeLogPath, rotatedPath);
        fs.writeFileSync(activeLogPath, `[${new Date().toISOString()}] Log rotated to ${rotatedName}\n`, 'utf8');
        // 重新修剪
        rotateServerLogs(maxKeep);
      }
    }
  } catch (err) {
    console.error('[Logger] Error rotating server logs:', err.message);
  }
}

let lastMaintenanceDate = '';

function scheduleLogMaintenance() {
  const today = formatDate(new Date());
  if (lastMaintenanceDate !== today) {
    lastMaintenanceDate = today;
    archivePastGenerationLogs();
    rotateServerLogs(5);
  }
}

// 服务启动时先执行一次归档与日志修剪
const initTimer = setTimeout(() => {
  archivePastGenerationLogs();
  rotateServerLogs(5);
}, 3000);
if (initTimer.unref) initTimer.unref();

// 每小时定期检查一次
const hourlyTimer = setInterval(() => {
  archivePastGenerationLogs();
  rotateServerLogs(5);
}, 3600000);
if (hourlyTimer.unref) hourlyTimer.unref();

/**
 * 记录生图与超分参数日志（完全过滤掉 Base64 巨量图片字段）
 */
function logGeneration(req, type, status, details) {
  const cfg = getConfig();
  if (!cfg.enableLogging) return;

  try {
    scheduleLogMaintenance();

    const now = new Date();
    const dateStr = formatDate(now);
    const timeStr = formatTime(now);

    const logFile = getGenerationLogFile(now);

    // Clean body and parameters to avoid massive base64 strings in log
    const body = req.body || {};
    const params = body.parameters || {};

    const cleanParams = { ...params };
    if (cleanParams.image && typeof cleanParams.image === 'string') {
      cleanParams.image = `[Base64 Image, len: ${cleanParams.image.length}]`;
    }
    if (cleanParams.mask && typeof cleanParams.mask === 'string') {
      cleanParams.mask = `[Base64 Mask, len: ${cleanParams.mask.length}]`;
    }
    if (body.image && typeof body.image === 'string') {
      cleanParams.image = `[Base64 Image, len: ${body.image.length}]`;
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const model = body.model || cleanParams.model || 'N/A';
    const action = body.action || (type === 'upscale' ? 'upscale' : 'generate');
    const prompt = body.input || cleanParams.prompt || cleanParams.v4_prompt?.caption?.base_caption || '';
    const negPrompt = cleanParams.negative_prompt || cleanParams.uc || cleanParams.v4_negative_prompt?.caption?.base_caption || '';

    let safeError = '';
    if (details) {
      const status = details.statusCode || details.status || details.rawError?.statusCode;
      if (status) {
        safeError += `[Status ${status}] `;
      }

      const upstreamResp = details.upstreamResponse || details.rawError?.upstreamResponse;
      const errObj = details.error || details.message || details.rawError;

      if (upstreamResp) {
        if (typeof upstreamResp === 'string') {
          safeError += upstreamResp;
        } else if (Buffer.isBuffer(upstreamResp) || upstreamResp instanceof ArrayBuffer || ArrayBuffer.isView(upstreamResp)) {
          safeError += Buffer.from(upstreamResp).toString('utf8');
        } else if (typeof upstreamResp === 'object') {
          try {
            safeError += JSON.stringify(upstreamResp);
          } catch {
            safeError += String(upstreamResp);
          }
        } else {
          safeError += String(upstreamResp);
        }
      } else if (errObj) {
        if (typeof errObj === 'string') {
          safeError += errObj;
        } else if (Buffer.isBuffer(errObj) || errObj instanceof ArrayBuffer || ArrayBuffer.isView(errObj)) {
          safeError += Buffer.from(errObj).toString('utf8');
        } else if (typeof errObj === 'object') {
          try {
            safeError += JSON.stringify(errObj);
          } catch {
            safeError += (errObj.message || '[Unserializable Error]');
          }
        } else {
          safeError += String(errObj);
        }
      }

      if (details.rawError && details.rawError.message && !safeError.includes(details.rawError.message)) {
        safeError += ` | ${details.rawError.message}`;
      }
    }

    const logText = `[${dateStr} ${timeStr}] [${type.toUpperCase()}] [${status.toUpperCase()}] [IP: ${ip}] [Model: ${model}] [Action: ${action}]\n` +
      `  Size: ${cleanParams.width || 'N/A'}x${cleanParams.height || 'N/A'} | Steps: ${cleanParams.steps || 'N/A'} | Scale: ${cleanParams.scale || 'N/A'} | Sampler: ${cleanParams.sampler || 'N/A'} | Schedule: ${cleanParams.noise_schedule || 'karras'} | Seed: ${cleanParams.seed ?? 'random'}\n` +
      `  Prompt: ${JSON.stringify(prompt)}\n` +
      `  Negative: ${JSON.stringify(negPrompt)}${safeError ? `\n  Error: ${safeError}` : ''}\n\n`;

    fs.appendFile(logFile, logText, (err) => {
      if (err) console.error('[Logger] Failed to write generation log:', err.message);
    });

    if (status === 'failed') {
      writeServerLog('ERROR', `Generation failed [${type}]: ${safeError}`, details.rawError || details);
    }
  } catch (err) {
    console.error('[Logger] Error creating log entry:', err.message);
  }
}

module.exports = {
  logGeneration,
  writeServerLog,
  archivePastGenerationLogs,
  rotateServerLogs
};
