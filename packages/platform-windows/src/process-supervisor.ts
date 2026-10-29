import { execSync, spawn } from 'node:child_process';
import { DomainError } from '@multiprofile/domain';

export interface ProcessIdentity {
  pid: number;
  birthTime: string;
  executablePath?: string;
  profileId: string;
  sessionNonce: string;
}

export class WindowsProcessSupervisor {
  private tracked: Map<string, ProcessIdentity> = new Map();

  public register(identity: ProcessIdentity): void {
    this.tracked.set(identity.profileId, identity);
  }

  public getIdentity(profileId: string): ProcessIdentity | undefined {
    return this.tracked.get(profileId);
  }

  public isProcessAlive(pid: number): boolean {
    try {
      // process.kill with signal 0 checks existence without killing
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  public async terminateProfileProcessTree(profileId: string): Promise<boolean> {
    const identity = this.tracked.get(profileId);
    if (!identity) return true;

    const pid = identity.pid;
    if (!this.isProcessAlive(pid)) {
      this.tracked.delete(profileId);
      return true;
    }

    try {
      if (process.platform === 'win32') {
        // Force terminate process and all child processes in the tree
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // Process might have exited just before taskkill
    }

    this.tracked.delete(profileId);
    return true;
  }

  public reconcileOrphans(knownActivePids: Set<number>): void {
    for (const [profileId, identity] of this.tracked.entries()) {
      if (!knownActivePids.has(identity.pid) || !this.isProcessAlive(identity.pid)) {
        this.terminateProfileProcessTree(profileId);
      }
    }
  }
}
