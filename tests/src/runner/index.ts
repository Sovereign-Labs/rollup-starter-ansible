#!/usr/bin/env tsx

import { parseArgs } from 'util';
import { loadConfig } from './config.js';
import { createExecutor } from './executor-factory.js';
import type { CommandExecutor, TestConfig } from './executor-interface.js';
import { getAllChecks, type Check, type CheckResult, type CheckContext } from '../checks/index.js';

export { loadConfig } from './config.js';
export { createExecutor } from './executor-factory.js';
export type { CommandExecutor, CommandResult, TestConfig, NodeConfig, NodeRole, ExternalEndpoint } from './executor-interface.js';

interface TestContext {
  config: TestConfig;
  executor: CommandExecutor;
}

let globalContext: TestContext | null = null;

export function getTestContext(): TestContext {
  if (!globalContext) {
    throw new Error('Test context not initialized. Call initTestContext() first.');
  }
  return globalContext;
}

export async function initTestContext(configPath: string): Promise<TestContext> {
  const config = loadConfig(configPath);
  const executor = createExecutor(config.nodes);

  globalContext = { config, executor };
  return globalContext;
}

export async function cleanupTestContext(): Promise<void> {
  if (globalContext) {
    await globalContext.executor.close();
    globalContext = null;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: 'hosts.yaml' },
      help: { type: 'boolean', short: 'h' },
      destructive: { type: 'boolean', default: false },
      'ansible-pull-branch': { type: 'string', default: 'main' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Usage: npx tsx src/runner [options] [command]

Options:
  -c, --config <path>       Path to hosts.yaml config file (default: hosts.yaml)
  -h, --help                Show this help message
  --destructive             Include destructive checks (validate command)
  --ansible-pull-branch     Branch for ansible-pull (default: main)

Commands:
  check                     Verify connectivity to all nodes
  exec <command>            Execute a command on all nodes
  validate                  Run validation checks
  ansible-pull              Run ansible-pull on all nodes

Examples:
  npx tsx src/runner --config hosts.yaml check
  npx tsx src/runner exec "systemctl status rollup"
  npx tsx src/runner validate
  npx tsx src/runner validate --destructive
  npx tsx src/runner ansible-pull --ansible-pull-branch feature-x
`);
    process.exit(0);
  }

  const configPath = values.config || 'hosts.yaml';
  const [command, ...args] = positionals;

  const context = await initTestContext(configPath);

  try {
    switch (command) {
      case 'check':
        await checkConnectivity(context);
        break;

      case 'exec':
        if (args.length === 0) {
          console.error('Error: exec requires a command argument');
          process.exit(1);
        }
        await execOnAll(context, args.join(' '));
        break;

      case 'validate':
        await runValidation(context, values.destructive ?? false);
        break;

      case 'ansible-pull':
        await runAnsiblePull(context, values['ansible-pull-branch'] ?? 'main');
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run with --help for usage information');
        process.exit(1);
    }
  } finally {
    await cleanupTestContext();
  }
}

async function checkConnectivity(context: TestContext): Promise<void> {
  console.log('Checking connectivity to all nodes...\n');

  const results = await context.executor.execOnAll('echo "ok"');

  let allOk = true;
  for (const [nodeName, result] of results) {
    const status = result.exitCode === 0 && result.stdout.includes('ok') ? '✓' : '✗';
    if (status === '✗') allOk = false;
    console.log(`  ${status} ${nodeName}: ${result.exitCode === 0 ? 'connected' : `failed (exit ${result.exitCode})`}`);
    if (result.stderr) {
      console.log(`    stderr: ${result.stderr}`);
    }
  }

  console.log('');
  if (allOk) {
    console.log('All nodes reachable.');
  } else {
    console.log('Some nodes failed connectivity check.');
    process.exit(1);
  }
}

async function execOnAll(context: TestContext, command: string): Promise<void> {
  console.log(`Executing on all nodes: ${command}\n`);

  const results = await context.executor.execOnAll(command);

  for (const [nodeName, result] of results) {
    console.log(`--- ${nodeName} (exit ${result.exitCode}) ---`);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.log(`stderr: ${result.stderr}`);
    console.log('');
  }
}

async function runValidation(context: TestContext, includeDestructive: boolean): Promise<void> {
  const allChecks = getAllChecks();
  const checks = allChecks.filter(c => includeDestructive ? c.destructive : !c.destructive);

  if (checks.length === 0) {
    console.log(includeDestructive
      ? 'No destructive checks registered.'
      : 'No validation checks registered.');
    return;
  }

  if (includeDestructive && !context.config.settings.allowDestructive) {
    console.error('Error: destructive checks require allowDestructive: true in config');
    process.exit(1);
  }

  console.log(`Running ${checks.length} ${includeDestructive ? 'destructive' : 'validation'} check(s)...\n`);

  const checkContext: CheckContext = {
    config: context.config,
    executor: context.executor,
  };

  let totalPassed = 0;
  let totalFailed = 0;

  for (const check of checks) {
    const results = await check.run(checkContext);
    for (const result of results) {
      const icon = result.passed ? '✓' : '✗';
      const nodeInfo = result.node ? ` [${result.node}]` : '';
      console.log(`  ${icon} ${result.name}${nodeInfo}: ${result.message} (${result.durationMs}ms)`);
      if (result.passed) {
        totalPassed++;
      } else {
        totalFailed++;
      }
    }
  }

  console.log(`\n${totalPassed} passed, ${totalFailed} failed`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

async function runAnsiblePull(context: TestContext, branch: string): Promise<void> {
  console.log(`Running ansible-pull on all nodes (branch: ${branch})...\n`);

  const cmd = `ansible-pull -U https://github.com/Sovereign-Labs/rollup-starter-ansible.git -C ${branch} -i inventory/localhost.ini -e @/tmp/runtime_vars.yaml local.yml`;

  const results = await context.executor.execOnAll(cmd);

  let allOk = true;
  for (const [nodeName, result] of results) {
    const icon = result.exitCode === 0 ? '✓' : '✗';
    if (result.exitCode !== 0) allOk = false;
    console.log(`  ${icon} ${nodeName}: exit ${result.exitCode}`);
    if (result.exitCode !== 0 && result.stderr) {
      console.log(`    stderr: ${result.stderr}`);
    }
  }

  console.log('');
  if (allOk) {
    console.log('ansible-pull completed successfully on all nodes.');
  } else {
    console.log('ansible-pull failed on some nodes.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
