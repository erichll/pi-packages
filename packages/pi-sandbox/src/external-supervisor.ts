import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NetworkEndpoint, TrapApprovalContext } from "./approval.ts";
import { approveDomainEndpoint } from "./approval.ts";
import type { NetworkConfig } from "./config.ts";

const MAX_FRAME_BYTES = 16 * 1024;
const PROTOCOL_VERSION = 1;

type Request = {
  version?: unknown;
  capability?: unknown;
  id?: unknown;
  type?: unknown;
  workerId?: unknown;
  cwd?: unknown;
  hostname?: unknown;
  port?: unknown;
};

export type ExternalWorkerSupervisorLifecycle = {
  /** Called immediately after a worker finishes the register protocol. */
  registered?(worker: { id: string; cwd: string; startedAt: number }): void;
  /** Called immediately after a worker completes the unregister protocol. */
  unregistered?(worker: { id: string; cwd: string }): void;
};

export type ExternalWorkerSupervisor = {
  socketPath: string;
  capability: string;
  workers(): ReadonlyArray<{
    id: string;
    cwd: string;
    state: "active" | "exited";
    startedAt: number;
    requests: number;
  }>;
  close(): Promise<void>;
};

export async function createExternalWorkerSupervisor(
  approvalContext: (worker: { id: string; cwd: string }) => TrapApprovalContext,
  lifecycle: ExternalWorkerSupervisorLifecycle = {},
  network: NetworkConfig = { allowedDomains: [], deniedDomains: [] },
): Promise<ExternalWorkerSupervisor> {
  const trustedNetwork = {
    allowedDomains: [...network.allowedDomains],
    deniedDomains: [...network.deniedDomains],
  };
  const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-external-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "supervisor.sock");
  const capability = randomBytes(32).toString("hex");
  const seen = new Set<string>();
  const workers = new Map<string, {
    cwd: string;
    state: "active" | "exited";
    startedAt: number;
    requests: number;
  }>();
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        socket.end('{"action":"deny"}\n');
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void respond(line);
        newline = buffer.indexOf("\n");
      }
    });
    const respond = async (line: string): Promise<void> => {
      let request: Request | undefined;
      try { request = JSON.parse(line) as Request; } catch { /* denied below */ }
      if (!request) {
        socket.write('{"action":"deny"}\n');
        return;
      }
      const baseValid =
        request.version === PROTOCOL_VERSION &&
        request.capability === capability &&
        typeof request.id === "string" && request.id.length > 0 && request.id.length <= 128 &&
        !seen.has(request.id);
      if (!baseValid) {
        socket.write('{"action":"deny"}\n');
        return;
      }
      const registered =
        request.type === "register" &&
        typeof request.workerId === "string" && request.workerId.length > 0 && request.workerId.length <= 128 &&
        typeof request.cwd === "string" && request.cwd.startsWith("/") && request.cwd.length <= 4_096 &&
        !workers.has(request.workerId);
      if (registered) {
        seen.add(request.id as string);
        workers.set(request.workerId as string, {
          cwd: request.cwd as string,
          state: "active",
          startedAt: Date.now(),
          requests: 0,
        });
        socket.write(`${JSON.stringify({
          id: request.id,
          action: "allow",
          network: {
            allowedDomains: [...trustedNetwork.allowedDomains],
            deniedDomains: [...trustedNetwork.deniedDomains],
          },
        })}\n`);
        lifecycle.registered?.({
          id: request.workerId as string,
          cwd: request.cwd as string,
          startedAt: workers.get(request.workerId as string)!.startedAt,
        });
        return;
      }
      const knownWorker =
        typeof request.workerId === "string" && typeof request.cwd === "string"
          ? workers.get(request.workerId)
          : undefined;
      const unregister = request.type === "unregister" &&
        knownWorker?.state === "active" && knownWorker.cwd === request.cwd;
      if (unregister) {
        seen.add(request.id as string);
        knownWorker.state = "exited";
        socket.write(`${JSON.stringify({ id: request.id, action: "allow" })}\n`);
        lifecycle.unregistered?.({
          id: request.workerId as string,
          cwd: request.cwd as string,
        });
        return;
      }
      const workerCwd =
        knownWorker?.state === "active" ? knownWorker.cwd : undefined;
      const valid = request.type === "network" &&
        workerCwd === request.cwd &&
        typeof request.hostname === "string" && request.hostname.length <= 253 &&
        Number.isInteger(request.port) && Number(request.port) > 0 && Number(request.port) <= 65535 &&
        Boolean(workerCwd);
      if (!valid) {
        socket.write('{"action":"deny"}\n');
        return;
      }
      const approvedRequest = request as Required<Request>;
      seen.add(approvedRequest.id as string);
      knownWorker!.requests++;
      let action: "allow" | "deny" = "deny";
      try {
        const endpoint: NetworkEndpoint = {
          hostname: approvedRequest.hostname as string,
          port: approvedRequest.port as number,
          protocol: "tcp",
        };
        action = (await approveDomainEndpoint(endpoint, approvalContext({
          id: approvedRequest.workerId as string,
          cwd: workerCwd as string,
        }))).action;
      } catch {
        action = "deny";
      }
      socket.write(`${JSON.stringify({ id: approvedRequest.id, action })}\n`);
    };
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    capability,
    workers() {
      return [...workers.entries()].map(([id, worker]) => ({ id, ...worker }));
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const EXTERNAL_SUPERVISOR_PROTOCOL_VERSION = PROTOCOL_VERSION;
