export type HostnameResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export function isPublicAddress(address: string, family?: number): boolean;
export function normalizePublicHostname(value: string): string | undefined;
export function validatePublicHostname(
  value: string,
  resolve?: HostnameResolver,
): Promise<string | undefined>;
