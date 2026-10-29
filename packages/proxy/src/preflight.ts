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

    return await new Promise<PreflightResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
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
        path: `${target.hostname}:${target.port || 443}`,
        headers: {
          'Proxy-Authorization': `Basic ${Buffer.from(`${relay.username}:${relay.password}`).toString('base64')}`
        }
      };

      const req = http.request(reqOptions);

      req.on('connect', (res, rawSocket) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          rawSocket.destroy();
          if (res.statusCode === 407) {
            return resolve({
              status: 'AUTH_FAILED',
              latencyMs: Date.now() - startTime,
              errorMessage: 'Proxy authentication failed (407)',
              timestamp
            });
          }
          return resolve({
            status: 'UNREACHABLE',
            latencyMs: Date.now() - startTime,
            errorMessage: `Proxy CONNECT returned status ${res.statusCode}`,
            timestamp
          });
        }

        // Establish TLS over the established CONNECT tunnel
        const secureSocket = tls.connect({
          socket: rawSocket,
          servername: target.hostname,
          rejectUnauthorized: true
        }, () => {
          // Send simple HTTP GET request
          secureSocket.write(`GET ${target.pathname || '/'} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: MultiProfile-Preflight/1.0\r\nConnection: close\r\n\r\n`);
        });

        let data = '';
        secureSocket.on('data', (chunk) => {
          data += chunk.toString();
        });

        secureSocket.on('end', () => {
          clearTimeout(timer);
          const latencyMs = Date.now() - startTime;
          const statusMatch = data.match(/^HTTP\/1\.[01]\s+(\d{3})/i);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

          if (statusCode >= 200 && statusCode < 300) {
            const ipMatch = data.match(/ip=([^\r\n]+)/);
            const ipEcho = ipMatch ? ipMatch[1].trim() : undefined;
            return resolve({
              status: 'READY',
              latencyMs,
              ipEcho,
              timestamp
            });
          } else if (statusCode === 403) {
            return resolve({
              status: 'TARGET_BLOCKED',
              latencyMs,
              errorMessage: 'Target returned 403 Forbidden',
              timestamp
            });
          } else {
            return resolve({
              status: 'CHECK_INCONCLUSIVE',
              latencyMs,
              errorMessage: `Unexpected target status: ${statusCode}`,
              timestamp
            });
          }
        });

        secureSocket.on('error', (err) => {
          clearTimeout(timer);
          const msg = err.message.toLowerCase();
          const isTls = msg.includes('cert') || msg.includes('handshake') || msg.includes('tls');
          resolve({
            status: isTls ? 'TLS_FAILED' : 'UNREACHABLE',
            latencyMs: Date.now() - startTime,
            errorMessage: err.message,
            timestamp
          });
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        resolve({
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
