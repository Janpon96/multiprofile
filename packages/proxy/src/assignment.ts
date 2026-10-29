import { ProxyRecord } from '@multiprofile/contracts';
import { DomainError } from '@multiprofile/domain';

export type AssignmentPolicy = 'unique' | 'shared';

export interface AssignmentMappingItem {
  profile_id: string;
  proxy_id: string;
  proxy_host: string;
  proxy_port: number;
  duplicate_host_warning: boolean;
}

export function previewAutoAssignProxies(params: {
  profileIds: string[];
  availableProxies: ProxyRecord[];
  policy: AssignmentPolicy;
}): AssignmentMappingItem[] {
  const { profileIds, availableProxies, policy } = params;

  if (profileIds.length === 0) return [];
  if (availableProxies.length === 0) {
    throw new DomainError('CHECK_INCONCLUSIVE', 'No proxies available in pool for assignment');
  }

  if (policy === 'unique' && availableProxies.length < profileIds.length) {
    throw new DomainError(
      'CHECK_INCONCLUSIVE',
      `Policy 'unique' requires at least ${profileIds.length} proxies, but only ${availableProxies.length} available`
    );
  }

  const seenHosts = new Set<string>();
  const mappings: AssignmentMappingItem[] = [];

  for (let i = 0; i < profileIds.length; i++) {
    const profileId = profileIds[i];
    const proxy = policy === 'unique'
      ? availableProxies[i]
      : availableProxies[i % availableProxies.length];

    const hostDuplicate = seenHosts.has(proxy.host);
    seenHosts.add(proxy.host);

    mappings.push({
      profile_id: profileId,
      proxy_id: proxy.id,
      proxy_host: proxy.host,
      proxy_port: proxy.port,
      duplicate_host_warning: hostDuplicate
    });
  }

  return mappings;
}
