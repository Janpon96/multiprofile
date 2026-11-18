import { describe, it, expect } from 'vitest';
import {
  parseProxyLine,
  maskProxyString,
  previewProxyImport,
  LocalProxyRelay
} from '../../packages/proxy/dist/index.js';

describe('Proxy Parser & Normalizer', () => {
  it('should parse standard HTTP URI with authentication', () => {
    const parsed = parseProxyLine('http://demo_user:demo_pass@proxy.example.com:8080');
    expect(parsed.scheme).toBe('http');
    expect(parsed.host).toBe('proxy.example.com');
    expect(parsed.port).toBe(8080);
    expect(parsed.auth_kind).toBe('basic');
    expect(parsed.username).toBe('demo_user');
    expect(parsed.password).toBe('demo_pass');
    expect(parsed.raw_masked).not.toContain('demo_pass');
  });

  it('should parse SOCKS5 URI and strip IPv6 brackets', () => {
    const parsed = parseProxyLine('socks5://user:pass@[2001:db8::10]:1080');
    expect(parsed.scheme).toBe('socks5');
    expect(parsed.host).toBe('2001:db8::10');
    expect(parsed.port).toBe(1080);
    expect(parsed.auth_kind).toBe('username_password');
  });

  it('should reject unsupported schemes such as socks4 or pac', () => {
    expect(() => parseProxyLine('socks4://1.2.3.4:1080')).toThrow(/UNSUPPORTED_PROXY/);
    expect(() => parseProxyLine('pac://1.2.3.4:8080')).toThrow(/UNSUPPORTED_PROXY/);
  });

  it('should parse legacy host:port:user:pass and passwords containing colons', () => {
    const parsed = parseProxyLine('1.2.3.4:8888:admin:secret:123');
    expect(parsed.scheme).toBe('http');
    expect(parsed.host).toBe('1.2.3.4');
    expect(parsed.port).toBe(8888);
    expect(parsed.username).toBe('admin');
    expect(parsed.password).toBe('secret:123');
    expect(parsed.raw_masked).toBe('1.2.3.4:8888:***:***');
  });

  it('should parse hybrid scheme://host:port:user:pass and bare user:pass@host:port', () => {
    const socks = parseProxyLine('socks5://103.10.20.30:1080:vnuser:vnpass123');
    expect(socks.scheme).toBe('socks5');
    expect(socks.host).toBe('103.10.20.30');
    expect(socks.port).toBe(1080);
    expect(socks.auth_kind).toBe('username_password');
    expect(socks.username).toBe('vnuser');
    expect(socks.password).toBe('vnpass123');
    expect(socks.raw_masked).not.toContain('vnpass123');

    const bareAt = parseProxyLine('u1:p1@203.0.113.5:3128');
    expect(bareAt.scheme).toBe('http');
    expect(bareAt.host).toBe('203.0.113.5');
    expect(bareAt.port).toBe(3128);
    expect(bareAt.username).toBe('u1');
    expect(bareAt.password).toBe('p1');
    expect(bareAt.raw_masked).toBe('***:***@203.0.113.5:3128');
  });

  it('should preview multi-line input in two-phase preview', () => {
    const text = `
http://user1:pass1@proxy1.com:8080
invalid_proxy_line_without_port
socks5://proxy2.com:1080
    `;
    const preview = previewProxyImport(text);
    expect(preview.valid.length).toBe(2);
    expect(preview.invalid.length).toBe(1);
    expect(preview.summary.validCount).toBe(2);
    expect(preview.summary.invalidCount).toBe(1);
    expect(preview.invalid[0].raw_masked).toBe('invalid_proxy_line_without_port');
  });
});

describe('LocalProxyRelay', () => {
  it('should start loopback listener on 127.0.0.1 and close cleanly', async () => {
    const relay = new LocalProxyRelay({
      profileId: 'test-profile-1',
      proxyMode: 'required',
      assignedProxy: {
        id: 'p-1',
        label: 'Upstream Test',
        scheme: 'http',
        host: '127.0.0.1',
        port: 9999,
        auth_kind: 'none',
        config_revision: 1
      }
    });

    const proxyUrl = await relay.start();
    expect(proxyUrl).toMatch(/^http:\/\/user:[a-f0-9]+@127\.0\.0\.1:\d+$/);
    expect(relay.loopbackPort).toBeGreaterThan(0);

    await relay.close();
  });
});
