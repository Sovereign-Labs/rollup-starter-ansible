import { spawn } from 'child_process';
import type { CommandResult, CommandExecutor, NodeConfig, NodeRole } from './executor-interface.js';

const COMMAND_TIMEOUT_MS = 120000;

export class SSHExecutor implements CommandExecutor {
  private nodes: Map<string, NodeConfig>;

  constructor(nodes: NodeConfig[]) {
    this.nodes = new Map();

    for (const node of nodes) {
      if (node.transport.type !== 'ssh') {
        throw new Error(`SSHExecutor only supports SSH transport, but ${node.name} uses ${node.transport.type}`);
      }
      this.nodes.set(node.name, node);
    }
  }

  getNodeNames(): string[] {
    return Array.from(this.nodes.keys());
  }

  getNodesByRole(role: NodeRole): string[] {
    return Array.from(this.nodes.entries())
      .filter(([_, config]) => config.role === role)
      .map(([name]) => name);
  }

  async exec(nodeName: string, command: string): Promise<CommandResult> {
    const node = this.nodes.get(nodeName);
    if (!node) {
      throw new Error(`Unknown node: ${nodeName}`);
    }

    if (node.transport.type !== 'ssh') {
      throw new Error(`Node ${nodeName} does not use SSH transport`);
    }

    const { host, user, keyPath } = node.transport;

    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes',
    ];

    if (keyPath) {
      sshArgs.push('-i', keyPath);
    }

    const target = user ? `${user}@${host}` : host;
    sshArgs.push(target, command);

    return this.runSsh(sshArgs);
  }

  async execOnAll(command: string): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();
    const promises = Array.from(this.nodes.keys()).map(async (nodeName) => {
      const result = await this.exec(nodeName, command);
      results.set(nodeName, result);
    });

    await Promise.all(promises);
    return results;
  }

  async close(): Promise<void> {
    // Nothing to clean up for per-command SSH
  }

  private runSsh(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`SSH command timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0,
        });
      });
    });
  }
}
