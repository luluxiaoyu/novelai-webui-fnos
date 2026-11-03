const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { encryptionMiddleware } = require('./encryption');
const apiRoutes = require('./routes');
const { getConfig } = require('./configManager');

const app = express();

// Enable CORS
app.use(cors());

// fnOS Gateway Prefix Normalization and Redirect
app.use((req, res, next) => {
  const qIdx = req.url.indexOf('?');
  const pathname = qIdx !== -1 ? req.url.slice(0, qIdx) : req.url;
  const search = qIdx !== -1 ? req.url.slice(qIdx) : '';

  // 1. Redirect /app/novelai (without trailing slash) to /app/novelai/
  if (pathname === '/app/novelai') {
    return res.redirect(302, '/app/novelai/' + search);
  }

  // 2. Strip gateway prefix so subsequent static and API routes match cleanly
  if (pathname.startsWith('/app/novelai/')) {
    req.url = pathname.slice('/app/novelai'.length) + search;
  } else if (process.env.GATEWAY_PREFIX && pathname.startsWith(process.env.GATEWAY_PREFIX + '/')) {
    req.url = pathname.slice(process.env.GATEWAY_PREFIX.length) + search;
  } else if (pathname.includes('/index.cgi')) {
    const idx = pathname.indexOf('/index.cgi') + 10;
    let stripped = pathname.slice(idx) + search;
    if (!stripped.startsWith('/')) stripped = '/' + stripped;
    req.url = stripped;
  }

  next();
});

// Parse encrypted raw payloads first
app.use(express.raw({ type: ['application/encrypted', 'application/octet-stream'], limit: '100mb' }));

// Anti-sniffing XOR encryption middleware
app.use(encryptionMiddleware);

// Standard JSON and URL-encoded body parsers
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Mount API routes
app.use('/api', apiRoutes);

// Frontend static distribution path detection
const possibleUiPaths = [
  path.resolve(__dirname, '../ui/dist'),
  path.resolve(__dirname, '../../ui/dist'),
  path.resolve(__dirname, 'ui/dist'),
  path.resolve(process.cwd(), 'app/ui/dist'),
  path.resolve(process.cwd(), 'ui/dist'),
  path.resolve(process.cwd(), 'dist')
];

const uiDistPath = possibleUiPaths.find(p => fs.existsSync(p)) || path.resolve(__dirname, '../ui/dist');

if (fs.existsSync(uiDistPath)) {
  console.log(`[Server] Serving frontend from: ${uiDistPath}`);
  app.use(express.static(uiDistPath));
  
  // SPA fallback for non-API routes
  app.get(/^(?!\/api).+/, (req, res) => {
    res.sendFile(path.join(uiDistPath, 'index.html'));
  });
} else {
  console.warn(`[Server] Frontend dist directory not found at: ${uiDistPath}`);
  app.get('/', (req, res) => {
    res.send('NovelAI WebUI backend is running (Frontend build not found).');
  });
}

const { writeServerLog } = require('./logger');

// Global exception handling
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
  writeServerLog('FATAL', 'Uncaught Exception: ' + err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
  writeServerLog('FATAL', 'Unhandled Rejection: ' + (reason?.message || String(reason)), reason?.stack || reason);
});

// 1. Listen on HTTP port (gracefully handles EADDRINUSE so socket gateway remains active)
const PORT = process.env.PORT || 3000;
let httpServer = null;
if (PORT && PORT !== '0') {
  httpServer = http.createServer(app);
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Server] Warning: Port ${PORT} is in use by another service. Skipping HTTP port binding; Unix socket gateway remains fully operational.`);
    } else {
      console.error('[Server] HTTP server error:', err.message);
    }
  });
  httpServer.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`[Server] NovelAI WebUI listening on HTTP port: ${PORT}`);
  });
}

// 2. Listen on Unix domain socket for fnOS desktop iframe gateway
const SOCKET_PATH = process.env.SOCKET_PATH;
let socketServer = null;

if (SOCKET_PATH) {
  try {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  } catch (e) {
    console.warn('[Server] Could not unlink existing socket:', e.message);
  }

  socketServer = http.createServer(app);
  socketServer.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o777);
    } catch (e) {
      console.warn('[Server] Could not chmod socket:', e.message);
    }
    console.log(`[Server] NovelAI WebUI listening on Unix socket: ${SOCKET_PATH}`);
  });
}

// Graceful shutdown
function shutdown() {
  console.log('[Server] Shutting down service...');
  if (httpServer) httpServer.close();
  if (socketServer) {
    socketServer.close();
    try {
      if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    } catch (e) {}
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
