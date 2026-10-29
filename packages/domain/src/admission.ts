import { AdmissionError } from './errors.js';

export interface AdmissionMetrics {
  availableRamBytes: number;
  totalRamBytes: number;
  availableDiskBytes: number;
  activeProfilesCount: number;
  maxConcurrentLaunches: number;
  currentlyStartingCount: number;
}

export interface AdmissionPolicyConfig {
  minRamBytes: number; // default: 2 GB
  minRamPercent: number; // default: 15%
  minDiskBytes: number; // default: 2 GB
  maxConcurrentStarting: number; // default: 2
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicyConfig = {
  minRamBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  minRamPercent: 0.15, // 15%
  minDiskBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxConcurrentStarting: 2
};

export class AdmissionController {
  private config: AdmissionPolicyConfig;

  constructor(config: Partial<AdmissionPolicyConfig> = {}) {
    this.config = { ...DEFAULT_ADMISSION_POLICY, ...config };
  }

  public checkAdmission(metrics: AdmissionMetrics): void {
    if (metrics.currentlyStartingCount >= this.config.maxConcurrentStarting) {
      throw new AdmissionError(
        `Exceeded maximum concurrent starting profiles (${this.config.maxConcurrentStarting}). Currently starting: ${metrics.currentlyStartingCount}`
      );
    }

    if (metrics.availableRamBytes < this.config.minRamBytes) {
      const availGb = (metrics.availableRamBytes / (1024 * 1024 * 1024)).toFixed(2);
      throw new AdmissionError(
        `Insufficient RAM available (${availGb} GB available, minimum 2.0 GB required).`
      );
    }

    const ramPercent = metrics.totalRamBytes > 0 ? metrics.availableRamBytes / metrics.totalRamBytes : 1;
    if (ramPercent < this.config.minRamPercent) {
      const pct = (ramPercent * 100).toFixed(1);
      throw new AdmissionError(
        `Available RAM ratio too low (${pct}%, minimum 15% required).`
      );
    }

    if (metrics.availableDiskBytes < this.config.minDiskBytes) {
      const availDiskGb = (metrics.availableDiskBytes / (1024 * 1024 * 1024)).toFixed(2);
      throw new AdmissionError(
        `Insufficient disk space available (${availDiskGb} GB available, minimum 2.0 GB required).`
      );
    }
  }
}
