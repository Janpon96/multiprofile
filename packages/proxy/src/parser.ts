import { ProxyRecord, ProxyScheme, ProxyAuthKind } from '@multiprofile/contracts';
import { ProxyRoutingError } from '@multiprofile/domain';
import { randomUUID } from 'node:crypto';

export interface ParsedProxyItem {
  id?: string;
  label?: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  auth_kind: ProxyAuthKind;
  username?: string;
  password?: string;
  secret_ref?: string;
  raw_masked: string;
}

export interface ProxyImportPreviewResult {
  valid: ParsedProxyItem[];
  invalid: { line: number; error: string; raw_masked: string }[];
  summary: {
    total: number;
    validCount: number;
    invalidCount: number;
  };
}

export function maskProxyString(input: string): string {
  // Replace credentials in URI: scheme://user:pass@host:port -> scheme://***:***@host:port
  let masked = input.replace(
    /^(https?|socks5):\/\/([^:]+):([^@]+)@/i,
    '$1://***:***@'
  );
  // Replace legacy host:port:user:pass -> host:port:***:***
  const legacyParts = masked.split(':');
  if (legacyParts.length === 4) {
    masked = `${legacyParts[0]}:${legacyParts[1]}:***:***`;
  }
  return masked;
}

export function parseProxyLine(line: string, lineNumber: number = 1): ParsedProxyItem {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Empty line at line ${lineNumber}`);
  }

  const masked = maskProxyString(trimmed);

  // 1. Try URI format (http://, https://, socks5://)
  if (/^[a-zA-Z0-9]+:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const scheme = url.protocol.replace(':', '').toLowerCase();
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5') {
        throw new ProxyRoutingError(
          'UNSUPPORTED_PROXY',
          `Unsupported proxy scheme '${scheme}' at line ${lineNumber}. Supported schemes: http, https, socks5.`
        );
      }

      const port = url.port ? parseInt(url.port, 10) : (scheme === 'https' ? 443 : scheme === 'socks5' ? 1080 : 80);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Invalid port number at line ${lineNumber}`);
      }

      let host = url.hostname;
      // Handle IPv6 bracket removal for clean host
      if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
      }
      if (!host || host.length > 253) {
        throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Invalid host length at line ${lineNumber}`);
      }

      const username = url.username ? decodeURIComponent(url.username) : undefined;
      const password = url.password ? decodeURIComponent(url.password) : undefined;

      const auth_kind: ProxyAuthKind = username ? (scheme === 'socks5' ? 'username_password' : 'basic') : 'none';

      return {
        scheme: scheme as ProxyScheme,
        host,
        port,
        auth_kind,
        username,
        password,
        raw_masked: masked
      };
    } catch (err: unknown) {
      if (err instanceof ProxyRoutingError) throw err;
      throw new ProxyRoutingError(
        'CHECK_INCONCLUSIVE',
        `Failed to parse proxy URI at line ${lineNumber}: ${masked}`
      );
    }
  }

  // 2. Try CSV format: proxy_id,label,scheme,host,port,username,password
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
    if (parts.length >= 5) {
      const id = parts[0] || undefined;
      const label = parts[1] || undefined;
      const scheme = parts[2].toLowerCase();
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5') {
        throw new ProxyRoutingError(
          'UNSUPPORTED_PROXY',
          `Unsupported scheme '${scheme}' in CSV at line ${lineNumber}`
        );
      }
      const host = parts[3];
      const port = parseInt(parts[4], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Invalid port '${parts[4]}' at line ${lineNumber}`);
      }
      const username = parts[5] || undefined;
      const password = parts[6] || undefined;
      const auth_kind: ProxyAuthKind = username ? (scheme === 'socks5' ? 'username_password' : 'basic') : 'none';

      return {
        id,
        label,
        scheme: scheme as ProxyScheme,
        host,
        port,
        auth_kind,
        username,
        password,
        raw_masked: masked
      };
    }
  }

  // 3. Try Legacy format: host:port:user:pass or host:port
  const parts = trimmed.split(':');
  if (parts.length === 2 || parts.length === 4) {
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Invalid port '${parts[1]}' at line ${lineNumber}`);
    }
    const username = parts.length === 4 ? parts[2] : undefined;
    const password = parts.length === 4 ? parts[3] : undefined;
    const auth_kind: ProxyAuthKind = username ? 'basic' : 'none';

    return {
      scheme: 'http', // Default legacy scheme to HTTP
      host,
      port,
      auth_kind,
      username,
      password,
      raw_masked: masked
    };
  }

  throw new ProxyRoutingError(
    'CHECK_INCONCLUSIVE',
    `Unrecognized proxy format at line ${lineNumber}: ${masked}`
  );
}

export function previewProxyImport(rawText: string): ProxyImportPreviewResult {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const valid: ParsedProxyItem[] = [];
  const invalid: { line: number; error: string; raw_masked: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    // Skip header line if CSV header detected
    if (i === 0 && line.toLowerCase().startsWith('proxy_id') && line.includes('scheme')) {
      continue;
    }
    try {
      const item = parseProxyLine(line, lineNum);
      if (!item.id) {
        item.id = randomUUID();
      }
      if (!item.label) {
        item.label = `${item.scheme.toUpperCase()} ${item.host}:${item.port}`;
      }
      valid.push(item);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      invalid.push({
        line: lineNum,
        error: errorMsg,
        raw_masked: maskProxyString(line)
      });
    }
  }

  return {
    valid,
    invalid,
    summary: {
      total: lines.length,
      validCount: valid.length,
      invalidCount: invalid.length
    }
  };
}
