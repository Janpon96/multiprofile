import { Server as ProxyChainServer } from 'proxy-chain';
import { randomBytes } from 'node:crypto';
import { ProxyRecord, ProxyMode } from '@multiprofile/contracts';
import { ProxyRoutingError } from '@multiprofile/domain';

export interface UpstreamCredentials {
  username?: string;
  password?: string;
}

export interface RelayConfig {
  profileId: string;
  proxyMode: ProxyMode;
  assignedProxy?: ProxyRecord;
  upstreamCredentials?: UpstreamCredentials;
}

export class LocalProxyRelay {
  private server: ProxyChainServer | null = null;
  private port: number = 0;
  private sessionToken: string;
  private config: RelayConfig;
  private isClosed: boolean = false;

  constructor(config: RelayConfig) {
    this.config = config;
    // Ephemeral random token held in RAM only
    this.sessionToken = randomBytes(16).toString('hex');
  }

  public get loopbackPort(): number {
    return this.port;
  }

  public get loopbackToken(): string {
    return this.sessionToken;
  }

  public get proxyUrl(): string {
    if (!this.port) {
      throw new Error('Relay server is not started yet');
    }
    return `http://user:${this.sessionToken}@127.0.0.1:${this.port}`;
  }

  public async start(): Promise<string> {
    if (this.config.proxyMode === 'direct') {
      throw new Error('LocalProxyRelay should not be started for direct mode profiles');
    }

    if (!this.config.assignedProxy) {
      throw new ProxyRoutingError(
        'UNREACHABLE',
        `No upstream proxy assigned for profile ${this.config.profileId} with required proxy mode`
      );
    }

    const assigned = this.config.assignedProxy;
    const creds = this.config.upstreamCredentials;

    // Build canonical upstream URL
    let upstreamUrl: string;
    if (creds?.username && creds?.password) {
      const u = encodeURIComponent(creds.username);
      const p = encodeURIComponent(creds.password);
      upstreamUrl = `${assigned.scheme}://${u}:${p}@${assigned.host}:${assigned.port}`;
    } else {
      upstreamUrl = `${assigned.scheme}://${assigned.host}:${assigned.port}`;
    }

    this.server = new ProxyChainServer({
      port: 0, // OS assigned loopback port
      host: '127.0.0.1', // Strictly localhost
      verbose: false,
      prepareRequestFunction: ({ request, username, password }) => {
        // Enforce loopback authentication token
        if (password !== this.sessionToken) {
          return {
            requestAuthentication: true,
            failMsg: 'Invalid local relay session token'
          };
        }

        if (this.isClosed) {
          return {
            requestAuthentication: true,
            failMsg: 'Local relay is closed'
          };
        }

        // CRITICAL: NEVER return null or empty upstream when proxy is required!
        if (!upstreamUrl) {
          throw new ProxyRoutingError(
            'UNREACHABLE',
            'Upstream proxy configuration missing; direct connection strictly blocked'
          );
        }

        return {
          upstreamProxyUrl: upstreamUrl
        };
      }
    });

    await this.server.listen();
    this.port = this.server.port;
    return this.proxyUrl;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    if (this.server) {
      await this.server.close(true); // force close active connections
      this.server = null;
    }
  }
}
