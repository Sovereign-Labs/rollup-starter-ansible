import { spawn, ChildProcess } from 'child_process';
import { SSMClient, StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm';
import type { CommandResult, CommandExecutor, NodeConfig, NodeRole } from './executor-interface.js';
import { Mutex } from '../lib/mutex.js';

const COMMAND_END_MARKER = '__CMD_DONE_a]!9x__';
const PROMPT_SETUP = `export PS1='${COMMAND_END_MARKER}\\n'`;
const SESSION_READY_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 120000;

interface SSMConnection {
  process: ChildProcess;
  sessionId: string;
  outputBuffer: string;
  resolveOutput?: (output: string) => void;
  rejectOutput?: (error: Error) => void;
}

class Session {
  private connection: Promise<SSMConnection> | null = null;
  private connectionMutex = new Mutex();
  private commandMutex = new Mutex();
  private closed = false;

  constructor(
    readonly name: string,
    private config: NodeConfig,
    private ssmClient: SSMClient,
  ) {}

  get role(): NodeRole {
    return this.config.role;
  }

  async exec(command: string): Promise<CommandResult> {
    const conn = await this.getOrCreateConnection();
    return this.commandMutex.withLock(() => this.execInternal(conn, command));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.connection) return;

    try {
      const conn = await this.connection;
      conn.process.kill();
      await this.ssmClient.send(new TerminateSessionCommand({ SessionId: conn.sessionId }));
    } catch {
      // Ignore errors during cleanup
    }
  }

  private async getOrCreateConnection(): Promise<SSMConnection> {
    if (this.closed) {
      throw new Error(`Session ${this.name} is closed`);
    }

    // Fast path: connection already exists or is being created
    if (this.connection) {
      return this.connection;
    }

    // Slow path: acquire lock and create if still null
    return this.connectionMutex.withLock(async () => {
      if (this.connection) {
        return this.connection;
      }

      this.connection = this.createConnection();
      return this.connection;
    });
  }

  private async createConnection(): Promise<SSMConnection> {
    if (this.config.transport.type !== 'ssm') {
      throw new Error(`Node ${this.name} does not use SSM transport`);
    }

    const { instanceId, region } = this.config.transport;

    // Start SSM session via API
    const startResponse = await this.ssmClient.send(
      new StartSessionCommand({ Target: instanceId })
    );

    if (!startResponse.SessionId || !startResponse.StreamUrl || !startResponse.TokenValue) {
      throw new Error('Failed to start SSM session: missing session details');
    }

    // Spawn session-manager-plugin
    const sessionDataJson = JSON.stringify({
      SessionId: startResponse.SessionId,
      StreamUrl: startResponse.StreamUrl,
      TokenValue: startResponse.TokenValue,
    });

    const pluginArgs = [
      sessionDataJson,
      region,
      'StartSession',
      '', // profile (empty for default)
      JSON.stringify({ Target: instanceId }),
    ];

    const proc = spawn('session-manager-plugin', pluginArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const conn: SSMConnection = {
      process: proc,
      sessionId: startResponse.SessionId,
      outputBuffer: '',
    };

    // Set up output handling
    proc.stdout?.on('data', (data: Buffer) => {
      conn.outputBuffer += data.toString();
      this.checkForCommandCompletion(conn);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      conn.outputBuffer += data.toString();
    });

    proc.on('error', (err) => {
      if (conn.rejectOutput) {
        conn.rejectOutput(err);
      }
    });

    proc.on('close', () => {
      this.connection = null;
    });

    // Wait for shell to be ready
    await this.waitForShellReady(conn);

    // Set up our custom prompt for command completion detection
    await this.execInternal(conn, PROMPT_SETUP);

    return conn;
  }

  private async waitForShellReady(conn: SSMConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for shell to be ready'));
      }, SESSION_READY_TIMEOUT_MS);

      const checkReady = () => {
        if (conn.outputBuffer.includes('$') ||
            conn.outputBuffer.includes('#') ||
            conn.outputBuffer.includes(COMMAND_END_MARKER)) {
          clearTimeout(timeout);
          conn.outputBuffer = '';
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };

      checkReady();
    });
  }

  private checkForCommandCompletion(conn: SSMConnection): void {
    const markerIndex = conn.outputBuffer.indexOf(COMMAND_END_MARKER);
    if (markerIndex !== -1 && conn.resolveOutput) {
      const output = conn.outputBuffer.substring(0, markerIndex);
      conn.outputBuffer = conn.outputBuffer.substring(markerIndex + COMMAND_END_MARKER.length);
      conn.outputBuffer = conn.outputBuffer.replace(/^\r?\n/, '');

      conn.resolveOutput(output);
      conn.resolveOutput = undefined;
      conn.rejectOutput = undefined;
    }
  }

  private async execInternal(conn: SSMConnection, command: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.resolveOutput = undefined;
        conn.rejectOutput = undefined;
        reject(new Error(`Command timed out: ${command}`));
      }, COMMAND_TIMEOUT_MS);

      conn.resolveOutput = (output: string) => {
        clearTimeout(timeout);

        const lines = output.trim().split('\n');
        const lastLine = lines[lines.length - 1]?.trim();
        const exitCode = parseInt(lastLine, 10);

        if (!isNaN(exitCode)) {
          lines.pop();
        }

        if (lines.length > 0 && lines[0].includes(command.split(';')[0])) {
          lines.shift();
        }

        resolve({
          stdout: lines.join('\n').trim(),
          stderr: '',
          exitCode: isNaN(exitCode) ? 0 : exitCode,
        });
      };

      conn.rejectOutput = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };

      const fullCommand = `${command}; echo $?\n`;
      conn.process.stdin?.write(fullCommand);
    });
  }
}

export class SSMSessionExecutor implements CommandExecutor {
  private sessions: Map<string, Session>;

  constructor(nodes: NodeConfig[]) {
    this.sessions = new Map();

    // Group nodes by region to share SSM clients
    const clientsByRegion = new Map<string, SSMClient>();

    for (const node of nodes) {
      if (node.transport.type !== 'ssm') {
        throw new Error(`SSMSessionExecutor only supports SSM transport, but ${node.name} uses ${node.transport.type}`);
      }

      const { region } = node.transport;
      let client = clientsByRegion.get(region);
      if (!client) {
        client = new SSMClient({ region });
        clientsByRegion.set(region, client);
      }

      this.sessions.set(node.name, new Session(node.name, node, client));
    }
  }

  getNodeNames(): string[] {
    return Array.from(this.sessions.keys());
  }

  getNodesByRole(role: NodeRole): string[] {
    return Array.from(this.sessions.values())
      .filter(session => session.role === role)
      .map(session => session.name);
  }

  async exec(nodeName: string, command: string): Promise<CommandResult> {
    const session = this.sessions.get(nodeName);
    if (!session) {
      throw new Error(`Unknown node: ${nodeName}`);
    }
    return session.exec(command);
  }

  async execOnAll(command: string): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();
    const promises = Array.from(this.sessions.keys()).map(async (nodeName) => {
      const result = await this.exec(nodeName, command);
      results.set(nodeName, result);
    });

    await Promise.all(promises);
    return results;
  }

  async close(): Promise<void> {
    const closePromises = Array.from(this.sessions.values()).map(s => s.close());
    await Promise.all(closePromises);
  }
}
