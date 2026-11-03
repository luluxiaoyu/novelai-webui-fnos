const http = require('http');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '../..');
const SOCKET_PATH = path.join(APP_DIR, 'app.sock');

// CGI environment variables
const method = process.env.REQUEST_METHOD || 'GET';
const requestUri = process.env.REQUEST_URI || '/';
const contentType = process.env.CONTENT_TYPE || '';
const contentLength = process.env.CONTENT_LENGTH ? parseInt(process.env.CONTENT_LENGTH, 10) : 0;

// Reconstruct headers from HTTP_* environment variables
const headers = {};
if (contentType) headers['content-type'] = contentType;
if (contentLength) headers['content-length'] = contentLength;

for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('HTTP_')) {
    const headerName = key.slice(5).toLowerCase().replace(/_/g, '-');
    headers[headerName] = value;
  }
}

// Check if app.sock exists
if (!fs.existsSync(SOCKET_PATH)) {
  console.log("Status: 503 Service Unavailable");
  console.log("Content-Type: text/plain; charset=utf-8");
  console.log("");
  console.log("NovelAI service is starting or not running. Please start the app from fnOS App Center.");
  process.exit(0);
}

const reqOptions = {
  socketPath: SOCKET_PATH,
  path: requestUri,
  method,
  headers
};

const clientReq = http.request(reqOptions, (clientRes) => {
  // Output CGI Status
  process.stdout.write(`Status: ${clientRes.statusCode} ${clientRes.statusMessage || 'OK'}\r\n`);
  
  // Output headers
  for (const [header, val] of Object.entries(clientRes.headers)) {
    if (Array.isArray(val)) {
      for (const v of val) {
        process.stdout.write(`${header}: ${v}\r\n`);
      }
    } else {
      process.stdout.write(`${header}: ${val}\r\n`);
    }
  }
  process.stdout.write('\r\n');

  // Pipe body to stdout
  clientRes.pipe(process.stdout);
});

clientReq.on('error', (err) => {
  console.log("Status: 502 Bad Gateway");
  console.log("Content-Type: text/plain; charset=utf-8");
  console.log("");
  console.log(`Failed to connect to backend service: ${err.message}`);
  process.exit(0);
});

if (contentLength > 0 || method === 'POST' || method === 'PUT') {
  process.stdin.pipe(clientReq);
} else {
  clientReq.end();
}
