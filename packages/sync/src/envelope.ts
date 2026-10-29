import { randomUUID } from 'node:crypto';
import {
  CanonicalEnvelope,
  CanonicalActionType,
  TargetDescriptor
} from '@multiprofile/contracts';

export interface EnvelopeCreateParams<TPayload = unknown> {
  sessionId: string;
  epoch: number;
  seq: number;
  sourceProfileId: string;
  logicalTabId?: string;
  framePath?: string[];
  routeKey: string;
  routeGeneration: number;
  sourceDocumentToken: string;
  type: CanonicalActionType;
  target?: TargetDescriptor;
  payload: TPayload;
  ttlMs?: number;
  traceId?: string;
}

export function createCanonicalEnvelope<TPayload = unknown>(
  params: EnvelopeCreateParams<TPayload>
): CanonicalEnvelope<TPayload> {
  return {
    schema_version: '1.0.0',
    session_id: params.sessionId,
    epoch: params.epoch,
    event_id: randomUUID(),
    seq: params.seq,
    source_profile_id: params.sourceProfileId,
    logical_tab_id: params.logicalTabId || 'default',
    frame_path: params.framePath || [],
    route_key: params.routeKey,
    route_generation: params.routeGeneration,
    source_document_token: params.sourceDocumentToken,
    type: params.type,
    target: params.target,
    payload: params.payload,
    created_at: new Date().toISOString(),
    ttl_ms: params.ttlMs ?? 5000,
    trace_id: params.traceId || randomUUID()
  };
}
