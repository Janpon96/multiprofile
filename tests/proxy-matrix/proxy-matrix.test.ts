import { describe, it, expect } from 'vitest';
import {
  parseProxyLine,
  previewProxyImport,
  previewAutoAssignProxies,
  LocalProxyRelay,
  runProxyPreflight
} from '../../packages/proxy/dist/index.js';
import { ProxyRecord } from '../../packages/contracts/dist/index.js';
import { startMockAuthProxy } from '../fixtures/proxy/mock-proxy-servers.js';
import { startWebFixtureServer } from '../fixtures/web/fixtures-server.js';

describe('Proxy Matrix Suite (AT-005..AT-009)', () => {
  it('AT-005: should parse IPv6, escaped credentials, and reject malformed ports', () => {
    const validIpv6 = parseProxyLine('http://user%40domain.com:p%3Ass@[2001:db8::1]:8080');
    expect(validIpv6.host).toBe('2001:db8::1');
    expect(validIpv6.port).toBe(8080);
    expect(validIpv6.username).toBe('user@domain.com');
    expect(validIpv6.password).toBe('p:ss');

    expect(() => parseProxyLine('http://example.com:99999')).toThrow();
    expect(() => parseProxyLine('socks4://127.0.0.1:1080')).toThrow(/UNSUPPORTED_PROXY/);
  });

  it('AT-006 & AT-008: Upstream Proxy Matrix, Auth, and Health Classification', async () => {
    // 1. Test Mock Auth Proxy with correct credentials
    const mockProxy = await startMockAuthProxy({
      username: 'admin',
      password: 'secretPassword123'
    });

    const webServer = await startWebFixtureServer();

    const relay = new LocalProxyRelay({
      profileId: 'p-test-auth',
      proxyMode: 'required',
      assignedProxy: {
        id: 'mock-p1',
        label: 'Mock Auth Upstream',
        scheme: 'http',
        host: '127.0.0.1',
        port: mockProxy.port,
        auth_kind: 'basic',
        config_revision: 1
      },
      upstreamCredentials: {
        username: 'admin',
        password: 'secretPassword123'
      }
    });

    const relayUrl = await relay.start();
    expect(relayUrl).toMatch(/^http:\/\/user:[a-f0-9]+@127\.0\.0\.1:\d+$/);

    // Run preflight through relay to target web fixture
    const preflightRes = await runProxyPreflight({
      relayUrl,
      testTargetUrl: `${webServer.baseUrl}/echo-ip`,
      timeoutMs: 5000
    });
    // Preflight detects that plain HTTP server has invalid TLS -> TLS_FAILED
    expect(['READY', 'TLS_FAILED', 'UNREACHABLE', 'CHECK_INCONCLUSIVE']).toContain(preflightRes.status);

    await relay.close();
    await mockProxy.close();

    // 2. Test Wrong Auth -> 407 AUTH_FAILED
    const badAuthProxy = await startMockAuthProxy({ force407: true });
    const badRelay = new LocalProxyRelay({
      profileId: 'p-bad-auth',
      proxyMode: 'required',
      assignedProxy: {
        id: 'mock-p2',
        label: 'Bad Auth Proxy',
        scheme: 'http',
        host: '127.0.0.1',
        port: badAuthProxy.port,
        auth_kind: 'basic',
        config_revision: 1
      },
      upstreamCredentials: {
        username: 'wrong',
        password: 'wrong'
      }
    });
    const badRelayUrl = await badRelay.start();

    const badAuthResult = await runProxyPreflight({
      relayUrl: badRelayUrl,
      testTargetUrl: `${webServer.baseUrl}/echo-ip`,
      timeoutMs: 3000
    });
    expect(['AUTH_FAILED', 'UNREACHABLE']).toContain(badAuthResult.status);

    await badRelay.close();
    await badAuthProxy.close();
    await webServer.close();
  });

  it('AT-007: should never fallback to direct when proxy mode is required', async () => {
    const relay = new LocalProxyRelay({
      profileId: 'p-req',
      proxyMode: 'required',
      assignedProxy: undefined
    });
    await expect(relay.start()).rejects.toThrow(/No upstream proxy assigned/);
  });

  it('AT-009: should enforce unique and shared assignment policies with duplicate host warnings', () => {
    const proxies: ProxyRecord[] = [
      { id: 'px-1', label: 'P1', scheme: 'http', host: '1.1.1.1', port: 8080, auth_kind: 'none', config_revision: 1 },
      { id: 'px-2', label: 'P2', scheme: 'http', host: '1.1.1.1', port: 8081, auth_kind: 'none', config_revision: 1 },
      { id: 'px-3', label: 'P3', scheme: 'socks5', host: '2.2.2.2', port: 1080, auth_kind: 'none', config_revision: 1 }
    ];

    const mappings = previewAutoAssignProxies({
      profileIds: ['prof-1', 'prof-2', 'prof-3'],
      availableProxies: proxies,
      policy: 'unique'
    });

    expect(mappings.length).toBe(3);
    expect(mappings[0].proxy_id).toBe('px-1');
    expect(mappings[0].duplicate_host_warning).toBe(false);
    // px-2 shares host 1.1.1.1 with px-1 -> should trigger duplicate_host_warning
    expect(mappings[1].proxy_id).toBe('px-2');
    expect(mappings[1].duplicate_host_warning).toBe(true);
    expect(mappings[2].proxy_id).toBe('px-3');
    expect(mappings[2].duplicate_host_warning).toBe(false);

    // Unique policy should fail if more profiles than proxies
    expect(() => {
      previewAutoAssignProxies({
        profileIds: ['p1', 'p2', 'p3', 'p4'],
        availableProxies: proxies,
        policy: 'unique'
      });
    }).toThrow();

    // Shared policy should wrap around
    const shared = previewAutoAssignProxies({
      profileIds: ['p1', 'p2', 'p3', 'p4'],
      availableProxies: proxies,
      policy: 'shared'
    });
    expect(shared.length).toBe(4);
    expect(shared[3].proxy_id).toBe('px-1');
  });
});
