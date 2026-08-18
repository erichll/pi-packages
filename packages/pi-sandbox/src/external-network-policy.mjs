import { NetworkConfigSchema } from "@anthropic-ai/sandbox-runtime";

/**
 * Decode the supervisor-owned network policy delivered during registration.
 * Any missing, extra, or malformed data becomes a deny-all policy so a broken
 * transport can never widen an external worker's access.
 */
export function decodeExternalNetworkPolicy(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => key !== "allowedDomains" && key !== "deniedDomains",
    )
  ) {
    return { allowedDomains: [], deniedDomains: ["*"] };
  }
  const result = NetworkConfigSchema.safeParse(value);
  if (!result.success) {
    return { allowedDomains: [], deniedDomains: ["*"] };
  }
  return {
    allowedDomains: [...result.data.allowedDomains],
    deniedDomains: [...result.data.deniedDomains],
  };
}
