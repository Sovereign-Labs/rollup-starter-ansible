import type { Check, CheckResult, CheckContext } from './types.js';
import type { NodeConfig, NodeRole } from '../runner/executor-interface.js';
import { runOnNodes } from './index.js';

const POLL_COUNT = 3;
const POLL_INTERVAL_MS = 7000;
const CHAIN_STATE_URL = 'http://localhost:12346/modules/chain-state/state/current-heights/';

const APPLICABLE_ROLES: NodeRole[] = ['primary', 'secondary', 'backup'];

interface CurrentHeights {
  value: [number, number]; // [RollupHeight, VisibleSlotNumber]
}

export const heightIncreasingCheck: Check = {
  name: 'height-increasing',
  description: 'Verify rollup height is increasing on all nodes',
  applicableRoles: APPLICABLE_ROLES,

  run(ctx: CheckContext): Promise<CheckResult[]> {
    return runOnNodes(ctx, 'height-increasing', APPLICABLE_ROLES, runOnNode);
  },
};

async function runOnNode(ctx: CheckContext, node: NodeConfig): Promise<CheckResult> {
  const startTime = Date.now();
  const heights: number[] = [];
  let errorMsg = '';

  for (let i = 0; i < POLL_COUNT; i++) {
    if (i > 0) {
      await sleep(POLL_INTERVAL_MS);
    }

    try {
      const result = await ctx.executor.exec(node.name, `curl -s '${CHAIN_STATE_URL}'`);
      if (result.exitCode !== 0) {
        errorMsg = `curl failed with exit code ${result.exitCode}`;
        break;
      }

      const data: CurrentHeights = JSON.parse(result.stdout);
      const rollupHeight = data.value[0];
      heights.push(rollupHeight);
    } catch (err) {
      errorMsg = `failed to query height: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }

  if (errorMsg) {
    return {
      name: 'height-increasing',
      node: node.name,
      passed: false,
      message: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }

  // Check that each subsequent height is greater than the previous
  let passed = true;
  for (let i = 1; i < heights.length; i++) {
    if (heights[i] <= heights[i - 1]) {
      passed = false;
      break;
    }
  }

  const heightsStr = heights.join(' -> ');
  return {
    name: 'height-increasing',
    node: node.name,
    passed,
    message: passed
      ? `height increased: ${heightsStr}`
      : `height did not increase: ${heightsStr}`,
    durationMs: Date.now() - startTime,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
