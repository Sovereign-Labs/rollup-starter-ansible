import type { Check, CheckResult, CheckContext } from './types.js';

const POLL_INTERVAL_MS = 10000;
const MAX_WAIT_MS = 600000; // 10 minutes

export const waitDeploymentCheck: Check = {
  name: 'wait-deployment',
  description: 'Wait for ansible deployment to complete on all nodes',

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const startTime = Date.now();

    console.log('Waiting for deployment to complete on all nodes...');

    for (const node of ctx.config.nodes) {
      const nodeStart = Date.now();
      let passed = false;
      let message = '';

      while (Date.now() - startTime < MAX_WAIT_MS) {
        try {
          const result = await ctx.executor.exec(node.name, 'systemctl is-active sov-rollup');
          if (result.exitCode === 0 && result.stdout.trim() === 'active') {
            passed = true;
            message = 'service is active';
            break;
          }
        } catch {
          // Connection may fail while instance is still initializing
        }

        console.log(`  [${node.name}] still waiting... (${Math.round((Date.now() - nodeStart) / 1000)}s)`);
        await sleep(POLL_INTERVAL_MS);
      }

      if (!passed) {
        message = `timed out after ${MAX_WAIT_MS / 1000}s`;
      }

      results.push({
        name: 'wait-deployment',
        node: node.name,
        passed,
        message,
        durationMs: Date.now() - nodeStart,
      });
    }

    return results;
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
