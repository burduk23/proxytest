const socks = require('socksv5');
const WebSocket = require('ws');

/**
 * Configuration
 */
const LOCAL_PORT = process.env.LOCAL_PORT || 1080;
const REMOTE_URL = process.env.REMOTE_URL || 'https://proxy-il1y.onrender.com';
const AUTH_USER = process.env.AUTH_USER || 'dandon';
const AUTH_PASS = process.env.AUTH_PASS || 'pulk';
const AUTH_STR = `${AUTH_USER}:${AUTH_PASS}`;

// Convert https:// to wss:// or http:// to ws://
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
 * SOCKS5 Server
 */
const srv = socks.createServer((info, accept, deny) => {
  const targetLabel = `${info.dstAddr}:${info.dstPort}`;
  console.log(`[SOCKS] Incoming request to ${targetLabel}`);
  
  // accept(true) allows us to handle the stream ourselves
  const clientSocket = accept(true);
  if (!clientSocket) {
    console.error(`[SOCKS] Failed to accept connection to ${targetLabel}`);
    return;
  }

  console.log(`[WS] Opening tunnel to ${WS_TARGET} for ${targetLabel}`);
  const ws = new WebSocket(WS_TARGET, {
    // Optional: Add headers if needed for some proxy environments
    headers: {
      'User-Agent': 'SOCKS5-WS-Tunnel-Client/1.0'
    }
  });

  let isBridgeReady = false;
  const buffer = [];

  ws.on('open', () => {
    console.log(`[WS] Connected to bridge server for ${targetLabel}`);
    // Send handshake
    ws.send(JSON.stringify({
      auth: AUTH_STR,
      host: info.dstAddr,
      port: info.dstPort
    }));
  });

  ws.on('message', (data, isBinary) => {
    if (!isBridgeReady) {
      if (isBinary) return; // Handshake is JSON
      
      try {
        const msg = JSON.parse(data.toString());
        if (msg.status === 'connected') {
          isBridgeReady = true;
          console.log(`[WS] Bridge established to ${targetLabel}`);
          
          // Flush any buffered data from client
          while (buffer.length > 0) {
            ws.send(buffer.shift(), { binary: true });
          }
        } else {
          console.error(`[WS] Server rejected connection: ${msg.message || 'Unknown error'}`);
          ws.close();
        }
      } catch (e) {
        console.error(`[WS] Handshake parse error: ${e.message}`);
        ws.close();
      }
    } else {
      // Forward data from WS to SOCKS client
      if (clientSocket.writable) {
        clientSocket.write(data);
      }
    }
  });

  // Forward data from SOCKS client to WS
  clientSocket.on('data', (data) => {
    if (isBridgeReady) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
      }
    } else {
      // Buffer data until bridge is ready
      buffer.push(data);
      if (buffer.length > 100) { // Safety limit
        console.warn(`[SOCKS] Buffer overflow for ${targetLabel}, closing.`);
        clientSocket.destroy();
        ws.close();
      }
    }
  });

  // Cleanup on WS close
  ws.on('close', (code, reason) => {
    console.log(`[WS] Connection closed for ${targetLabel} (Code: ${code})`);
    clientSocket.end();
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${targetLabel}:`, err.message);
    clientSocket.destroy();
  });

  // Cleanup on SOCKS close
  clientSocket.on('close', () => {
    console.log(`[SOCKS] Connection closed for ${targetLabel}`);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  });

  clientSocket.on('error', (err) => {
    console.error(`[SOCKS] Error for ${targetLabel}:`, err.message);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  });
});

srv.listen(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`--------------------------------------------------`);
  console.log(`SOCKS5 Proxy Server running on port ${LOCAL_PORT}`);
  console.log(`Tunneling via WebSocket to: ${WS_TARGET}`);
  console.log(`Auth: ${AUTH_STR}`);
  console.log(`--------------------------------------------------`);
});

srv.useAuth(socks.auth.None());

/**
 * Global Error Handling
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
