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
    /^(https?|socks5):\/\/([^:@/]+)(?::([^@/]*))?@/i,
    '$1://***:***@'
  );
  // Replace scheme://host:port:user:pass -> scheme://host:port:***:***
  masked = masked.replace(
    /^(https?|socks5):\/\/([^:@/\[\]]+):(\d+):([^@/]+)$/i,
    '$1://$2:$3:***:***'
  );
  // Replace bare user:pass@host:port -> ***:***@host:port
  masked = masked.replace(
    /^([^:@/\s]+):([^@/\s]*)@([^@/\s]+)$/,
    '***:***@$3'
  );
  // Replace legacy host:port:user:pass -> host:port:***:***
  if (!/^[a-zA-Z0-9]+:\/\//.test(masked) && !masked.includes('@') && !masked.startsWith('[')) {
    const legacyParts = masked.split(':');
    if (legacyParts.length >= 4 && (legacyParts[0].includes('.') || legacyParts[0] === 'localhost')) {
      masked = `${legacyParts[0]}:${legacyParts[1]}:***:***`;
    }
  }
  return masked;
}

export function parseProxyLine(line: string, lineNumber: number = 1): ParsedProxyItem {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Empty line at line ${lineNumber}`);
  }

  const masked = maskProxyString(trimmed);

  // 1. Try URI format (http://, https://, socks5://) and provider hybrid scheme://host:port:user:pass
  const schemeMatch = trimmed.match(/^([a-zA-Z0-9]+):\/\/(.+)$/);
  if (schemeMatch) {
    const rawScheme = schemeMatch[1].toLowerCase();
    if (rawScheme !== 'http' && rawScheme !== 'https' && rawScheme !== 'socks5') {
      throw new ProxyRoutingError(
        'UNSUPPORTED_PROXY',
        `Unsupported proxy scheme '${rawScheme}' at line ${lineNumber}. Supported schemes: http, https, socks5.`
      );
    }
    const rest = schemeMatch[2];
    if (!rest.includes('@') && !rest.startsWith('[')) {
      const hybridParts = rest.split(':');
      if (hybridParts.length >= 4 && (hybridParts[0].includes('.') || hybridParts[0] === 'localhost')) {
        const host = hybridParts[0];
        const port = parseInt(hybridParts[1], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Invalid port number at line ${lineNumber}`);
        }
        const username = hybridParts[2] || undefined;
        const password = username ? hybridParts.slice(3).join(':') : undefined;
        const auth_kind: ProxyAuthKind = username ? (rawScheme === 'socks5' ? 'username_password' : 'basic') : 'none';
        return {
          scheme: rawScheme as ProxyScheme,
          host,
          port,
          auth_kind,
          username,
          password,
          raw_masked: masked
        };
      }
    }

    try {
      const url = new URL(trimmed);
      const scheme = url.protocol.replace(':', '').toLowerCase();
      // Distinguish explicit port in URL vs default port (check authority for ':digits')
      const authority = trimmed.slice(schemeMatch[1].length + 3).split('/')[0];
      const hostPortPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
      const explicitPortMatch = hostPortPart.match(/:(\d+)$/);
      const port = explicitPortMatch
        ? parseInt(explicitPortMatch[1], 10)
        : (url.port ? parseInt(url.port, 10) : (scheme === 'https' ? 443 : scheme === 'socks5' ? 1080 : 80));
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
      const password = username ? (url.password ? decodeURIComponent(url.password) : '') : undefined;

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

  // 1b. Bare user:pass@host:port (defaults to http)
  if (trimmed.includes('@') && !trimmed.includes(',')) {
    const parsed = parseProxyLine(`http://${trimmed}`, lineNumber);
    parsed.raw_masked = masked;
    return parsed;
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
  if (parts.length === 2 || (parts.length >= 4 && (parts[0].includes('.') || parts[0] === 'localhost'))) {
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    if (!host || isNaN(port) || port < 1 || port > 65535) {
      throw new ProxyRoutingError('CHECK_INCONCLUSIVE', `Invalid port '${parts[1]}' at line ${lineNumber}`);
    }
    const username = parts.length >= 4 ? (parts[2] || undefined) : undefined;
    const password = username ? parts.slice(3).join(':') : undefined;
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
