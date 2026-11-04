const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const TEST_DIR = path.join(os.tmpdir(), `novelai_upscale_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
process.env.NOVELAI_SHARE_DIR = TEST_DIR;

const configManager = require('../configManager');
configManager.updateConfig({ 
  storagePath: TEST_DIR, 
  activeProfile: 'Default',
  apiToken: 'Bearer test-token-1234567890'
});

const profileManager = require('../profileManager');
const proxyClient = require('../proxyClient');

// Valid 1x1 pixel transparent PNG
const VALID_1X1_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_1X1_PNG_BUFFER = Buffer.from(VALID_1X1_PNG_BASE64, 'base64');

describe('Image Upscale & Payload Resolution Tests', () => {
  let savedLocalImgUrl;
  let savedLocalImgPath;
  let savedSubdirImgUrl;
  let savedSubdirImgPath;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Save a test image in Default profile root
    const imgId = 'upscale-test-img-1';
    savedLocalImgUrl = profileManager.saveGeneratedImageFile('Default', imgId, VALID_1X1_PNG_BUFFER);
    savedLocalImgPath = profileManager.getImagePath('Default', imgId);

    // Save another test image in a nested subdirectory
    configManager.updateConfig({ imageSubdirPattern: '{year}/{month}' });
    const imgSubdirId = 'upscale-test-img-subdir';
    savedSubdirImgUrl = profileManager.saveGeneratedImageFile('Default', imgSubdirId, VALID_1X1_PNG_BUFFER, {
      timestamp: Date.now()
    });
    savedSubdirImgPath = profileManager.getImagePath('Default', imgSubdirId);
  });

  after(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  test('1. resolveImageBuffer resolves base64 Data URL', async () => {
    const dataUrl = `data:image/png;base64,${VALID_1X1_PNG_BASE64}`;
    const buf = await proxyClient.resolveImageBuffer(dataUrl, 'Default');
    assert.ok(Buffer.isBuffer(buf), 'Should return a Buffer');
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);
  });

  test('2. resolveImageBuffer resolves raw base64 string', async () => {
    const buf = await proxyClient.resolveImageBuffer(VALID_1X1_PNG_BASE64, 'Default');
    assert.ok(Buffer.isBuffer(buf), 'Should return a Buffer');
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);
  });

  test('3. resolveImageBuffer resolves local NAS API URL (/api/images/Default/...)', async () => {
    const buf = await proxyClient.resolveImageBuffer(savedLocalImgUrl, 'Default');
    assert.ok(Buffer.isBuffer(buf), 'Should read file from local disk via URL');
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);

    const subBuf = await proxyClient.resolveImageBuffer(savedSubdirImgUrl, 'Default');
    assert.ok(Buffer.isBuffer(subBuf), 'Should read nested subdirectory file from local disk via URL');
    assert.deepEqual(subBuf, VALID_1X1_PNG_BUFFER);
  });

  test('4. resolveImageBuffer resolves fnOS Gateway prefix URL (/app/novelai/api/images/...)', async () => {
    const gatewayUrl = `/app/novelai${savedSubdirImgUrl}`;
    const buf = await proxyClient.resolveImageBuffer(gatewayUrl, 'Default');
    assert.ok(Buffer.isBuffer(buf), 'Should strip gateway prefix and resolve from local disk');
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);
  });

  test('5. resolveImageBuffer resolves full origin URL (http://localhost:8080/api/images/...)', async () => {
    const fullUrl = `http://192.168.1.100:8080${savedLocalImgUrl}`;
    const buf = await proxyClient.resolveImageBuffer(fullUrl, 'Default');
    assert.ok(Buffer.isBuffer(buf), 'Should extract /api/images/ path from full URL');
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);

    const fullGatewayUrl = `https://nas.example.com:5000/app/novelai${savedSubdirImgUrl}?cache=123`;
    const gatewayBuf = await proxyClient.resolveImageBuffer(fullGatewayUrl, 'Default');
    assert.ok(Buffer.isBuffer(gatewayBuf), 'Should handle full URL with gateway prefix and query string');
    assert.deepEqual(gatewayBuf, VALID_1X1_PNG_BUFFER);
  });

  test('6. resolveImageBuffer resolves absolute disk path', async () => {
    assert.ok(savedLocalImgPath && fs.existsSync(savedLocalImgPath));
    const buf = await proxyClient.resolveImageBuffer(savedLocalImgPath, 'Default');
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);
  });

  test('7. resolveImageBuffer resolves direct image ID or filename', async () => {
    const buf = await proxyClient.resolveImageBuffer('upscale-test-img-1', 'Default');
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(buf, VALID_1X1_PNG_BUFFER);
  });

  test('8. resolveImageBuffer returns null for invalid / empty inputs', async () => {
    assert.equal(await proxyClient.resolveImageBuffer(null), null);
    assert.equal(await proxyClient.resolveImageBuffer(''), null);
    assert.equal(await proxyClient.resolveImageBuffer('   '), null);
    assert.equal(await proxyClient.resolveImageBuffer(12345), null);
    assert.equal(await proxyClient.resolveImageBuffer('short_invalid'), null);
    // Non-existent local URL must return null, NOT decode to garbage buffer
    assert.equal(await proxyClient.resolveImageBuffer('/api/images/Default/non_existent_img.png'), null);
    // Malformed URI escape sequence must not throw URIError
    assert.equal(await proxyClient.resolveImageBuffer('/api/images/Default/bad%99%malformed.png'), null);
  });

  test('9. cleanNovelAIPayload strips metadata and base64 prefixes', () => {
    const dirty = {
      profile: 'MyProfile',
      originalPrompt: 'masterpiece',
      originalParams: { foo: 'bar' },
      model: 'nai-diffusion-5-full',
      parameters: {
        image: 'data:image/png;base64,RAWIMAGE123',
        mask: 'data:image/png;base64,RAWMASK456'
      },
      image: 'data:image/png;base64,RAWIMG789'
    };

    const cleaned = proxyClient.cleanNovelAIPayload(dirty);
    assert.equal(cleaned.profile, undefined);
    assert.equal(cleaned.originalPrompt, undefined);
    assert.equal(cleaned.originalParams, undefined);
    assert.equal(cleaned.parameters.image, 'RAWIMAGE123');
    assert.equal(cleaned.parameters.mask, 'RAWMASK456');
    assert.equal(cleaned.image, 'RAWIMG789');
  });

  test('10. upscaleImage rejects missing image with 400', async () => {
    const req = {
      headers: { authorization: 'Bearer test-token-1234567890' },
      body: { scale: 2 }
    };
    let statusCode = 200;
    let resData = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { resData = data; }
    };

    await proxyClient.upscaleImage(req, res);
    assert.equal(statusCode, 400);
    assert.ok(resData.error.includes('缺少待超分的图像数据'));
  });

  test('11. upscaleImage rejects non-PNG format with 400 without contacting upstream', async () => {
    // Non-PNG valid JPEG data URL
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const req = {
      headers: { authorization: 'Bearer test-token-1234567890' },
      body: {
        image: jpegDataUrl,
        width: 512,
        height: 512,
        scale: 2
      }
    };
    let statusCode = 200;
    let resData = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { resData = data; }
    };

    await proxyClient.upscaleImage(req, res);
    assert.equal(statusCode, 400);
    assert.ok(resData.error.includes('PNG'));

    // Unresolvable text string is also rejected with 400
    const unresolvableReq = {
      headers: { authorization: 'Bearer test-token-1234567890' },
      body: {
        image: 'This is not an image and definitely not a PNG',
        width: 512,
        height: 512,
        scale: 2
      }
    };
    let unresStatus = 200;
    let unresData = null;
    const unresRes = {
      status(code) { unresStatus = code; return this; },
      json(data) { unresData = data; }
    };
    await proxyClient.upscaleImage(unresolvableReq, unresRes);
    assert.equal(unresStatus, 400);
    assert.ok(unresData.error.includes('无法读取'));
  });

  test('12. upscaleImage rejects image exceeding 1,048,576 pixels with 400', async () => {
    // Construct oversized PNG buffer (2000 x 2000 = 4,000,000 pixels)
    const bigPng = Buffer.from(VALID_1X1_PNG_BUFFER);
    bigPng.writeUInt32BE(2000, 16);
    bigPng.writeUInt32BE(2000, 20);

    const req = {
      headers: { authorization: 'Bearer test-token-1234567890' },
      body: {
        image: `data:image/png;base64,${bigPng.toString('base64')}`,
        scale: 2
      }
    };
    let statusCode = 200;
    let resData = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { resData = data; }
    };

    await proxyClient.upscaleImage(req, res);
    assert.equal(statusCode, 400);
    assert.ok(resData.error.includes('超出了官方超分限制'));
  });

  test('13. upscaleImage rejects invalid scale with 400', async () => {
    const req = {
      headers: { authorization: 'Bearer test-token-1234567890' },
      body: {
        image: `data:image/png;base64,${VALID_1X1_PNG_BASE64}`,
        scale: 3
      }
    };
    let statusCode = 200;
    let resData = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { resData = data; }
    };

    await proxyClient.upscaleImage(req, res);
    assert.equal(statusCode, 400);
    assert.ok(resData.error.includes('放大倍率仅支持 2 或 4'));
  });

  test('14. upscaleImage with local NAS URL sends valid multipart request and saves upscaled result', async () => {
    // Intercept axios.post to upstream /ai/upscale to mock NovelAI GPU cluster response
    const originalPost = axios.post;
    let sentBoundary = null;
    let sentContentType = null;
    let sentMultipartBuffer = null;

    axios.post = async function(url, data, config) {
      if (url.includes('/ai/upscale')) {
        sentContentType = config.headers['Content-Type'];
        sentMultipartBuffer = data;

        // Return upscaled 2x2 PNG
        const upscaledPng = Buffer.from(VALID_1X1_PNG_BUFFER);
        upscaledPng.writeUInt32BE(2, 16);
        upscaledPng.writeUInt32BE(2, 20);

        return {
          status: 200,
          data: upscaledPng,
          headers: { 'content-type': 'image/png' }
        };
      }
      return originalPost.apply(this, arguments);
    };

    try {
      const req = {
        headers: { 
          authorization: 'Bearer test-token-1234567890',
          'x-profile': 'Default'
        },
        body: {
          image: savedLocalImgUrl, // Local NAS URL: /api/images/Default/...
          scale: 2,
          originalPrompt: '1girl, smiling',
          originalParams: { model: 'nai-diffusion-5-full' }
        }
      };

      let statusCode = 200;
      let resData = null;
      const res = {
        headersSent: false,
        status(code) { statusCode = code; return this; },
        setHeader() {},
        json(data) { resData = data; this.headersSent = true; }
      };

      await proxyClient.upscaleImage(req, res);

      assert.equal(statusCode, 200);
      assert.equal(resData.success, true);
      assert.ok(resData.url.startsWith('/api/images/Default/'));
      assert.equal(resData.item.isUpscaled, true);
      assert.equal(resData.item.params.width, 2);
      assert.equal(resData.item.params.height, 2);
      assert.equal(resData.item.params.is_upscaled, true);

      assert.equal(resData.item.prompt, '1girl, smiling');
      assert.equal(resData.item.model, 'nai-diffusion-5-full');
      assert.equal(resData.item.params.model, 'nai-diffusion-5-full');

      // Verify multipart payload sent to NovelAI
      assert.ok(sentContentType.includes('multipart/form-data; boundary='));
      assert.ok(Buffer.isBuffer(sentMultipartBuffer));
      // Verify that the binary PNG was included in multipart data
      assert.ok(sentMultipartBuffer.includes(VALID_1X1_PNG_BUFFER));

      // Verify that the saved upscaled image file exists on NAS disk
      const savedPath = profileManager.getImagePath('Default', resData.item.id);
      assert.ok(savedPath && fs.existsSync(savedPath));
      assert.equal(fs.statSync(savedPath).size, VALID_1X1_PNG_BUFFER.length);

      // Verify it was added to profile history
      const history = profileManager.getHistory('Default', { limit: 10 });
      const foundInHistory = history.history.find(h => h.id === resData.item.id);
      assert.ok(foundInHistory);
      assert.equal(foundInHistory.isUpscaled, true);
      assert.equal(foundInHistory.model, 'nai-diffusion-5-full');
    } finally {
      axios.post = originalPost;
    }
  });

  test('15. upscaleImage defaults scale to 2 and handles cross-profile image URLs', async () => {
    // Save image in secondary profile
    profileManager.createProfile('Secondary');
    const secImgUrl = profileManager.saveGeneratedImageFile('Secondary', 'sec-img-1', VALID_1X1_PNG_BUFFER);
    assert.ok(secImgUrl.includes('Secondary'));

    const originalPost = axios.post;
    let recordedScale = null;

    axios.post = async function(url, data, config) {
      if (url.includes('/ai/upscale')) {
        const upscaledPng = Buffer.from(VALID_1X1_PNG_BUFFER);
        upscaledPng.writeUInt32BE(2, 16);
        upscaledPng.writeUInt32BE(2, 20);
        return {
          status: 200,
          data: upscaledPng,
          headers: { 'content-type': 'image/png' }
        };
      }
      return originalPost.apply(this, arguments);
    };

    try {
      const req = {
        headers: { 
          authorization: 'Bearer test-token-1234567890',
          'x-profile': 'Default'
        },
        body: {
          image: secImgUrl // URL contains Secondary profile
          // scale omitted -> should default to 2
        }
      };

      let statusCode = 200;
      let resData = null;
      const res = {
        headersSent: false,
        status(code) { statusCode = code; return this; },
        setHeader() {},
        json(data) { resData = data; this.headersSent = true; }
      };

      await proxyClient.upscaleImage(req, res);
      assert.equal(statusCode, 200);
      assert.equal(resData.success, true);
      assert.equal(resData.item.params.width, 2);
      assert.equal(resData.item.params.height, 2);
    } finally {
      axios.post = originalPost;
    }
  });
});
