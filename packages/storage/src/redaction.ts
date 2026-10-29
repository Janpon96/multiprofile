export function redactSensitiveData<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Redact password in URI
    let str = obj.replace(/(https?|socks5):\/\/([^:]+):([^@]+)@/gi, '$1://$2:***@');
    // Redact Authorization headers or tokens
    str = str.replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer ***');
    str = str.replace(/Basic\s+[a-zA-Z0-9+/=]+/gi, 'Basic ***');
    return str as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const copy: Record<string, unknown> = {};
    const sensitiveKeys = new Set([
      'password',
      'secret',
      'token',
      'cookie',
      'cookies',
      'authorization',
      'proxy_authorization',
      'ciphertext',
      'value_ciphertext',
      'credentials'
    ]);

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        copy[key] = '***REDACTED***';
      } else {
        copy[key] = redactSensitiveData(val);
      }
    }
    return copy as T;
  }

  return obj;
}
