export type ExternalNetworkPolicy = {
  allowedDomains: string[];
  deniedDomains: string[];
};

export function decodeExternalNetworkPolicy(
  value: unknown,
): ExternalNetworkPolicy;
