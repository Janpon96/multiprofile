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

  it('should parse legacy host:port:user:pass', () => {
    const parsed = parseProxyLine('1.2.3.4:8888:admin:secret123');
    expect(parsed.scheme).toBe('http');
    expect(parsed.host).toBe('1.2.3.4');
    expect(parsed.port).toBe(8888);
    expect(parsed.username).toBe('admin');
    expect(parsed.password).toBe('secret123');
    expect(parsed.raw_masked).toBe('1.2.3.4:8888:***:***');
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
