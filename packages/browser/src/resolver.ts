import { TargetResolutionError } from '@multiprofile/domain';
import { TargetDescriptor } from '@multiprofile/contracts';

export interface DomElementCandidate {
  selector: string;
  kind: 'test_id' | 'role_name' | 'id' | 'css';
}

export function buildElementCandidates(descriptor: TargetDescriptor): DomElementCandidate[] {
  const candidates: DomElementCandidate[] = [];

  if (descriptor.candidates && descriptor.candidates.length > 0) {
    for (const cand of descriptor.candidates) {
      if (cand.startsWith('[data-testid') || cand.startsWith('[data-test')) {
        candidates.push({ selector: cand, kind: 'test_id' });
      } else if (cand.startsWith('role=')) {
        candidates.push({ selector: cand, kind: 'role_name' });
      } else if (cand.startsWith('#')) {
        candidates.push({ selector: cand, kind: 'id' });
      } else {
        candidates.push({ selector: cand, kind: 'css' });
      }
    }
  }

  // Sort candidates so test_id comes first, then role, then id, then generic css
  const priorityOrder: Record<string, number> = {
    test_id: 1,
    role_name: 2,
    id: 3,
    css: 4
  };

  return candidates.sort((a, b) => priorityOrder[a.kind] - priorityOrder[b.kind]);
}

export function validateResolverMatchCount(matchesCount: number, selector: string): void {
  if (matchesCount === 0) {
    throw new TargetResolutionError(
      'TARGET_NOT_FOUND',
      `Target element not found using selector: ${selector}`
    );
  }
  if (matchesCount > 1) {
    throw new TargetResolutionError(
      'TARGET_AMBIGUOUS',
      `Ambiguous target: ${matchesCount} elements matched selector: ${selector}`
    );
  }
}
