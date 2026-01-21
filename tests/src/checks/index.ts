import type { Check, CheckResult, CheckContext } from './types.js';
import type { NodeConfig, NodeRole } from '../runner/executor-interface.js';
import { waitDeploymentCheck } from './wait-deployment.js';
import { heightIncreasingCheck } from './height-increasing.js';
import { replicaStateRootCheck } from './replica-state-root.js';

// Check groups run sequentially, but checks within a group run in parallel
const checkGroups: Check[][] = [
  // Group 1: wait for deployment (must complete before other checks)
  [waitDeploymentCheck],
  // Group 2: basic health checks (can run in parallel)
  [heightIncreasingCheck, replicaStateRootCheck],
];

export function getAllCheckGroups(): Check[][] {
  return checkGroups;
}

export function getAllChecks(): Check[] {
  return checkGroups.flat();
}

// Helper for checks that run on each applicable node in parallel
export async function runOnNodes(
  ctx: CheckContext,
  checkName: string,
  applicableRoles: NodeRole[] | undefined,
  runOnNode: (ctx: CheckContext, node: NodeConfig) => Promise<CheckResult>
): Promise<CheckResult[]> {
  const nodes = applicableRoles?.length
    ? ctx.config.nodes.filter(n => applicableRoles.includes(n.role))
    : ctx.config.nodes;

  const results = await Promise.all(
    nodes.map(node => runOnNode(ctx, node))
  );

  return results;
}

export interface ValidationOptions {
  destructive: boolean;
  onResult?: (result: CheckResult) => void;
}

export interface ValidationResult {
  passed: number;
  failed: number;
  results: CheckResult[];
}

export async function runValidation(
  ctx: CheckContext,
  options: ValidationOptions
): Promise<ValidationResult> {
  const { destructive, onResult } = options;

  // Filter groups to only include checks matching the destructive flag
  const filteredGroups = checkGroups
    .map(group => group.filter(c => destructive ? c.destructive : !c.destructive))
    .filter(group => group.length > 0);

  if (filteredGroups.length === 0) {
    return { passed: 0, failed: 0, results: [] };
  }

  if (destructive && !ctx.config.settings.allowDestructive) {
    throw new Error('Destructive checks require allowDestructive: true in config');
  }

  const allResults: CheckResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  // Run groups sequentially
  for (const group of filteredGroups) {
    // Run checks within group in parallel
    const groupResultArrays = await Promise.all(
      group.map(check => check.run(ctx))
    );

    // Process results from all checks in this group
    for (const results of groupResultArrays) {
      for (const result of results) {
        allResults.push(result);
        if (result.passed) {
          totalPassed++;
        } else {
          totalFailed++;
        }
        onResult?.(result);
      }
    }

    // If any check in the group failed, stop processing subsequent groups
    if (totalFailed > 0) {
      break;
    }
  }

  return { passed: totalPassed, failed: totalFailed, results: allResults };
}

export type { Check, CheckResult, CheckContext } from './types.js';
