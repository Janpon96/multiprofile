import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export interface FixtureServerInstance {
  server: http.Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startWebFixtureServer(port: number = 0): Promise<FixtureServerInstance> {
  const dir = path.resolve(process.cwd(), 'tests/fixtures/web');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/echo-ip') {
      const clientIp = req.socket.remoteAddress || '127.0.0.1';
      const nonce = url.searchParams.get('nonce') || 'none';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`ip=${clientIp}\ntimestamp=${Date.now()}\nnonce=${nonce}\n`);
      return;
    }

    if (url.pathname === '/slow') {
      setTimeout(() => {
        const filePath = path.join(dir, 'slow-page.html');
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      }, 1500);
      return;
    }

    if (url.pathname === '/blocked') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden - Access Denied');
      return;
    }

    const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.join(dir, fileName);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    port: actualPort,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
