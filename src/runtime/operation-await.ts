import type { LocalTikTokRuntime } from "./local-runtime.js";

/**
 * Wait for an async TikTok operation to settle.
 *
 * Publishing, following and the Studio reads all return an `operation_id`
 * instead of a result, so any orchestrator that answers a human (not an agent
 * that can poll itself) has to wait here. Kept as its own module so the wait
 * semantics live in one place instead of being re-implemented per channel.
 */

export interface AwaitOperationOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isPendingOperation(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const candidate = result as { operation_id?: unknown; status?: unknown };
  return typeof candidate.operation_id === "string" && candidate.status === "pending"
    ? candidate.operation_id
    : null;
}

export async function awaitOperation(
  runtime: LocalTikTokRuntime,
  operationId: string,
  options: AwaitOperationOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 2_500;
  const sleep = options.sleep ?? defaultSleep;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const status = runtime.operationStatus(operationId) as Record<string, unknown>;
    if (status.done) {
      return {
        operation_id: operationId,
        status: status.status,
        ...(status.result !== undefined ? { result: status.result } : {}),
        ...(status.error !== undefined ? { error: status.error } : {}),
        ...(status.error_code !== undefined ? { error_code: status.error_code } : {}),
      };
    }
  }

  return {
    operation_id: operationId,
    status: "pending",
    note: "La operacion sigue en curso. Podes consultar su estado mas tarde con tiktok_operation_status.",
  };
}
