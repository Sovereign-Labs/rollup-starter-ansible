export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandExecutor {
  exec(nodeName: string, command: string): Promise<CommandResult>;
  execOnAll(command: string): Promise<Map<string, CommandResult>>;
  getNodeNames(): string[];
  getNodesByRole(role: NodeRole): string[];
  close(): Promise<void>;

  // Stream output chunks as they arrive (optional - not all executors may support)
  execStreaming?(
    nodeName: string,
    command: string,
    onOutput: (chunk: string) => void
  ): Promise<CommandResult>;
}

export type NodeRole = 'primary' | 'secondary' | 'backup';

export type NodeTransport =
  | { type: 'ssm'; instanceId: string; region: string }
  | { type: 'ssh'; host: string; user?: string; keyPath?: string };

export interface NodeConfig {
  name: string;
  role: NodeRole;
  transport: NodeTransport;
  rpcPort: number;
}

export interface ExternalEndpoint {
  read: string;
  write: string;
}

export interface TestConfig {
  nodes: NodeConfig[];
  external: ExternalEndpoint[];
  settings: {
    allowDestructive: boolean;
  };
}
