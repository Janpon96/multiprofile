import { ERROR_CODES, ErrorCode } from '@multiprofile/contracts';

export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TargetResolutionError extends DomainError {
  constructor(code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'TARGET_OCCLUDED', message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'TargetResolutionError';
  }
}

export class ProxyRoutingError extends DomainError {
  constructor(code: 'UNSUPPORTED_PROXY' | 'AUTH_FAILED' | 'UNREACHABLE' | 'TLS_FAILED' | 'EGRESS_MISMATCH' | 'CHECK_INCONCLUSIVE', message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'ProxyRoutingError';
  }
}

export class AdmissionError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ERROR_CODES.ADMISSION_DENIED, message, details);
    this.name = 'AdmissionError';
  }
}
