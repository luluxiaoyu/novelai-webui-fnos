const http = require('node:http');

const isFnosRuntime = () => Boolean(process.env.TRIM_APPNAME || process.env.TRIM_APPDEST || process.env.TRIM_PKGVAR);

function canManageStorage(req) {
  return !isFnosRuntime() || req.headers['x-trim-isadmin'] === 'true';
}

function assertStorageAdmin(req) {
  if (!canManageStorage(req)) {
    const error = new Error('仅飞牛管理员可管理应用存储目录');
    error.statusCode = 403;
    throw error;
  }
}

// The credential is injected by fnOS and must never be persisted or sent to the browser.
function callFnosApi(method, data = {}) {
  const token = process.env.TRIM_API_TOKEN;
  if (!token) return Promise.reject(new Error('系统未提供开放 API 凭据；请确认 fnOS 支持开放 API，并重新启动应用'));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ req: method, appName: process.env.TRIM_APPNAME || 'novelai', data });
    const request = http.request({
      socketPath: '/var/run/trim_open_gateway_apiscope.socket',
      path: '/api/v1/trimapp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` }
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', chunk => {
        responseBody += chunk;
        if (responseBody.length > 1024 * 1024) request.destroy(new Error('飞牛开放 API 响应过大'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`飞牛开放 API 请求失败（HTTP ${response.statusCode}）`);
          const result = JSON.parse(responseBody);
          if (result.code !== 0) throw new Error(result.msg || `飞牛开放 API 调用失败（${result.code}）`);
          resolve(result.data);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('飞牛开放 API 请求超时')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}

async function checkUserPaths(req, paths) {
  const rawUid = req.headers['x-trim-userid'];
  const uid = Number(rawUid);
  if (!rawUid || !Number.isSafeInteger(uid) || uid < 0) throw new Error('缺少飞牛网关用户身份，请从飞牛桌面打开应用');
  const result = await callFnosApi('trim.file.checkUserACL', { uid, path: paths });
  if (!Array.isArray(result)) throw new Error('飞牛文件权限响应格式无效');
  return result;
}

module.exports = { isFnosRuntime, canManageStorage, assertStorageAdmin, callFnosApi, checkUserPaths };
