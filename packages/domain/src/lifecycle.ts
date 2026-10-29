import { ProfileLifecycleState } from '@multiprofile/contracts';
import { DomainError } from './errors.js';

export const VALID_PROFILE_TRANSITIONS: Record<ProfileLifecycleState, ProfileLifecycleState[]> = {
  STOPPED: ['VALIDATING'],
  VALIDATING: ['STARTING', 'ERROR'],
  STARTING: ['READY', 'STOPPING', 'ERROR'],
  READY: ['STOPPING', 'DEGRADED', 'ERROR'],
  DEGRADED: ['STOPPING', 'ERROR', 'STARTING'],
  STOPPING: ['STOPPED', 'ERROR'],
  ERROR: ['VALIDATING', 'STOPPED']
};

export class ProfileLifecycleMachine {
  private _state: ProfileLifecycleState;
  private _generation: number;

  constructor(initialState: ProfileLifecycleState = 'STOPPED', generation: number = 1) {
    this._state = initialState;
    this._generation = generation;
  }

  public get state(): ProfileLifecycleState {
    return this._state;
  }

  public get generation(): number {
    return this._generation;
  }

  public canTransitionTo(nextState: ProfileLifecycleState): boolean {
    return VALID_PROFILE_TRANSITIONS[this._state].includes(nextState);
  }

  public transitionTo(nextState: ProfileLifecycleState): void {
    if (!this.canTransitionTo(nextState)) {
      throw new DomainError(
        'UNKNOWN',
        `Invalid profile lifecycle transition from ${this._state} to ${nextState}`
      );
    }
    if (nextState === 'STARTING') {
      this._generation += 1;
    }
    this._state = nextState;
  }
}
