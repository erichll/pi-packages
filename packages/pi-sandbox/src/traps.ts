import type {
  SandboxBoundaryTrap,
  SandboxFilesystemTrap,
  SandboxNetworkTrap,
} from "@erichll/pi-auto-review/sandbox";

export type {
  SandboxBoundaryTrap,
  SandboxFilesystemTrap,
  SandboxNetworkTrap,
};

export type SandboxApprovalTrap = SandboxBoundaryTrap;
export type SandboxApprovalAction = "allow" | "deny";

export function formatSandboxTrap(trap: SandboxApprovalTrap): string {
  if (trap.kind === "filesystem") {
    return `${trap.operation} ${trap.path}`;
  }
  return `${trap.operation} ${trap.target}`;
}
