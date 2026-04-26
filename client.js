require('dotenv').config();
const socks = require('socksv5');
const WebSocket = require('ws');

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

/**
 * SOCKS5 Server with improved reliability
 */
const srv = socks.createServer((info, accept, deny) => {
  const targetLabel = `${info.dstAddr}:${info.dstPort}`;
  const clientSocket = accept(true);
  if (!clientSocket) return;

  const ws = new WebSocket(WS_TARGET, {
    headers: { 'User-Agent': 'SOCKS5-WS-Tunnel-Client/1.1' }
  });

  let isBridgeReady = false;
  const buffer = [];

  // Heartbeat to prevent Render from closing idle connection
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20000);

  ws.on('open', () => {
    console.log(`[WS] Tunnel opening for ${targetLabel}`);
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
          console.log(`[WS] Bridge established to ${targetLabel}`);
          // Flush buffer
          while (buffer.length > 0) {
            ws.send(buffer.shift(), { binary: true });
          }
        } else {
          console.error(`[WS] Bridge rejected: ${msg.message || 'Unknown'}`);
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
      if (buffer.length > 300) {
        console.warn(`[SOCKS] Buffer overflow for ${targetLabel}`);
        clientSocket.destroy();
        ws.close();
      }
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(pingInterval);
    console.log(`[WS] Closed for ${targetLabel} (Code: ${code})`);
    clientSocket.destroy();
  });

  ws.on('error', (err) => {
    clearInterval(pingInterval);
    console.error(`[WS] Error for ${targetLabel}: ${err.message}`);
    clientSocket.destroy();
  });

  clientSocket.on('close', () => {
    clearInterval(pingInterval);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  });
});

srv.listen(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`SOCKS5 Proxy v1.1 running on port ${LOCAL_PORT}`);
  console.log(`Target: ${WS_TARGET}`);
});

srv.useAuth(socks.auth.UserPassword((user, password, cb) => {
  cb(user === SOCKS_USER && password === SOCKS_PASS);
}));

process.on('unhandledRejection', (r) => console.error('Rejection:', r));
process.on('uncaughtException', (e) => console.error('Exception:', e));
