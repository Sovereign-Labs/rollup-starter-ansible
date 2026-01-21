import type { Check, CheckResult, CheckContext } from './types.js';
import type { NodeConfig } from '../runner/executor-interface.js';

const LEDGER_SLOTS_LATEST_URL = 'http://localhost:12346/ledger/slots/latest';
const RETRY_TIMEOUT_MS = 300;
const RETRY_INTERVAL_MS = 50;

interface LatestSlotResponse {
  number: number;
  state_root: string;
}

export const replicaStateRootCheck: Check = {
  name: 'replica-state-root',
  description: 'Verify replica state root matches primary',

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    // Find primary and replicas
    const primaryNodes = ctx.config.nodes.filter(n => n.role === 'primary');
    const replicaNodes = ctx.config.nodes.filter(n => n.role === 'secondary' || n.role === 'backup');

    if (primaryNodes.length === 0 || replicaNodes.length === 0) {
      return [];
    }

    const primary = primaryNodes[0];

    // Query primary once, then check all replicas in parallel
    const primarySlot = await queryLatestSlot(ctx, primary.name);
    if (!primarySlot) {
      // Return failure for all replicas if primary query fails
      return replicaNodes.map(replica => ({
        name: 'replica-state-root',
        node: replica.name,
        passed: false,
        message: `failed to query primary ${primary.name}`,
        durationMs: 0,
      }));
    }

    // Check all replicas in parallel
    const results = await Promise.all(
      replicaNodes.map(replica => checkReplica(ctx, replica, primarySlot))
    );

    return results;
  },
};

async function checkReplica(
  ctx: CheckContext,
  replica: NodeConfig,
  primarySlot: LatestSlotResponse
): Promise<CheckResult> {
  const startTime = Date.now();

  try {
    // Query replica, retrying if behind
    let replicaSlot = await queryLatestSlot(ctx, replica.name);
    const retryStart = Date.now();

    while (replicaSlot && replicaSlot.number < primarySlot.number) {
      if (Date.now() - retryStart > RETRY_TIMEOUT_MS) {
        break;
      }
      await sleep(RETRY_INTERVAL_MS);
      replicaSlot = await queryLatestSlot(ctx, replica.name);
    }

    if (!replicaSlot) {
      return {
        name: 'replica-state-root',
        node: replica.name,
        passed: false,
        message: `failed to query replica`,
        durationMs: Date.now() - startTime,
      };
    }

    if (replicaSlot.number < primarySlot.number) {
      return {
        name: 'replica-state-root',
        node: replica.name,
        passed: false,
        message: `replica behind: slot ${replicaSlot.number} < primary slot ${primarySlot.number}`,
        durationMs: Date.now() - startTime,
      };
    }

    if (replicaSlot.number > primarySlot.number) {
      return {
        name: 'replica-state-root',
        node: replica.name,
        passed: false,
        message: `replica ahead: slot ${replicaSlot.number} > primary slot ${primarySlot.number}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Numbers match, compare state roots
    const passed = replicaSlot.state_root === primarySlot.state_root;
    return {
      name: 'replica-state-root',
      node: replica.name,
      passed,
      message: passed
        ? `state root matches at slot ${primarySlot.number}`
        : `state root mismatch at slot ${primarySlot.number}: primary=${primarySlot.state_root.slice(0, 16)}..., replica=${replicaSlot.state_root.slice(0, 16)}...`,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: 'replica-state-root',
      node: replica.name,
      passed: false,
      message: `error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }
}

async function queryLatestSlot(
  ctx: CheckContext,
  nodeName: string
): Promise<LatestSlotResponse | null> {
  const result = await ctx.executor.exec(nodeName, `curl -s '${LEDGER_SLOTS_LATEST_URL}'`);
  if (result.exitCode !== 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout) as LatestSlotResponse;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
