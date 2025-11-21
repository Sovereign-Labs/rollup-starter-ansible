# CDK Integration Guide

Quick reference for integrating Sovereign rollup ansible-pull deployment with AWS CDK.

## Required CDK Variables to Expose

Your CDK stack should accept these parameters:

### Essential Configuration

```typescript
interface RollupNodeProps {
  // Required
  dataAvailabilityRole: 'celestia' | 'mock_da';
  switches: 'cdr' | 'dr' | 'r';  // cdr=full, dr=skip infra, r=rollup only

  // Highly Recommended
  rollupCommitHash: string;      // Git commit to deploy
  zkvmRole: 'risc0' | 'mock_zkvm';
  debugBuild: boolean;           // true=faster compile, false=optimized

  // Celestia (required if dataAvailabilityRole='celestia')
  celestia?: {
    daStartHeight: number;
    batchNamespace: string;      // Exactly 10 characters
    proofNamespace: string;      // Exactly 10 characters
    rpcUrl: string;
    grpcUrl: string;
    rollupAddress: string;
    // Secrets - from Secrets Manager
    grpcAuthTokenSecretArn: string;
    signerPrivateKeySecretArn: string;
  };

  // Optional
  customHostLabel?: string;
  ansibleRepoUrl?: string;       // Default: public GitHub repo
  ansibleRepoBranch?: string;    // Default: 'main'
}
```

## CDK Stack Example

### 1. Define Stack Props

```typescript
// lib/rollup-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface RollupStackProps extends cdk.StackProps {
  rollupConfig: {
    dataAvailabilityRole: 'celestia' | 'mock_da';
    rollupCommitHash: string;
    zkvmRole: 'risc0' | 'mock_zkvm';
    debugBuild: boolean;
    switches: string;

    celestia?: {
      daStartHeight: number;
      batchNamespace: string;
      proofNamespace: string;
      rpcUrl: string;
      grpcUrl: string;
      rollupAddress: string;
      grpcAuthTokenSecretName: string;
      signerPrivateKeySecretName: string;
    };

    ansible?: {
      repoUrl: string;
      branch: string;
    };
  };

  vpc: ec2.IVpc;
  instanceType?: ec2.InstanceType;
}
```

### 2. Create EC2 Instance with User Data

