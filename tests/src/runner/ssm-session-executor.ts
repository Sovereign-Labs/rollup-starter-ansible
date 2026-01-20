import { spawn, ChildProcess } from 'child_process';
import { SSMClient, StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm';
import type { CommandResult, CommandExecutor, NodeConfig, NodeRole } from './executor-interface.js';
import { Mutex } from '../lib/mutex.js';

const COMMAND_END_MARKER = '__CMD_DONE_a]!9x__';
const PROMPT_SETUP = `export PS1='${COMMAND_END_MARKER}'`;
const SESSION_READY_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 1200000; // 20 minutes

interface SSMConnection {
  process: ChildProcess;
  sessionId: string;
  outputBuffer: string;
  resolveOutput?: (output: string) => void;
  rejectOutput?: (error: Error) => void;
  onStreamOutput?: (chunk: string) => void;
  streamedLength: number; // Track how much we've already streamed
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

  async execStreaming(
    command: string,
    onOutput: (chunk: string) => void
  ): Promise<CommandResult> {
    const conn = await this.getOrCreateConnection();
    return this.commandMutex.withLock(() => this.execInternal(conn, command, onOutput));
  }

  async close(): Promise<void> {
    this.closed = true;
    const connectionPromise = this.connection;
    if (!connectionPromise) return;

    // Wait for any running command to finish before closing
    await this.commandMutex.withLock(async () => {
      try {
        const conn = await connectionPromise;
        conn.process.kill();
        await this.ssmClient.send(new TerminateSessionCommand({ SessionId: conn.sessionId }));
      } catch {
        // Ignore errors during cleanup
      }
    });
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
      streamedLength: 0,
    };

    // Set up output handling
    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (process.env.DEBUG_SSM) {
        console.error(`[DEBUG] received chunk: ${JSON.stringify(chunk)}`);
      }
      conn.outputBuffer += chunk;
      this.streamOutputIfEnabled(conn);
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

    // Wait for initial shell to be ready
    await this.waitForShellReady(conn);

    // Switch to ubuntu user (standard user on CDK instances).
    // This is a raw write because PS1 isn't set up yet - execInternal would hang.
    conn.process.stdin?.write('sudo su - ubuntu\n');
    await this.waitForShellReady(conn);

    // Disable bracketed paste mode - it adds escape sequences to the prompt
    // that interfere with our marker detection
    conn.process.stdin?.write("bind 'set enable-bracketed-paste off'\n");
    await this.waitForShellReady(conn);

    // Set up our custom prompt for command completion detection
    // (line-boundary detection handles the echoed command containing the marker)
    await this.execInternal(conn, PROMPT_SETUP);

    // Now disable terminal echo for cleaner subsequent command handling
    await this.execInternal(conn, 'stty -echo');

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
    // Look for marker at the start of a line (after \n or \r\n)
    // This distinguishes the prompt marker from the marker appearing in echoed commands
    const newlineMarker = '\n' + COMMAND_END_MARKER;
    let markerIndex = conn.outputBuffer.indexOf(newlineMarker);
    let prefixLength = 1; // length of \n

    if (markerIndex === -1) {
      // Also check for \r\n prefix
      const crlfMarker = '\r\n' + COMMAND_END_MARKER;
      markerIndex = conn.outputBuffer.indexOf(crlfMarker);
      prefixLength = 2; // length of \r\n
    }

    if (markerIndex !== -1 && conn.resolveOutput) {
      const output = conn.outputBuffer.substring(0, markerIndex);
      conn.outputBuffer = conn.outputBuffer.substring(markerIndex + prefixLength + COMMAND_END_MARKER.length);
      conn.outputBuffer = conn.outputBuffer.replace(/^\r?\n/, '');

      if (process.env.DEBUG_SSM) {
        console.error(`[DEBUG] marker found at line start, output: ${JSON.stringify(output)}`);
        console.error(`[DEBUG] remaining buffer: ${JSON.stringify(conn.outputBuffer)}`);
      }

      conn.resolveOutput(output);
      conn.resolveOutput = undefined;
      conn.rejectOutput = undefined;
    }
  }

  private async execInternal(
    conn: SSMConnection,
    command: string,
    onOutput?: (chunk: string) => void
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.resolveOutput = undefined;
        conn.rejectOutput = undefined;
        conn.onStreamOutput = undefined;
        reject(new Error(`Command timed out: ${command}`));
      }, COMMAND_TIMEOUT_MS);

      // Set up streaming if callback provided
      if (onOutput) {
        conn.streamedLength = 0;
        conn.onStreamOutput = onOutput;
      }

      conn.resolveOutput = (output: string) => {
        clearTimeout(timeout);
        conn.onStreamOutput = undefined;

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
        conn.onStreamOutput = undefined;
        reject(error);
      };

      const fullCommand = `${command}; echo $?\n`;
      conn.process.stdin?.write(fullCommand);
    });
  }

  private streamOutputIfEnabled(conn: SSMConnection): void {
    if (!conn.onStreamOutput) return;

    // Find complete lines we can safely stream (not including the potential exit code line)
    const buffer = conn.outputBuffer;
    const lastNewline = buffer.lastIndexOf('\n');

    if (lastNewline === -1) return; // No complete lines yet

    // Stream up to the last complete line, but not the very last line
    // (which might be the exit code)
    const lines = buffer.substring(0, lastNewline).split('\n');
    if (lines.length <= 1) return; // Keep at least one line buffered

    // Stream all but the last complete line
    const toStream = lines.slice(0, -1).join('\n') + '\n';
    const alreadyStreamed = conn.streamedLength;

    if (toStream.length > alreadyStreamed) {
      const newContent = toStream.substring(alreadyStreamed);
      conn.streamedLength = toStream.length;
      conn.onStreamOutput(newContent);
    }
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

  async execStreaming(
    nodeName: string,
    command: string,
    onOutput: (chunk: string) => void
  ): Promise<CommandResult> {
    const session = this.sessions.get(nodeName);
    if (!session) {
      throw new Error(`Unknown node: ${nodeName}`);
    }
    return session.execStreaming(command, onOutput);
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
