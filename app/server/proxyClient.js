const axios = require('axios');
const { getConfig } = require('./configManager');
const { queueManager } = require('./queueManager');
const { logGeneration, writeServerLog } = require('./logger');
const profileManager = require('./profileManager');
const { extractImageBuffer } = require('./zipExtractor');

function resolveToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader && !authHeader.includes('__BUILTIN__') && authHeader.trim().length > 10) {
    return authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
  }
  const cfg = getConfig();
  if (cfg.apiToken && cfg.apiToken.trim().length > 0) {
    const t = cfg.apiToken.trim();
    return t.startsWith('Bearer ') ? t : `Bearer ${t}`;
  }
  return null;
}

function getBaseUrl() {
  const cfg = getConfig();
  return (cfg.apiBaseUrl || 'https://image.novelai.net').trim().replace(/\/+$/, '');
}

function cleanNovelAIPayload(body) {
  if (!body || typeof body !== 'object') return body;
  const cleaned = { ...body };
  delete cleaned.profile;
  delete cleaned.originalPrompt;
  delete cleaned.originalParams;
  return cleaned;
}

function summarizePayload(body) {
  if (!body || typeof body !== 'object') return {};
  const copy = { ...body };
  if (copy.parameters) {
    copy.parameters = { ...copy.parameters };
    if (copy.parameters.image && typeof copy.parameters.image === 'string') {
      copy.parameters.image = `[base64 len: ${copy.parameters.image.length}]`;
    }
    if (copy.parameters.mask && typeof copy.parameters.mask === 'string') {
      copy.parameters.mask = `[base64 len: ${copy.parameters.mask.length}]`;
    }
  }
  if (copy.image && typeof copy.image === 'string') {
    copy.image = `[base64 len: ${copy.image.length}]`;
  }
  return copy;
}

function decodeErrorData(data) {
  if (!data) return data;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return { message: data };
    }
  }
  if (Buffer.isBuffer(data)) {
    const text = data.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const text = Buffer.from(data).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }
  if (typeof data === 'object') {
    return data;
  }
  return { message: String(data) };
}

async function forwardRequest(req, res, apiPath) {
  const token = resolveToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing NovelAI API token. Please configure it in Settings.' });
  }

  const isZip = req.headers.accept === 'application/zip';
  const customBase = getBaseUrl();
  const hosts = [customBase];
  if (apiPath.startsWith('/user/') && !hosts.includes('https://api.novelai.net')) {
    hosts.push('https://api.novelai.net');
  }

  let lastError = null;
  let response = null;

  for (const host of hosts) {
    const url = `${host}${apiPath}`;
    try {
      const axiosConfig = {
        method: req.method,
        url,
        params: req.query,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        responseType: isZip ? 'arraybuffer' : 'json',
        timeout: 30000
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
        axiosConfig.data = cleanNovelAIPayload(req.body);
      }

      response = await axios(axiosConfig);
      break;
    } catch (err) {
      lastError = err;
      if (err.response?.status === 401 || err.response?.status === 403) {
        break; // Stop fallback on auth errors
      }
    }
  }

  if (response) {
    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    const sendData = Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer 
      ? Buffer.from(response.data) 
      : response.data;
    return res.status(response.status).send(sendData);
  }

  const error = lastError || new Error(`Failed to forward request to ${apiPath}`);
  const upstreamStatus = error.response?.status;
  const data = decodeErrorData(error.response?.data);

  const errorLogMsg = `[Proxy] ForwardRequest Error [${apiPath}] ${error.message} (status: ${upstreamStatus || 'N/A'})`;
  console.error(errorLogMsg, data ? JSON.stringify(data) : '');
  writeServerLog('ERROR', errorLogMsg, { status: upstreamStatus, response: data, stack: error.stack });

  if (error.response) {
    return res.status(error.response.status).json(data || { error: error.message, status: upstreamStatus });
  }
  return res.status(500).json({ error: error.message || 'Upstream Proxy Error' });
}

