'use strict';
// Sandboxed preload (CommonJS is required when sandbox is enabled).
// Exposes one small typed bridge. The main process is the authority that
// validates the command allowlist, sender and rate limit (plan §3.3, §9.2).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mps', {
  invoke(command, payload, expectedRevision) {
    if (typeof command !== 'string') {
      return Promise.reject(new Error('command must be a string'));
    }
    const request_id =
      'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    return ipcRenderer.invoke('mps:invoke', {
      request_id,
      command,
      expected_revision: expectedRevision,
      payload: payload === undefined ? {} : payload
    });
  },
  onEmergencyStop(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('mps:emergency-stop', (_event, result) => callback(result));
  }
});
