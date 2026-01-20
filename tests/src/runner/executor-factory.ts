import type { CommandExecutor, NodeConfig } from './executor-interface.js';
import { SSMSessionExecutor } from './ssm-session-executor.js';
import { SSHExecutor } from './ssh-executor.js';

export function createExecutor(nodes: NodeConfig[]): CommandExecutor {
  if (nodes.length === 0) {
    throw new Error('No nodes provided');
  }

  const transportTypes = new Set(nodes.map(n => n.transport.type));

  if (transportTypes.size > 1) {
    throw new Error(
      `Mixed transport types not supported. Found: ${Array.from(transportTypes).join(', ')}. ` +
      `All nodes must use the same transport type.`
    );
  }

  const transportType = nodes[0].transport.type;

  switch (transportType) {
    case 'ssm':
      return new SSMSessionExecutor(nodes);
    case 'ssh':
      return new SSHExecutor(nodes);
    default:
      throw new Error(`Unknown transport type: ${transportType}`);
  }
}
