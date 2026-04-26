require('dotenv').config();
const socks = require('socksv5');
const WebSocket = require('ws');

const VERSION = '1.1.2';
const LOCAL_PORT = process.env.LOCAL_PORT || 1080;
const REMOTE_URL = process.env.REMOTE_URL || 'https://proxy-il1y.onrender.com';
const AUTH_USER = process.env.AUTH_USER || 'dandon';
const AUTH_PASS = process.env.AUTH_PASS || 'pulk';
const AUTH_STR = `${AUTH_USER}:${AUTH_PASS}`;

const SOCKS_USER = process.env.SOCKS_USER || 'dandon';
const SOCKS_PASS = process.env.SOCKS_PASS || 'pulk';

const getWsUrl = (url) => {
  let wsUrl = url.trim();
  if (wsUrl.startsWith('http')) {
    wsUrl = wsUrl.replace(/^http/, 'ws');
  } else if (!wsUrl.startsWith('ws')) {
    wsUrl = 'wss://' + wsUrl;
  }
  return wsUrl;
};

const WS_TARGET = getWsUrl(REMOTE_URL);

console.log(`[Client v${VERSION}] Starting...`);

const srv = socks.createServer((info, accept, deny) => {
  const targetLabel = `${info.dstAddr}:${info.dstPort}`;
  const clientSocket = accept(true);
  if (!clientSocket) return;

  const ws = new WebSocket(WS_TARGET, {
    headers: { 'User-Agent': `Proxy-Client/${VERSION}` },
    handshakeTimeout: 10000
  });

  let isBridgeReady = false;
  const buffer = [];

  // Пинг сервера каждые 20 секунд для поддержания жизни на Render
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20000);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      auth: AUTH_STR,
      host: info.dstAddr,
      port: info.dstPort
    }));
  });

  ws.on('message', (data, isBinary) => {
    if (!isBridgeReady) {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.status === 'connected') {
          isBridgeReady = true;
          console.log(`[WS] OK -> ${targetLabel}`);
          while (buffer.length > 0) {
            ws.send(buffer.shift(), { binary: true });
          }
        } else {
          console.error(`[WS] Rejected: ${msg.message || 'Unknown error'}`);
          ws.close();
        }
      } catch (e) {
        ws.close();
      }
    } else {
      if (clientSocket.writable) clientSocket.write(data);
    }
  });

  clientSocket.on('data', (data) => {
    if (isBridgeReady) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    } else {
      buffer.push(data);
      if (buffer.length > 500) { // Лимит буфера
        clientSocket.destroy();
        ws.close();
      }
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingInterval);
    if (code !== 1000) console.log(`[WS] Closed: ${targetLabel} (Code: ${code})`);
    clientSocket.destroy();
  });

  ws.on('error', (err) => {
    clearInterval(pingInterval);
    console.error(`[WS Error] ${targetLabel}: ${err.message}`);
    clientSocket.destroy();
  });

  clientSocket.on('close', () => {
    clearInterval(pingInterval);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  });
});

srv.listen(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`--------------------------------------------------`);
  console.log(`SOCKS5 Proxy v${VERSION} on port ${LOCAL_PORT}`);
  console.log(`Tunnel: ${WS_TARGET}`);
  console.log(`--------------------------------------------------`);
});

srv.useAuth(socks.auth.UserPassword((user, password, cb) => {
  cb(user === SOCKS_USER && password === SOCKS_PASS);
}));

process.on('uncaughtException', (err) => console.error('[Fatal]', err.message));
