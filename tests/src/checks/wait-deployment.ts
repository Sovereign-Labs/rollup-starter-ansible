import type { Check, CheckResult, CheckContext } from './types.js';
import type { NodeConfig } from '../runner/executor-interface.js';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 1200000; // 20 minutes (ansible can take a while)
const USER_DATA_LOG = '/var/log/user-data.log';

// Patterns for detecting ansible completion
const PLAY_RECAP_PATTERN = /^PLAY RECAP \*+/;
const LOCALHOST_SUMMARY_PATTERN = /^localhost\s+:\s+ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)/;
const ANSIBLE_START_PATTERN = /^Starting Ansible Pull at/;
const FATAL_PATTERN = /^fatal: \[localhost\]: FAILED!/;
const ERROR_PATTERN = /\[ERROR\]:/;

interface AnsibleRunResult {
  completed: boolean;
  failed: boolean;
  failedCount: number;
  errorLines: string[];
}

export const waitDeploymentCheck: Check = {
  name: 'wait-deployment',
  description: 'Wait for ansible deployment to complete on all nodes',

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    console.log('Waiting for deployment to complete on all nodes...');

    const startTime = Date.now();

    // Run all nodes in parallel, sharing the same start time for timeout
    const results = await Promise.all(
      ctx.config.nodes.map(node => waitForNode(ctx, node, startTime))
    );

    return results;
  },
};

async function waitForNode(
  ctx: CheckContext,
  node: NodeConfig,
  startTime: number
): Promise<CheckResult> {
  const nodeStart = Date.now();
  let passed = false;
  let message = '';
  let lastLogLength = 0;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      // Read the user-data log and check ansible status
      const logResult = await ctx.executor.exec(node.name, `sudo cat ${USER_DATA_LOG} 2>/dev/null || echo ""`);
      const logContent = logResult.stdout;

      if (logContent.length > 0) {
        const runResult = parseAnsibleLog(logContent);

        if (runResult.completed) {
          if (runResult.failed) {
            // Ansible completed but failed
            passed = false;
            message = `ansible failed (${runResult.failedCount} task(s) failed)`;
            if (runResult.errorLines.length > 0) {
              const errorPreview = runResult.errorLines.slice(-3).join('\n');
              console.log(`  [${node.name}] Ansible error:\n${errorPreview}`);
            }
            break;
          }

          // Ansible completed successfully, now check the service
          const serviceResult = await ctx.executor.exec(node.name, 'sudo systemctl is-active rollup');
          if (serviceResult.exitCode === 0 && serviceResult.stdout.trim() === 'active') {
            passed = true;
            message = 'ansible succeeded, service is active';
            break;
          } else {
            // Ansible succeeded but service not running - might need more time or there's an issue
            const elapsed = Math.round((Date.now() - nodeStart) / 1000);
            console.log(`  [${node.name}] ansible completed but service not active yet (${elapsed}s)`);
          }
        } else {
          // Ansible still running - show progress if log grew
          if (logContent.length > lastLogLength) {
            lastLogLength = logContent.length;
            const elapsed = Math.round((Date.now() - nodeStart) / 1000);
            console.log(`  [${node.name}] ansible still running... (${elapsed}s)`);
          }
        }
      } else {
        // Log file doesn't exist yet or is empty
        const elapsed = Math.round((Date.now() - nodeStart) / 1000);
        console.log(`  [${node.name}] waiting for user-data to start... (${elapsed}s)`);
      }
    } catch {
      // Connection may fail while instance is still initializing
      const elapsed = Math.round((Date.now() - nodeStart) / 1000);
      console.log(`  [${node.name}] waiting for instance... (${elapsed}s)`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (!passed && !message) {
    message = `timed out after ${Math.round((Date.now() - startTime) / 1000)}s`;
  }

  return {
    name: 'wait-deployment',
    node: node.name,
    passed,
    message,
    durationMs: Date.now() - nodeStart,
  };
}

function parseAnsibleLog(logContent: string): AnsibleRunResult {
  const lines = logContent.split('\n');

  // We need to find the LAST ansible run's result
  // (ansible may restart after failure)
  let lastRunStartIndex = -1;
  let playRecapIndex = -1;
  let localhostSummaryLine = '';
  const errorLines: string[] = [];

  // Find the last "Starting Ansible Pull" to track only the most recent run
  for (let i = 0; i < lines.length; i++) {
    if (ANSIBLE_START_PATTERN.test(lines[i])) {
      lastRunStartIndex = i;
      // Reset error tracking for new run
      errorLines.length = 0;
    }

    // Only track errors after the last ansible start
    if (lastRunStartIndex >= 0 && i > lastRunStartIndex) {
      if (FATAL_PATTERN.test(lines[i]) || ERROR_PATTERN.test(lines[i])) {
        errorLines.push(lines[i]);
      }
    }

    if (PLAY_RECAP_PATTERN.test(lines[i])) {
      playRecapIndex = i;
    }

    // The localhost summary line comes right after PLAY RECAP
    if (playRecapIndex >= 0 && i > playRecapIndex && LOCALHOST_SUMMARY_PATTERN.test(lines[i])) {
      localhostSummaryLine = lines[i];
      // Don't break - there might be another ansible run after this
    }
  }

  // If we found PLAY RECAP but no localhost line after it, ansible is mid-recap
  if (playRecapIndex >= 0 && !localhostSummaryLine) {
    // Check if PLAY RECAP is from the current run
    if (playRecapIndex > lastRunStartIndex) {
      return { completed: false, failed: false, failedCount: 0, errorLines: [] };
    }
  }

  if (!localhostSummaryLine) {
    return { completed: false, failed: false, failedCount: 0, errorLines: [] };
  }

  // Parse the localhost summary to get failed count
  const match = LOCALHOST_SUMMARY_PATTERN.exec(localhostSummaryLine);
  if (!match) {
    return { completed: false, failed: false, failedCount: 0, errorLines: [] };
  }

  const failedCount = parseInt(match[4], 10);

  return {
    completed: true,
    failed: failedCount > 0,
    failedCount,
    errorLines,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
