const { getConfig } = require('./configManager');

function xorBuffer(data, key) {
  const result = Buffer.allocUnsafe(data.length);
  const keyBuffer = Buffer.from(key, 'utf8');
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ keyBuffer[i % keyBuffer.length];
  }
  return result;
}

function getEncryptionKey(clientKey) {
  const cfg = getConfig();
  if (cfg.encryptionKey && cfg.encryptionKey.trim()) {
    return cfg.encryptionKey.trim();
  }
  if (clientKey && typeof clientKey === 'string' && clientKey.trim()) {
    return clientKey.trim();
  }
  return 'nahida1027';
}

function encryptionMiddleware(req, res, next) {
  const cfg = getConfig();
  if (!cfg.enableEncryption || req.headers['x-encrypted'] !== '1') {
    return next();
  }

  const clientKey = (req.headers['x-access-key'] || '').trim();
  const key = getEncryptionKey(clientKey);
  const keyBuf = Buffer.from(key, 'utf8');

  // Decrypt incoming body if it was captured as a Buffer
  if (Buffer.isBuffer(req.body)) {
    let success = false;
    try {
      const decrypted = Buffer.allocUnsafe(req.body.length);
      for (let i = 0; i < req.body.length; i++) {
        decrypted[i] = req.body[i] ^ keyBuf[i % keyBuf.length];
      }
      req.body = JSON.parse(decrypted.toString('utf8'));
      success = true;
    } catch (err) {
      console.error('[Encryption] Failed to decrypt/parse request body with key:', err.message);
    }

    if (!success) {
      return res.status(400).send('Decryption failed');
    }
  }

  const originalSend = res.send;
  const originalJson = res.json;
  const originalWrite = res.write;

  let responseOffset = 0;

  res.json = function (obj) {
    const jsonStr = JSON.stringify(obj);
    const buffer = Buffer.from(jsonStr, 'utf8');
    const encrypted = Buffer.allocUnsafe(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      encrypted[i] = buffer[i] ^ keyBuf[i % keyBuf.length];
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('x-encrypted', '1');
    return originalSend.call(this, encrypted);
  };

  res.send = function (body) {
    if (body !== undefined && body !== null) {
      let buffer;
      if (Buffer.isBuffer(body)) {
        buffer = body;
      } else if (typeof body === 'string') {
        buffer = Buffer.from(body, 'utf8');
      } else {
        buffer = Buffer.from(JSON.stringify(body), 'utf8');
      }
      const encrypted = Buffer.allocUnsafe(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        encrypted[i] = buffer[i] ^ keyBuf[i % keyBuf.length];
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('x-encrypted', '1');
      return originalSend.call(this, encrypted);
    }
    return originalSend.call(this, body);
  };

  res.write = function (chunk, encoding, callback) {
    if (chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
      const encrypted = Buffer.allocUnsafe(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        encrypted[i] = buffer[i] ^ keyBuf[(responseOffset + i) % keyBuf.length];
      }
      responseOffset += buffer.length;
      return originalWrite.call(this, encrypted, 'binary', callback);
    }
    return originalWrite.call(this, chunk, encoding, callback);
  };

  next();
}

module.exports = {
  xorBuffer,
  getEncryptionKey,
  encryptionMiddleware
};
