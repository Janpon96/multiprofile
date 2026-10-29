/**
 * Canonical contracts and types for MultiProfile Studio
 * Conforms to JSON schemas in contracts/
 */

export type ProxyScheme = 'http' | 'https' | 'socks5';
export type ProxyAuthKind = 'none' | 'basic' | 'username_password';
export type ProxyMode = 'required' | 'direct';

export interface BrowserPreset {
  viewport: {
    width: number;
    height: number;
  };
  device_scale_factor?: number;
  locale?: string;
  timezone?: string;
  color_scheme?: 'light' | 'dark' | 'no-preference';
  user_agent_override?: string;
}

export interface ProxyRecord {
  id: string;
  label: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  auth_kind: ProxyAuthKind;
  secret_ref?: string | null;
  config_revision: number;
}

export interface ProfileRecord {
  id: string;
  name: string;
  group_name: string;
  proxy_mode: ProxyMode;
  proxy_id?: string | null;
  preset: BrowserPreset;
  start_url: string;
  config_revision: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export type ProfileLifecycleState =
  | 'STOPPED'
  | 'VALIDATING'
  | 'STARTING'
  | 'READY'
  | 'DEGRADED'
  | 'STOPPING'
  | 'ERROR';

export interface ProfileRuntimeState {
  profile_id: string;
  generation: number;
  state: ProfileLifecycleState;
  worker_pid?: number | null;
  worker_birth_time?: string | null;
  session_nonce?: string | null;
  last_error_code?: string | null;
  updated_at: string;
}

export type SyncSessionMode = 'dom' | 'coordinate';
export type SyncFailurePolicy = 'strict' | 'continueHealthy';
export type SyncSessionState =
  | 'DRAFT'
  | 'ARMING'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPING'
  | 'STOPPED';

export interface SyncSessionPolicy {
  action_timeout_ms: number;
  navigation_timeout_ms: number;
  queue_cap: number;
  queue_max_age_ms: number;
  coalesce_pointer: boolean;
}

export interface SyncSessionRecord {
  id: string;
  epoch: number;
  master_profile_id: string;
  state: SyncSessionState;
  mode: SyncSessionMode;
  failure_policy: SyncFailurePolicy;
  policy: SyncSessionPolicy;
  config_revision: number;
  created_at: string;
}

export interface SyncMemberRecord {
  session_id: string;
  profile_id: string;
  role: 'MASTER' | 'FOLLOWER';
  logical_tab_id: string;
  active: boolean;
}

export type DeliveryState =
  | 'RECEIVED'
  | 'DISPATCHING'
  | 'APPLIED'
  | 'SKIPPED'
  | 'BLOCKED'
  | 'FAILED'
  | 'UNKNOWN';

export type VerificationState = 'matched' | 'unverified' | 'mismatched';

export interface SyncDeliveryRecord {
  session_id: string;
  epoch: number;
  event_id: string;
  follower_id: string;
  seq: number;
  event_type: string;
  state: DeliveryState;
  verification: VerificationState;
  queued_at: string;
  completed_at?: string | null;
  error_code?: string | null;
  trace_id: string;
}

export type CanonicalActionType =
  | 'dom.click'
  | 'dom.double_click'
  | 'pointer.gesture'
  | 'text.patch'
  | 'key.command'
  | 'key.raw'
  | 'scroll.set'
  | 'scroll.wheel'
  | 'navigate'
  | 'variable.fill'
  | 'control.release';

export interface TargetDescriptor {
  route_key?: string;
  frame_path: string[];
  candidates?: string[];
  element_kind?: string;
  container_selector?: string;
  client_x?: number;
  client_y?: number;
  u?: number;
  v?: number;
  viewport_width?: number;
  viewport_height?: number;
}

export interface CanonicalEnvelope<TPayload = unknown> {
  schema_version: '1.0.0';
  session_id: string;
  epoch: number;
  event_id: string;
  seq: number;
  source_profile_id: string;
  logical_tab_id: string;
  frame_path: string[];
  route_key: string;
  route_generation: number;
  source_document_token: string;
  expected_document_token?: string;
  type: CanonicalActionType;
  target?: TargetDescriptor;
  payload: TPayload;
  created_at: string;
  ttl_ms: number;
  trace_id: string;
}

export const ERROR_CODES = {
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_OCCLUDED: 'TARGET_OCCLUDED',
  ROUTE_MISMATCH: 'ROUTE_MISMATCH',
  TEXT_BASELINE_MISMATCH: 'TEXT_BASELINE_MISMATCH',
  UNSUPPORTED_PROXY: 'UNSUPPORTED_PROXY',
  SECRET_UNAVAILABLE: 'SECRET_UNAVAILABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  UNREACHABLE: 'UNREACHABLE',
  TLS_FAILED: 'TLS_FAILED',
  TARGET_BLOCKED: 'TARGET_BLOCKED',
  EGRESS_MISMATCH: 'EGRESS_MISMATCH',
  CHECK_INCONCLUSIVE: 'CHECK_INCONCLUSIVE',
  UNKNOWN: 'UNKNOWN',
  ADMISSION_DENIED: 'ADMISSION_DENIED',
  DISPATCH_TIMEOUT: 'DISPATCH_TIMEOUT',
  BARRIER_TIMEOUT: 'BARRIER_TIMEOUT'
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
