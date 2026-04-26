require('dotenv').config();
const socks = require('socksv5');
const WebSocket = require('ws');

const VERSION = '1.2.0';
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

console.log(`[Client v${VERSION}] Starting SOCKS5 bridge...`);

const srv = socks.createServer((info, accept, deny) => {
  const targetLabel = `${info.dstAddr}:${info.dstPort}`;
  
  // ВАЖНО: Мы НЕ вызываем accept(true) сразу. 
  // Мы ждем, пока мост на Render подтвердит соединение.

  const ws = new WebSocket(WS_TARGET, {
    headers: { 'User-Agent': `Proxy-Client/${VERSION}` },
    handshakeTimeout: 15000
  });

  let clientSocket = null;
  let isBridgeReady = false;

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20000);

  ws.on('open', () => {
    // console.log(`[WS] Tunnel request for ${targetLabel}`);
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
          
          // ТЕПЕРЬ подтверждаем SOCKS-соединение, когда мост реально готов
          clientSocket = accept(true);
          if (!clientSocket) {
            ws.close();
            return;
          }

          clientSocket.on('data', (d) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true });
          });

          clientSocket.on('close', () => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1000);
          });

          clientSocket.on('error', (err) => {
            clientSocket.destroy();
          });
        } else {
          console.error(`[WS] Server rejected ${targetLabel}: ${msg.message || 'Unknown'}`);
          deny();
          ws.close();
        }
      } catch (e) {
        deny();
        ws.close();
      }
    } else {
      if (clientSocket && clientSocket.writable) {
        clientSocket.write(data);
      }
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingInterval);
    if (!isBridgeReady) {
      console.log(`[WS] Failed to connect to ${targetLabel} (Code: ${code})`);
      deny(); // Сообщаем приложению, что этот IP недоступен
    } else {
      if (clientSocket) clientSocket.destroy();
    }
  });

  ws.on('error', (err) => {
    clearInterval(pingInterval);
    console.error(`[WS Error] ${targetLabel}: ${err.message}`);
    if (!isBridgeReady) deny();
    if (clientSocket) clientSocket.destroy();
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