```typescript
export class RollupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RollupStackProps) {
    super(scope, id, props);

    const { rollupConfig, vpc } = props;

    // Default values
    const ansibleRepoUrl = rollupConfig.ansible?.repoUrl ||
      'https://github.com/Sovereign-Labs/sov-rollup-starter-ansible.git';
    const ansibleBranch = rollupConfig.ansible?.branch || 'main';
    const instanceType = props.instanceType ||
      ec2.InstanceType.of(ec2.InstanceClass.C5AD, ec2.InstanceSize.XLARGE4);

    // Create security group
    const securityGroup = new ec2.SecurityGroup(this, 'RollupSG', {
      vpc,
      description: 'Security group for Sovereign rollup node',
      allowAllOutbound: true,
    });

    // Rollup API port
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(12346),
      'Rollup HTTP API'
    );

    // Nginx proxy port
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8081),
      'Nginx proxy'
    );

    // IAM role
    const role = new iam.Role(this, 'RollupInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Grant access to secrets (if Celestia)
    if (rollupConfig.dataAvailabilityRole === 'celestia' && rollupConfig.celestia) {
      const grpcTokenSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'GrpcTokenSecret',
        rollupConfig.celestia.grpcAuthTokenSecretName
      );

      const signerKeySecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'SignerKeySecret',
        rollupConfig.celestia.signerPrivateKeySecretName
      );

      grpcTokenSecret.grantRead(role);
      signerKeySecret.grantRead(role);
    }

    // Generate user data
    const userData = this.generateUserData(rollupConfig, ansibleRepoUrl, ansibleBranch);

    // Create instance
    const instance = new ec2.Instance(this, 'RollupInstance', {
      vpc,
      instanceType,
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
      ),
      securityGroup,
      role,
      userData: ec2.UserData.custom(userData),
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            iops: 3000,
            throughput: 125,
          }),
        },
      ],
      userDataCausesReplacement: true,
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'InstancePublicIp', {
      value: instance.instancePublicIp,
      description: 'Public IP address',
    });

    new cdk.CfnOutput(this, 'RollupApiUrl', {
      value: `http://${instance.instancePublicIp}:12346`,
      description: 'Rollup API endpoint',
    });

    new cdk.CfnOutput(this, 'NginxProxyUrl', {
      value: `http://${instance.instancePublicIp}:8081`,
      description: 'Nginx proxy endpoint',
    });
  }

  private generateUserData(
    config: RollupStackProps['rollupConfig'],
    repoUrl: string,
    branch: string
  ): string {
    const lines: string[] = [
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# Sovereign Rollup Deployment - Generated by CDK',
      `# Generated: ${new Date().toISOString()}`,
      '',
      'LOG_FILE="/var/log/cloud-init-sovereign.log"',
      'exec > >(tee -a "$LOG_FILE") 2>&1',
      '',
      'echo "=========================================="',
      'echo "Sovereign Rollup Deployment Starting"',
      'echo "=========================================="',
      '',
      '# Install prerequisites',
      'apt-get update -qq',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq software-properties-common',
      'add-apt-repository --yes --update ppa:ansible/ansible',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ansible git python3 python3-pip curl jq',
      '',
      '# Prepare runtime variables',
      'mkdir -p /tmp/ansible-sovereign/vars',
      'cat > /tmp/ansible-sovereign/vars/runtime_vars.yaml << EOF',
      '---',
      `data_availability_role: "${config.dataAvailabilityRole}"`,
      `switches: "${config.switches}"`,
      `zkvm_role: "${config.zkvmRole}"`,
      `debug: ${config.debugBuild}`,
      `rollup_commit_hash: "${config.rollupCommitHash}"`,
    ];

    // Add Celestia config if needed
    if (config.dataAvailabilityRole === 'celestia' && config.celestia) {
      const c = config.celestia;
      lines.push(
        `da_start_height: ${c.daStartHeight}`,
        `rollup_batch_namespace: "${c.batchNamespace}"`,
        `rollup_proof_namespace: "${c.proofNamespace}"`,
        `celestia_rpc_url: "${c.rpcUrl}"`,
        `celestia_grpc_url: "${c.grpcUrl}"`,
        `da_rollup_address: "${c.rollupAddress}"`,
        'EOF',
        '',
        '# Retrieve secrets from Secrets Manager',
        `GRPC_TOKEN=$(aws secretsmanager get-secret-value --secret-id ${c.grpcAuthTokenSecretName} --query SecretString --output text)`,
        `SIGNER_KEY=$(aws secretsmanager get-secret-value --secret-id ${c.signerPrivateKeySecretName} --query SecretString --output text)`,
        '',
        '# Append secrets to runtime vars',
        'cat >> /tmp/ansible-sovereign/vars/runtime_vars.yaml << EOF',
        `celestia_grpc_auth_token: "$GRPC_TOKEN"`,
        `signer_private_key: "$SIGNER_KEY"`,
      );
    }

    lines.push(
      'EOF',
      '',
      'chmod 600 /tmp/ansible-sovereign/vars/runtime_vars.yaml',
      '',
      '# Run ansible-pull',
      'cd /tmp/ansible-sovereign',
      'ansible-pull \\',
      `    --url "${repoUrl}" \\`,
      `    --checkout "${branch}" \\`,
      '    --inventory inventory/localhost.ini \\',
      '    --extra-vars "@/tmp/ansible-sovereign/vars/runtime_vars.yaml" \\',
      '    local.yml',
      '',
      'EXIT_CODE=$?',
      '',
      'if [[ $EXIT_CODE -eq 0 ]]; then',
      '    echo "✓ Deployment completed successfully"',
      '    systemctl status rollup --no-pager || true',
      'else',
      '    echo "✗ Deployment failed with exit code: $EXIT_CODE"',
      '    exit $EXIT_CODE',
      'fi',
      '',
      '# Cleanup',
      'shred -vfz /tmp/ansible-sovereign/vars/runtime_vars.yaml || true',
      '',
      'echo "=========================================="',
      'echo "Deployment Complete"',
      'echo "Logs: $LOG_FILE"',
      'echo "=========================================="',
    );

    return lines.join('\n');
  }
}
```

### 3. Usage in CDK App

```typescript
// bin/cdk-app.ts
import { RollupStack } from '../lib/rollup-stack';

const app = new cdk.App();

// Get VPC (existing or create new)
const vpc = ec2.Vpc.fromLookup(app, 'VPC', {
  vpcId: 'vpc-xxxxx'
});

// Deploy with Mock DA (development)
new RollupStack(app, 'RollupDevStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  rollupConfig: {
    dataAvailabilityRole: 'mock_da',
    switches: 'cdr',
    rollupCommitHash: '770a88a25576640b1e76b9385bf61b05452d60dd',
    zkvmRole: 'mock_zkvm',
    debugBuild: true,
  },
  vpc,
});

