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
  'profile.setProxy',
  'profile.list',
  'profile.start',
  'profile.stop',
  'profile.focus',
  'profile.startMany',
  'profile.stopMany',
  'proxy.list',
  'proxy.check',
  'proxy.delete',
  'profile.duplicate',
  'profile.delete',
  'proxy.previewImport',
  'proxy.commitImport',
  'proxy.assign',
  'proxy.commitAssign',
  'sync.create',
  'sync.promoteMaster',
  'sync.emergencyStop',
  'sync.arm',
  'sync.pause',
  'sync.resume',
  'sync.stop',
  'sync.status',
  'variables.preview',
  'variable.dataset.list',
  'variable.dataset.create',
  'variable.dataset.delete',
  'variable.profile.set',
  'variable.profile.get',
  'variable.profile.setbatch',
  'variable.csv.import',
  'window.tile',
  'windows.tile',
  'backup.create',
  'diagnostics.export'
]);

export function validatePreloadCommand(command: string): boolean {
  return ALLOWED_IPC_COMMANDS.has(command);
}
