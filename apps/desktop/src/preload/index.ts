import { IpcRequestEnvelope, IpcResponseEnvelope } from '../main/controller.js';

export interface MultiProfileStudioBridge {
  invoke<TPayload = unknown, TData = unknown>(
    command: string,
    payload: TPayload,
    expectedRevision?: number
  ): Promise<IpcResponseEnvelope<TData>>;
}

export const ALLOWED_IPC_COMMANDS = new Set([
  'profile.create',
  'profile.update',
  'profile.list',
  'profile.start',
  'profile.stop',
  'profile.focus',
  'profile.startMany',
  'profile.stopMany',
  'proxy.list',
  'profile.duplicate',
  'profile.delete',
  'proxy.previewImport',
  'proxy.commitImport',
  'proxy.assign',
  'sync.create',
  'sync.promoteMaster',
  'sync.emergencyStop',
  'sync.arm',
  'sync.pause',
  'sync.resume',
  'sync.stop',
  'sync.status',
  'variables.preview',
  'windows.tile',
  'backup.create',
  'diagnostics.export'
]);

export function validatePreloadCommand(command: string): boolean {
  return ALLOWED_IPC_COMMANDS.has(command);
}