// Deploy with Celestia DA (production)
new RollupStack(app, 'RollupProdStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  rollupConfig: {
    dataAvailabilityRole: 'celestia',
    switches: 'cdr',
    rollupCommitHash: '770a88a25576640b1e76b9385bf61b05452d60dd',
    zkvmRole: 'risc0',
    debugBuild: false,
    celestia: {
      daStartHeight: 8877186,
      batchNamespace: 'prod-bat01',
      proofNamespace: 'prod-prf01',
      rpcUrl: 'https://rpc-mocha.pops.one',
      grpcUrl: 'grpc-mocha.pops.one:443',
      rollupAddress: 'celestia1jk6xx55wum73al8f2mp54x92uggqws8ksnjus2',
      grpcAuthTokenSecretName: 'sovereign/celestia/grpc-token',
      signerPrivateKeySecretName: 'sovereign/celestia/signer-key',
    },
  },
  vpc,
});
```

## Secrets Setup

### Create Secrets in AWS Secrets Manager

```bash
# Create gRPC auth token secret
aws secretsmanager create-secret \
    --name sovereign/celestia/grpc-token \
    --secret-string "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Create signer private key secret
aws secretsmanager create-secret \
    --name sovereign/celestia/signer-key \
    --secret-string "0x1234567890abcdef..."
```

### Update Secrets

```bash
# Update gRPC token
aws secretsmanager update-secret \
    --secret-id sovereign/celestia/grpc-token \
    --secret-string "new-token-value"

# Update private key
aws secretsmanager update-secret \
    --secret-id sovereign/celestia/signer-key \
    --secret-string "new-key-value"
```

## Deployment Commands

```bash
# Synthesize CloudFormation
cdk synth RollupDevStack

# Deploy development
cdk deploy RollupDevStack

# Deploy production
cdk deploy RollupProdStack

# Destroy stack
cdk destroy RollupDevStack
```

## Monitoring Deployment

### CloudWatch Logs

View cloud-init logs in CloudWatch:

```bash
# Install CloudWatch agent (add to user-data if desired)
# Logs are in /var/log/cloud-init-output.log
```

### SSM Session Manager

Connect without SSH:

```bash
# Get instance ID from CDK output
INSTANCE_ID="i-xxxxxxxxxxxxx"

# Start session
aws ssm start-session --target $INSTANCE_ID

# Check deployment status
sudo systemctl status rollup
sudo journalctl -u rollup -f
```

## Variable Summary for CDK

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `data_availability_role` | ✅ Yes | `'celestia' \| 'mock_da'` | DA backend |
| `switches` | ✅ Yes | `'cdr' \| 'dr' \| 'r'` | Roles to run |
| `rollup_commit_hash` | ⚠️ Recommended | `string` | Git commit SHA |
| `zkvm_role` | ⚠️ Recommended | `'risc0' \| 'mock_zkvm'` | zkVM backend |
| `debug` | ⚠️ Recommended | `boolean` | Debug vs release build |
| `da_start_height` | If Celestia | `number` | Celestia start height |
| `rollup_batch_namespace` | If Celestia | `string` | Batch namespace (10 chars) |
| `rollup_proof_namespace` | If Celestia | `string` | Proof namespace (10 chars) |
| `celestia_rpc_url` | If Celestia | `string` | RPC endpoint |
| `celestia_grpc_url` | If Celestia | `string` | gRPC endpoint |
| `da_rollup_address` | If Celestia | `string` | Celestia address |
| `celestia_grpc_auth_token` | If Celestia | `string` (secret) | Auth token |
| `signer_private_key` | If Celestia | `string` (secret) | Private key |

See `vars/runtime_vars.yaml.template` for complete variable list.

## Tips

### Fast Iteration

For development, use:
- `switches: "r"` - Deploy rollup only (skip infrastructure)
- `zkvm_role: "mock_zkvm"` - Fast builds
- `debug: true` - Faster compilation

### Production Optimization

For production, use:
- `switches: "cdr"` - Full deployment
- `zkvm_role: "risc0"` - Full proving
- `debug: false` - Optimized builds

### Pre-Baked AMI

1. Deploy once with `switches: "c"`
2. Create AMI: `aws ec2 create-image --instance-id i-xxx --name rollup-base`
3. Use AMI in CDK with `switches: "dr"` for faster boots

## Next Steps

- Review full documentation: [ANSIBLE_PULL.md](ANSIBLE_PULL.md)
- Test locally before CDK deployment
- Set up monitoring and alerting
- Configure backup strategies
