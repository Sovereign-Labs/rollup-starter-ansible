import * as fs from 'fs';
import * as yaml from 'yaml';
import { z } from 'zod';
import type { TestConfig } from './executor-interface.js';

const SsmTransportSchema = z.object({
  type: z.literal('ssm'),
  instanceId: z.string().min(1),
  region: z.string().min(1),
});

const SshTransportSchema = z.object({
  type: z.literal('ssh'),
  host: z.string().min(1),
  user: z.string().optional(),
  keyPath: z.string().optional(),
});

const NodeTransportSchema = z.discriminatedUnion('type', [
  SsmTransportSchema,
  SshTransportSchema,
]);

const NodeConfigSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['primary', 'secondary', 'backup']),
  transport: NodeTransportSchema,
  rpcPort: z.number().int().positive(),
});

const ExternalEndpointSchema = z.object({
  read: z.string().url(),
  write: z.string().url(),
});

const TestConfigSchema = z.object({
  nodes: z.array(NodeConfigSchema).min(1),
  external: z.array(ExternalEndpointSchema).min(1),
  settings: z.object({
    allowDestructive: z.boolean(),
  }),
});

export function loadConfig(configPath: string): TestConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const raw = yaml.parse(content);

  const result = TestConfigSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues
      .map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${errors}`);
  }

  return result.data;
}
