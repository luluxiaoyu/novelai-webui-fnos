const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `novelai_routes_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
process.env.NOVELAI_SHARE_DIR = TEST_DIR;

const configManager = require('../configManager');
configManager.updateConfig({ storagePath: TEST_DIR, activeProfile: 'Default' });

const profileDb = require('../profileDb');
const profileManager = require('../profileManager');

let app;

function invoke(method, urlPath, body = null) {
  return new Promise((resolve) => {
    let qIdx = urlPath.indexOf('?');
    let pathOnly = qIdx !== -1 ? urlPath.slice(0, qIdx) : urlPath;
    let queryStr = qIdx !== -1 ? urlPath.slice(qIdx + 1) : '';
    let query = {};
    if (queryStr) {
      const sp = new URLSearchParams(queryStr);
      for (const [k, v] of sp.entries()) query[k] = v;
    }

    let statusCode = 200;
    const resHeaders = {};

    const req = {
      method: method.toUpperCase(),
      url: urlPath,
      originalUrl: urlPath,
      path: pathOnly,
      query,
      body: body || {},
      headers: {
        'content-type': 'application/json'
      }
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = v;
      },
      json(data) {
        resolve({ status: statusCode, headers: resHeaders, data });
      },
      send(data) {
        resolve({ status: statusCode, headers: resHeaders, data });
      },
      sendFile(filePath) {
        resolve({ status: statusCode, headers: resHeaders, filePath });
      }
    };

    app(req, res, () => {
      resolve({ status: 404, headers: resHeaders, data: { error: 'Not found' } });
    });
  });
}

describe('Express HTTP API & Routes In-Process Tests', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const express = require('express');
    const routes = require('../routes');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
  });

  after(() => {
    profileDb.closeAllDbs();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  test('1. GET /api/profiles and POST /api/profiles', async () => {
    const resList = await invoke('GET', '/api/profiles');
    assert.equal(resList.status, 200);
    assert.equal(resList.data.success, true);
    assert.ok(resList.data.profiles.includes('Default'));

    const resCreate = await invoke('POST', '/api/profiles', { name: 'ArtProfile' });
    assert.equal(resCreate.status, 200);
    assert.equal(resCreate.data.success, true);
    assert.equal(resCreate.data.profile, 'ArtProfile');

    const resList2 = await invoke('GET', '/api/profiles');
    assert.ok(resList2.data.profiles.includes('ArtProfile'));
  });

  test('2. POST /api/profiles/data and GET /api/profiles/data', async () => {
    const profile = 'ArtProfile';
    const payload = {
      profile,
      data: {
        params: { prompt: 'masterpiece, anime girl', model: 'nai-diffusion-4-full' },
        promptHistory: [
          { id: 'p1', prompt: 'sunset over ocean', negative_prompt: 'dark' }
        ],
        savedPromptGroups: ['Ocean', 'Sunset'],
        customCharacters: [
          { id: 'c1', name: 'Furina', prompt: 'furina(genshin impact)', uc: 'lowres' }
        ],
        customStyles: [
          { id: 's1', name: 'Oil Painting', prompt: 'oil on canvas', uc: 'digital' }
        ]
      }
    };

    const resSave = await invoke('POST', '/api/profiles/data', payload);
    assert.equal(resSave.status, 200);
    assert.equal(resSave.data.success, true);

    const resGet = await invoke('GET', `/api/profiles/data?profile=${profile}`);
    assert.equal(resGet.status, 200);
    assert.equal(resGet.data.success, true);
    assert.equal(resGet.data.profile, profile);

    const d = resGet.data.data;
    assert.equal(d.params.prompt, 'masterpiece, anime girl');
    assert.equal(d.promptHistory.length, 1);
    assert.equal(d.promptHistory[0].prompt, 'sunset over ocean');
    assert.deepEqual(d.savedPromptGroups.sort(), ['Ocean', 'Sunset']);
    assert.equal(d.customCharacters.length, 1);
    assert.equal(d.customCharacters[0].name, 'Furina');
    assert.equal(d.customStyles.length, 1);
    assert.equal(d.customStyles[0].name, 'Oil Painting');
  });

  test('3. POST /api/profiles/images/save and GET /api/profiles/history', async () => {
    const profile = 'ArtProfile';
    const sampleB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    for (let i = 1; i <= 6; i++) {
      const resImg = await invoke('POST', '/api/profiles/images/save', {
        profile,
        item: {
          id: `test-img-${i}`,
          image: sampleB64,
          timestamp: 1700000000000 + i * 1000,
          params: { prompt: `image prompt number ${i}`, model: 'nai-diffusion-4-full' }
        }
      });
      assert.equal(resImg.status, 200);
      assert.equal(resImg.data.success, true);
      assert.equal(resImg.data.item.id, `test-img-${i}`);
    }

    // Query history with pagination
    const resHistory = await invoke('GET', `/api/profiles/history?profile=${profile}&page=1&pageSize=3`);
    assert.equal(resHistory.status, 200);
    assert.equal(resHistory.data.success, true);
    assert.equal(resHistory.data.total, 6);
    assert.equal(resHistory.data.totalPages, 2);
    assert.equal(resHistory.data.history.length, 3);
    assert.equal(resHistory.data.history[0].id, 'test-img-6'); // latest first

    // Query history page 2
    const resHistP2 = await invoke('GET', `/api/profiles/history?profile=${profile}&page=2&pageSize=3`);
    assert.equal(resHistP2.data.history.length, 3);
    assert.equal(resHistP2.data.history[0].id, 'test-img-3');

    // History search
    const resSearch = await invoke('GET', `/api/profiles/history?profile=${profile}&search=prompt%20number%202`);
    assert.equal(resSearch.data.total, 1);
    assert.equal(resSearch.data.history[0].id, 'test-img-2');
  });

  test('4. DELETE /api/profiles/images/:id and POST /api/profiles/images/delete-batch', async () => {
    const profile = 'ArtProfile';

    // Delete single
    const resDel1 = await invoke('DELETE', `/api/profiles/images/test-img-1?profile=${profile}`);
    assert.equal(resDel1.status, 200);
    assert.equal(resDel1.data.success, true);

    const countAfter1 = (await invoke('GET', `/api/profiles/history?profile=${profile}`)).data.total;
    assert.equal(countAfter1, 5);

    // Batch delete
    const resBatch = await invoke('POST', `/api/profiles/images/delete-batch`, {
      profile,
      ids: ['test-img-2', 'test-img-3']
    });
    assert.equal(resBatch.status, 200);
    assert.equal(resBatch.data.success, true);

    const countAfterBatch = (await invoke('GET', `/api/profiles/history?profile=${profile}`)).data.total;
    assert.equal(countAfterBatch, 3);
  });

  test('5. Image serving endpoint GET /api/images/:profile/:id', async () => {
    const profile = 'ArtProfile';
    const resImg = await invoke('GET', `/api/images/${profile}/test-img-6.png`);
    assert.equal(resImg.status, 200);
    assert.ok(resImg.filePath.endsWith('test-img-6.png'));
    assert.ok(fs.existsSync(resImg.filePath));
  });

  test('6. Resilience to invalid pagination query parameters', async () => {
    const profile = 'ArtProfile';
    // Invalid limit, page, and startTime should not return 500 error
    const res = await invoke('GET', `/api/profiles/history?profile=${profile}&limit=invalid&page=bad&startTime=not-a-number`);
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(Array.isArray(res.data.history));
  });

  test('7. Save image with item.url and isUpscaled flag preserved', async () => {
    const profile = 'ArtProfile';
    const sampleB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const res = await invoke('POST', '/api/profiles/images/save', {
      profile,
      item: {
        id: 'upscaled-img-1',
        url: `data:image/png;base64,${sampleB64}`,
        prompt: 'upscaled masterpiece',
        isUpscaled: true,
        timestamp: Date.now()
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.item.isUpscaled, true);

    const histRes = await invoke('GET', `/api/profiles/history?profile=${profile}&search=upscaled`);
    assert.equal(histRes.status, 200);
    assert.equal(histRes.data.total, 1);
    assert.equal(histRes.data.history[0].isUpscaled, true);
  });

  test('8. GET /profiles/images/disk-path resolves existing disk path and handles missing', async () => {
    const profile = 'ArtProfile';
    // Test resolving the image saved in test 7
    const res = await invoke('GET', `/api/profiles/images/disk-path?profile=${profile}&id=upscaled-img-1`);
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(typeof res.data.path === 'string');
    assert.ok(fs.existsSync(res.data.path));

    // Test missing image
    const missingRes = await invoke('GET', `/api/profiles/images/disk-path?profile=${profile}&id=no_such_img_xyz`);
    assert.equal(missingRes.status, 404);
  });
});
