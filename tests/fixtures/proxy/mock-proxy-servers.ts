import http from 'node:http';
import net from 'node:net';

export interface MockProxyInstance {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export async function startMockAuthProxy(options: {
  username?: string;
  password?: string;
  force407?: boolean;
}): Promise<MockProxyInstance> {
  const { username, password, force407 } = options;

  const server = http.createServer((req, res) => {
    // Normal HTTP proxy request
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Use CONNECT method');
  });

  server.on('connect', (req, clientSocket, head) => {
    if (force407) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Mock"\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (username && password) {
      const authHeader = req.headers['proxy-authorization'];
      const expectedCreds = Buffer.from(`${username}:${password}`).toString('base64');
      const expectedAuth = `Basic ${expectedCreds}`;

      if (!authHeader || authHeader !== expectedAuth) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Mock"\r\n\r\n');
        clientSocket.destroy();
        return;
      }
    }

    const [targetHost, targetPort] = (req.url || '').split(':');
    const port = parseInt(targetPort, 10) || 80;

    const targetSocket = net.connect(port, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      targetSocket.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as net.AddressInfo).port;

  return {
    server,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
