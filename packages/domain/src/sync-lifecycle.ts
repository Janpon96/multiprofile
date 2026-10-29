import { SyncSessionState } from '@multiprofile/contracts';
import { DomainError } from './errors.js';

export const VALID_SYNC_TRANSITIONS: Record<SyncSessionState, SyncSessionState[]> = {
  DRAFT: ['ARMING'],
  ARMING: ['RUNNING', 'DRAFT', 'STOPPED'],
  RUNNING: ['PAUSED', 'STOPPING'],
  PAUSED: ['ARMING', 'RUNNING', 'STOPPING'],
  STOPPING: ['STOPPED'],
  STOPPED: ['DRAFT']
};

export class SyncLifecycleMachine {
  private _state: SyncSessionState;
  private _epoch: number;

  constructor(initialState: SyncSessionState = 'DRAFT', initialEpoch: number = 1) {
    this._state = initialState;
    this._epoch = initialEpoch;
  }

  public get state(): SyncSessionState {
    return this._state;
  }

  public get epoch(): number {
    return this._epoch;
  }

  public canTransitionTo(nextState: SyncSessionState): boolean {
    return VALID_SYNC_TRANSITIONS[this._state].includes(nextState);
  }

  public transitionTo(nextState: SyncSessionState): void {
    if (!this.canTransitionTo(nextState)) {
      throw new DomainError(
        'UNKNOWN',
        `Invalid sync session transition from ${this._state} to ${nextState}`
      );
    }
    // Epoch increments on re-arm or unpause to prevent replay of stale queued actions
    if (nextState === 'ARMING' && this._state === 'PAUSED') {
      this._epoch += 1;
    }
    this._state = nextState;
  }
}