async function generateImage(req, res) {
  const token = resolveToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing NovelAI API token. Please configure it in Settings.' });
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/ai/generate-image`;
  const naiBody = cleanNovelAIPayload(req.body);

  try {
    await queueManager.enqueue(req, res, async () => {
      console.log(`[Proxy] Sending generateImage request to upstream (model: ${naiBody?.model || 'nai-diffusion-5-full'})`);

      const response = await axios.post(url, naiBody, {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'Accept': 'application/zip',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        responseType: 'arraybuffer',
        timeout: 120000
      });

      logGeneration(req, 'normal', 'success');

      res.setHeader('Content-Type', 'application/zip');
      const sendData = Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer 
        ? Buffer.from(response.data) 
        : response.data;
      return res.status(201).send(sendData);
    });
  } catch (error) {
    if (res.headersSent) return;
    const upstreamStatus = error.response?.status;
    const parsedData = decodeErrorData(error.response?.data);

    const errorDetails = {
      message: error.message,
      statusCode: upstreamStatus,
      upstreamResponse: parsedData,
      url,
      stack: error.stack
    };

    console.error(`[Proxy] GenerateImage Error: ${error.message} [Upstream Status: ${upstreamStatus || 'N/A'}]`);
    if (parsedData) {
      console.error(`  Upstream Response:`, typeof parsedData === 'object' ? JSON.stringify(parsedData) : parsedData);
    }
    writeServerLog('ERROR', `GenerateImage failed [Upstream ${upstreamStatus || 'N/A'}]: ${error.message}`, errorDetails);
    logGeneration(req, 'normal', 'failed', {
      error: parsedData || error.message,
      statusCode: upstreamStatus,
      rawError: errorDetails
    });

    if (error.response) {
      return res.status(error.response.status).json(parsedData || { error: 'Upstream generation error', status: upstreamStatus });
    }
    return res.status(error.status || 500).json({ error: error.message || 'Internal Server Error', details: parsedData });
  }
}

async function generateImageStream(req, res) {
  const token = resolveToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing NovelAI API token. Please configure it in Settings.' });
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/ai/generate-image-stream`;
  const naiBody = cleanNovelAIPayload(req.body);

  try {
    await queueManager.enqueue(req, res, async () => {
      console.log(`[Proxy] Sending generateImageStream request to upstream (model: ${naiBody?.model || 'nai-diffusion-5-full'})`);

      const response = await axios.post(url, naiBody, {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        responseType: 'stream',
        timeout: 120000
      });

      logGeneration(req, 'stream', 'processing');

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      await new Promise((resolve, reject) => {
        response.data.pipe(res);
        response.data.on('end', () => resolve());
        response.data.on('close', () => resolve());
        response.data.on('error', (err) => reject(err));
        res.on('close', () => resolve());
      });
    });
  } catch (error) {
    if (res.headersSent) return;
    const upstreamStatus = error.response?.status;
    let errorData = error.response?.data;
    if (errorData && typeof errorData.on === 'function') {
      try {
        const chunks = [];
        for await (const chunk of errorData) {
          chunks.push(Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          errorData = JSON.parse(text);
        } catch {
          errorData = { message: text };
        }
      } catch {
        errorData = { message: error.message };
      }
    } else {
      errorData = decodeErrorData(errorData);
    }

    const errorDetails = {
      message: error.message,
      statusCode: upstreamStatus,
      upstreamResponse: errorData,
      url,
      stack: error.stack
    };

    console.error(`[Proxy] GenerateImageStream Error: ${error.message} [Upstream Status: ${upstreamStatus || 'N/A'}]`);
    if (errorData) {
      console.error(`  Upstream Response:`, typeof errorData === 'object' ? JSON.stringify(errorData) : errorData);
    }
    writeServerLog('ERROR', `GenerateImageStream failed [Upstream ${upstreamStatus || 'N/A'}]: ${error.message}`, errorDetails);
    logGeneration(req, 'stream', 'failed', {
      error: errorData || error.message,
      statusCode: upstreamStatus,
      rawError: errorDetails
    });

    if (error.response) {
      return res.status(error.response.status).json(errorData || { error: 'Upstream generation error', status: upstreamStatus });
    }
    return res.status(error.status || 500).json({ error: error.message || 'Internal Server Error', details: errorData });
  }
}

async function upscaleImage(req, res) {
  const token = resolveToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing NovelAI API token. Please configure it in Settings.' });
  }

  const { image, width, height, scale, model } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: '缺少待超分的图像数据 (image)' });
  }

  const rawBase64 = typeof image === 'string' && image.includes(',') ? image.split(',')[1] : image;
  const imageBuffer = Buffer.from(rawBase64, 'base64');

  let numWidth = Number(width);
  let numHeight = Number(height);
  const numScale = Number(scale) || 4;

  if (imageBuffer.length > 24 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4e && imageBuffer[3] === 0x47) {
    const pngWidth = imageBuffer.readUInt32BE(16);
    const pngHeight = imageBuffer.readUInt32BE(20);
    if (pngWidth > 0 && pngHeight > 0) {
      numWidth = pngWidth;
      numHeight = pngHeight;
    }
  }

  if (!numWidth || !numHeight) {
    return res.status(400).json({ error: '缺少图像分辨率参数 (width, height)' });
  }

  if (numScale !== 2 && numScale !== 4) {
    return res.status(400).json({ error: '放大倍率仅支持 2 或 4 (scale: 2 | 4)' });
  }

  if (numWidth * numHeight > 1048576) {
    const errorMsg = `原图尺寸 (${numWidth}x${numHeight} = ${numWidth * numHeight} 像素) 超出了官方超分限制 (最大 1,048,576 像素，约 1024x1024)`;
    logGeneration(req, 'upscale', 'failed', { error: errorMsg });
    return res.status(400).json({ error: errorMsg });
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/ai/upscale`;

  try {
    await queueManager.enqueue(req, res, async () => {
      const targetModel = model || 'nai-diffusion-5-full';
      console.log(`[Proxy] Sending upscale request to upstream (model: ${targetModel}, scale: ${numScale})`);

      const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}${Date.now().toString(36)}`;

      const part1Header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="blob"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      );
      const part1Footer = Buffer.from('\r\n');

      const requestJson = JSON.stringify({
        image: 'image',
        model: targetModel,
        declared_blur_sigma: 0
      });

      const part2Header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="request"; filename="blob"\r\n` +
        `Content-Type: application/json\r\n\r\n`
      );
      const part2Content = Buffer.from(requestJson, 'utf8');
      const part2Footer = Buffer.from(`\r\n--${boundary}--\r\n`);

      const multipartBody = Buffer.concat([
        part1Header,
        imageBuffer,
        part1Footer,
        part2Header,
        part2Content,
        part2Footer
      ]);

      const response = await axios.post(url, multipartBody, {
        headers: {
          'Authorization': token,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        responseType: 'arraybuffer',
        timeout: 180000
      });

      const rawBuffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);

      // Check if upstream returned an error JSON payload
      if (rawBuffer.length > 0 && rawBuffer[0] === 0x7b) {
        try {
          const json = JSON.parse(rawBuffer.toString('utf8'));
          if (json.errmsg || json.error || json.result === 'fail') {
            const errorMsg = json.errmsg || json.error || json.message || 'NovelAI 节点超时或失败';
            logGeneration(req, 'upscale', 'failed', { error: json });
            return res.status(504).json({
              success: false,
              error: `NovelAI 官方超分失败: ${errorMsg}`,
              details: json
            });
          }
        } catch {}
      }

      // Extract image buffer (from ZIP or raw binary)
      const extractedPng = await extractImageBuffer(rawBuffer);
      const profile = (req.body && req.body.profile) || req.headers['x-profile'] || 'Default';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Save to NAS disk: profiles/{profile}/images/{id}.png
      const imageUrl = profileManager.saveGeneratedImageFile(profile, id, extractedPng);

      const baseParams = req.body.originalParams ? JSON.parse(JSON.stringify(req.body.originalParams)) : {};
      baseParams.width = numWidth * numScale;
      baseParams.height = numHeight * numScale;
      baseParams.is_upscaled = true;
      if (req.body.originalPrompt) {
        baseParams.prompt = req.body.originalPrompt;
      }

      const generatedItem = {
        id,
        url: imageUrl,
        params: baseParams,
        timestamp: Date.now(),
        isUpscaled: true
      };

      // Record in profile history
      try {
        profileManager.addHistoryItem(profile, generatedItem);
      } catch (historyErr) {
        console.warn('[Proxy] Failed to record upscale to profile history:', historyErr.message);
      }

      logGeneration(req, 'upscale', 'success');

      return res.status(200).json({
        success: true,
        item: generatedItem,
        url: imageUrl
      });
    });
  } catch (error) {
    if (res.headersSent) return;
    const upstreamStatus = error.response?.status;
    const parsedData = decodeErrorData(error.response?.data);
    let errMsg = 'NovelAI 服务端超时或异常';
    if (parsedData) {
      errMsg = parsedData.errmsg || parsedData.error || parsedData.message || JSON.stringify(parsedData);
    } else if (error.message) {
      errMsg = error.message;
    }

    console.error(`[Proxy] Upscale Error: ${error.message} [Upstream Status: ${upstreamStatus || 'N/A'}]`);
    if (parsedData) {
      console.error(`  Upstream Response:`, typeof parsedData === 'object' ? JSON.stringify(parsedData) : parsedData);
    }
    writeServerLog('ERROR', `Upscale failed [Upstream ${upstreamStatus || 'N/A'}]: ${errMsg}`, { status: upstreamStatus, response: parsedData, stack: error.stack });
    logGeneration(req, 'upscale', 'failed', { error: parsedData || error.message, statusCode: upstreamStatus });

    return res.status(error.response?.status || 500).json({
      success: false,
      error: errMsg,
      details: parsedData
    });
  }
}

module.exports = {
  resolveToken,
  cleanNovelAIPayload,
  forwardRequest,
  generateImage,
  generateImageStream,
  upscaleImage
};
