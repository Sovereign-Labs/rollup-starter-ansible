import type { CommandExecutor, TestConfig } from '../runner/executor-interface.js';

export interface AnsiblePullOptions {
  branch: string;
  onOutput?: (nodeName: string, chunk: string) => void;
}

export interface AnsiblePullResult {
  success: boolean;
  results: Map<string, { exitCode: number; stdout: string; stderr: string }>;
}

export async function runAnsiblePull(
  executor: CommandExecutor,
  config: TestConfig,
  options: AnsiblePullOptions
): Promise<AnsiblePullResult> {
  const { branch, onOutput } = options;

  const cmd = `sudo ansible-pull -U https://github.com/Sovereign-Labs/rollup-starter-ansible.git -C ${branch} -i inventory/localhost.ini -e runtime_vars_file="/tmp/runtime_vars.yaml" local.yml 2>&1`;

  const nodeNames = executor.getNodeNames();
  const results = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
  let allSuccess = true;

  // Run on all nodes in parallel
  const promises = nodeNames.map(async (nodeName) => {
    let result;
    if (onOutput && executor.execStreaming) {
      result = await executor.execStreaming(nodeName, cmd, (chunk) => {
        onOutput(nodeName, chunk);
      });
    } else {
      result = await executor.exec(nodeName, cmd);
    }

    results.set(nodeName, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });

    if (result.exitCode !== 0) {
      allSuccess = false;
    }
  });

  await Promise.all(promises);

  return { success: allSuccess, results };
}
