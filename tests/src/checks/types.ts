import type { CommandExecutor, TestConfig, NodeRole } from '../runner/executor-interface.js';

export interface CheckResult {
  name: string;
  node?: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

export interface CheckContext {
  config: TestConfig;
  executor: CommandExecutor;
}

export interface Check {
  name: string;
  description: string;

  // Which node roles this check applies to.
  // If undefined or empty, the check is global (not per-node).
  applicableRoles?: NodeRole[];

  // If true, requires allowDestructive in config settings.
  destructive?: boolean;

  // Run the check and return results.
  // May return multiple results (e.g., one per applicable node).
  run(ctx: CheckContext): Promise<CheckResult[]>;
}
