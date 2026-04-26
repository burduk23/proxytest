require('dotenv').config();
const socks = require('socksv5');
const WebSocket = require('ws');

const VERSION = '1.3.0';
const LOCAL_PORT = process.env.LOCAL_PORT || 1080;
const REMOTE_URL = process.env.REMOTE_URL || 'https://proxy-il1y.onrender.com';
const AUTH_USER = process.env.AUTH_USER || 'dandon';
const AUTH_PASS = process.env.AUTH_PASS || 'pulk';
const AUTH_STR = `${AUTH_USER}:${AUTH_PASS}`;

const SOCKS_USER = process.env.SOCKS_USER || 'dandon';
const SOCKS_PASS = process.env.SOCKS_PASS || 'pulk';

// ЗАЩИТА ОТ БАНА RENDER: Лимит 80 одновременных соединений.
// У бесплатного Render лимит 100, мы оставляем запас для стабильности.
const MAX_CONCURRENT_CONNECTIONS = 80;
let activeConnections = 0;

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

console.log(`[Client v${VERSION}] Starting SOCKS5 Proxy...`);

const srv = socks.createServer((info, accept, deny) => {
  const targetLabel = `${info.dstAddr}:${info.dstPort}`;
  
  // 1. Проверяем лимит соединений, чтобы не спровоцировать бан от Render (Ошибка 502)
  if (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
    console.warn(`[LIMIT] Denied ${targetLabel}. Active: ${activeConnections}/${MAX_CONCURRENT_CONNECTIONS}`);
    return deny();
  }

  // 2. Сразу подтверждаем SOCKS-соединение для Android (чтобы не было "вечного подключения")
  const clientSocket = accept(true);
  if (!clientSocket) return;

  activeConnections++;
  let isCleanedUp = false;
  let isBridgeReady = false;
  const buffer = [];

  const cleanup = () => {
    if (!isCleanedUp) {
      isCleanedUp = true;
      activeConnections--;
      clearInterval(pingInterval);
      if (clientSocket) clientSocket.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  };

  const ws = new WebSocket(WS_TARGET, {
    headers: { 'User-Agent': `Proxy-Client/${VERSION}` },
    handshakeTimeout: 15000
  });

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
          console.log(`[WS] OK -> ${targetLabel} (Connections: ${activeConnections})`);
          // Сбрасываем накопленные данные в туннель
          while (buffer.length > 0) {
            ws.send(buffer.shift(), { binary: true });
          }
        } else {
          console.error(`[WS] Server rejected ${targetLabel}`);
          cleanup();
        }
      } catch (e) {
        cleanup();
      }
    } else {
      if (clientSocket.writable) clientSocket.write(data);
    }
  });

  clientSocket.on('data', (data) => {
    if (isBridgeReady) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    } else {
      // Буферизуем данные от телефона, пока Render просыпается
      buffer.push(data);
      if (buffer.length > 300) cleanup(); // Защита от переполнения
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
  clientSocket.on('close', cleanup);
  clientSocket.on('error', cleanup);
});

srv.listen(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`--------------------------------------------------`);
  console.log(`SOCKS5 Proxy v${VERSION} on port ${LOCAL_PORT}`);
  console.log(`Limit: ${MAX_CONCURRENT_CONNECTIONS} concurrent connections`);
  console.log(`--------------------------------------------------`);
});

srv.useAuth(socks.auth.UserPassword((user, password, cb) => {
  cb(user === SOCKS_USER && password === SOCKS_PASS);
}));

process.on('uncaughtException', (err) => {
  if (err.code !== 'ECONNRESET') console.error('[Fatal]', err.message);
});
