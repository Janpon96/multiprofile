import { describe, it, expect } from 'vitest';
import {
  ProfileLifecycleMachine,
  SyncLifecycleMachine,
  AdmissionController,
  DomainError,
  AdmissionError
} from '../../packages/domain/dist/index.js';

describe('ProfileLifecycleMachine', () => {
  it('should transition through valid happy path STOPPED -> VALIDATING -> STARTING -> READY -> STOPPING -> STOPPED', () => {
    const machine = new ProfileLifecycleMachine('STOPPED');
    expect(machine.state).toBe('STOPPED');
    expect(machine.generation).toBe(1);

    machine.transitionTo('VALIDATING');
    expect(machine.state).toBe('VALIDATING');

    machine.transitionTo('STARTING');
    expect(machine.state).toBe('STARTING');
    expect(machine.generation).toBe(2);

    machine.transitionTo('READY');
    expect(machine.state).toBe('READY');

    machine.transitionTo('STOPPING');
    expect(machine.state).toBe('STOPPING');

    machine.transitionTo('STOPPED');
    expect(machine.state).toBe('STOPPED');
  });

  it('should reject invalid direct transitions', () => {
    const machine = new ProfileLifecycleMachine('STOPPED');
    expect(() => machine.transitionTo('READY')).toThrow(DomainError);
    expect(() => machine.transitionTo('STOPPING')).toThrow(DomainError);
  });
});

describe('SyncLifecycleMachine', () => {
  it('should manage sync states and increment epoch upon unpausing/re-arming', () => {
    const machine = new SyncLifecycleMachine('DRAFT', 1);
    expect(machine.epoch).toBe(1);

    machine.transitionTo('ARMING');
    machine.transitionTo('RUNNING');
    expect(machine.state).toBe('RUNNING');

    machine.transitionTo('PAUSED');
    expect(machine.state).toBe('PAUSED');
    expect(machine.epoch).toBe(1);

    // Re-arming from PAUSED increments epoch to reject stale events
    machine.transitionTo('ARMING');
    expect(machine.epoch).toBe(2);

    machine.transitionTo('RUNNING');
    expect(machine.state).toBe('RUNNING');
  });
});

describe('AdmissionController', () => {
  const controller = new AdmissionController();

  it('should allow admission when resources are sufficient', () => {
    expect(() => {
      controller.checkAdmission({
        availableRamBytes: 8 * 1024 * 1024 * 1024,
        totalRamBytes: 16 * 1024 * 1024 * 1024,
        availableDiskBytes: 50 * 1024 * 1024 * 1024,
        activeProfilesCount: 2,
        maxConcurrentLaunches: 2,
        currentlyStartingCount: 1
      });
    }).not.toThrow();
  });

  it('should reject admission when available RAM is below 2GB', () => {
    expect(() => {
      controller.checkAdmission({
        availableRamBytes: 1.5 * 1024 * 1024 * 1024,
        totalRamBytes: 16 * 1024 * 1024 * 1024,
        availableDiskBytes: 50 * 1024 * 1024 * 1024,
        activeProfilesCount: 2,
        maxConcurrentLaunches: 2,
        currentlyStartingCount: 0
      });
    }).toThrow(AdmissionError);
  });

  it('should reject admission when concurrent starting limit is exceeded', () => {
    expect(() => {
      controller.checkAdmission({
        availableRamBytes: 8 * 1024 * 1024 * 1024,
        totalRamBytes: 16 * 1024 * 1024 * 1024,
        availableDiskBytes: 50 * 1024 * 1024 * 1024,
        activeProfilesCount: 2,
        maxConcurrentLaunches: 2,
        currentlyStartingCount: 2
      });
    }).toThrow(AdmissionError);
  });
});
