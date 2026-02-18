import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../src/stacks/network-stack';

const testEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

test('NetworkStack creates VPC with correct configuration', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetwork', {
    environment: 'test',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  // Verify VPC is created
  template.hasResourceProperties('AWS::EC2::VPC', {
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
  });

  // Verify subnets are created (2 public + 2 private = 4 total)
  template.resourceCountIs('AWS::EC2::Subnet', 4);

  // Verify NAT Gateway
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
});

test('NetworkStack creates VPC Flow Logs', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetworkFlowLogs', {
    environment: 'test',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::FlowLog', 1);
});

test('NetworkStack creates Bedrock VPC endpoints', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetworkEndpoints', {
    environment: 'test',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
});

test('NetworkStack exports SSM parameters', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetworkSSM', {
    environment: 'test',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/vpc-id',
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/vpc-cidr',
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/private-subnet-ids',
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/public-subnet-ids',
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/public-route-table-ids',
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/private-route-table-ids',
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/network/availability-zones',
  });
});
