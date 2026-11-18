import http from 'node:http';
import tls from 'node:tls';

export type PreflightStatus =
  | 'READY'
  | 'AUTH_FAILED'
  | 'UNREACHABLE'
  | 'TLS_FAILED'
  | 'TARGET_BLOCKED'
  | 'EGRESS_MISMATCH'
  | 'CHECK_INCONCLUSIVE';

export interface PreflightResult {
  status: PreflightStatus;
  latencyMs: number;
  ipEcho?: string;
  errorMessage?: string;
  timestamp: string;
}

export interface PreflightOptions {
  relayUrl: string;
  testTargetUrl?: string;
  expectedNonce?: string;
  timeoutMs?: number;
}

export async function runProxyPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const targetUrl = options.testTargetUrl ?? 'https://cloudflare.com/cdn-cgi/trace';
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const relay = new URL(options.relayUrl);
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';
    const targetPort = target.port ? parseInt(target.port, 10) : (isHttps ? 443 : 80);
    const cleanHostname = target.hostname.startsWith('[') && target.hostname.endsWith(']')
      ? target.hostname.slice(1, -1)
      : target.hostname;
    const connectAuthority = cleanHostname.includes(':') ? `[${cleanHostname}]:${targetPort}` : `${cleanHostname}:${targetPort}`;

    return await new Promise<PreflightResult>((resolve) => {
      let settled = false;
      const done = (res: PreflightResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };

      const timer = setTimeout(() => {
        done({
          status: 'UNREACHABLE',
          latencyMs: Date.now() - startTime,
          errorMessage: `Proxy preflight timed out after ${timeoutMs}ms`,
          timestamp
        });
      }, timeoutMs);

      const reqOptions: http.RequestOptions = {
        host: relay.hostname,
        port: parseInt(relay.port, 10),
        method: 'CONNECT',
        path: connectAuthority,
        headers: {
          'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(relay.username)}:${decodeURIComponent(relay.password)}`).toString('base64')}`
        }
      };

      const req = http.request(reqOptions);

      req.on('connect', (res, rawSocket) => {
        if (res.statusCode !== 200) {
          rawSocket.destroy();
          if (res.statusCode === 407 || res.statusCode === 597) {
            return done({
              status: 'AUTH_FAILED',
              latencyMs: Date.now() - startTime,
              errorMessage: `Proxy authentication failed (${res.statusCode}${res.statusMessage ? ' ' + res.statusMessage : ''})`,
              timestamp
            });
          }
          return done({
            status: 'UNREACHABLE',
            latencyMs: Date.now() - startTime,
            errorMessage: `Proxy CONNECT returned status ${res.statusCode}`,
            timestamp
          });
        }

        const requestPath = `${target.pathname || '/'}${target.search || ''}`;
        const hostHeader = target.host;
        const rawGet = `GET ${requestPath} HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: MultiProfile-Preflight/1.0\r\nConnection: close\r\n\r\n`;

        const attachStreamHandlers = (stream: NodeJS.ReadWriteStream, isTlsStream: boolean) => {
          let data = '';
          stream.on('data', (chunk) => {
            data += chunk.toString();
          });

          stream.on('end', () => {
            const latencyMs = Date.now() - startTime;
            const statusMatch = data.match(/^HTTP\/1\.[01]\s+(\d{3})/i);
            const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

            if (statusCode >= 200 && statusCode < 300) {
              const ipMatch = data.match(/ip=([^\r\n]+)/) || data.match(/"origin"\s*:\s*"([^"]+)"/);
              const ipEcho = ipMatch ? ipMatch[1].trim() : undefined;
              return done({
                status: 'READY',
                latencyMs,
                ipEcho,
                timestamp
              });
            } else if (statusCode === 403) {
              return done({
                status: 'TARGET_BLOCKED',
                latencyMs,
                errorMessage: 'Target returned 403 Forbidden',
                timestamp
              });
            } else {
              return done({
                status: 'CHECK_INCONCLUSIVE',
                latencyMs,
                errorMessage: `Unexpected target status: ${statusCode}`,
                timestamp
              });
            }
          });

          stream.on('error', (err: Error) => {
            const msg = err.message.toLowerCase();
            const isTls = isTlsStream && (msg.includes('cert') || msg.includes('handshake') || msg.includes('tls') || msg.includes('ssl'));
            done({
              status: isTls ? 'TLS_FAILED' : 'UNREACHABLE',
              latencyMs: Date.now() - startTime,
              errorMessage: err.message,
              timestamp
            });
          });
        };

        if (isHttps) {
          const secureSocket = tls.connect({
            socket: rawSocket,
            servername: cleanHostname,
            rejectUnauthorized: true
          }, () => {
            secureSocket.write(rawGet);
          });
          attachStreamHandlers(secureSocket, true);
        } else {
          attachStreamHandlers(rawSocket, false);
          rawSocket.write(rawGet);
        }
      });

      req.on('error', (err) => {
        done({
          status: 'UNREACHABLE',
          latencyMs: Date.now() - startTime,
          errorMessage: err.message,
          timestamp
        });
      });

      req.end();
    });
  } catch (err: unknown) {
    return {
      status: 'CHECK_INCONCLUSIVE',
      latencyMs: Date.now() - startTime,
      errorMessage: err instanceof Error ? err.message : String(err),
      timestamp
    };
  }
}
