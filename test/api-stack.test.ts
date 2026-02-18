import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../src/stacks/api-stack';

const testEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

// Dummy CDK context for SSM valueFromLookup and Vpc.fromLookup
function createTestContext(): Record<string, string> {
  const env = 'test';
  const prefix = `/opencode/${env}`;
  const ssmKey = (name: string) =>
    `ssm:account=${testEnv.account}:parameterName=${name}:region=${testEnv.region}`;

  return {
    [ssmKey(`${prefix}/network/vpc-id`)]: 'vpc-12345',
    [ssmKey(`${prefix}/network/vpc-cidr`)]: '10.0.0.0/16',
    [ssmKey(`${prefix}/network/public-subnet-ids`)]: 'subnet-pub1,subnet-pub2',
    [ssmKey(`${prefix}/network/private-subnet-ids`)]: 'subnet-priv1,subnet-priv2',
    [ssmKey(`${prefix}/network/public-route-table-ids`)]: 'rtb-pub1,rtb-pub2',
    [ssmKey(`${prefix}/network/private-route-table-ids`)]: 'rtb-priv1,rtb-priv2',
    [ssmKey(`${prefix}/shared/certificate-arn`)]: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
    [ssmKey(`${prefix}/oidc/jwks-url`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test/.well-known/jwks.json',
    [ssmKey(`${prefix}/oidc/issuer`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    [ssmKey(`${prefix}/oidc/cli-client-id`)]: 'test-cli-client-id',
    // Vpc.fromLookup context
    ['vpc-provider:account=123456789012:filter.vpc-id=vpc-12345:region=us-east-1:returnAsymmetricSubnets=true']: JSON.stringify({
      vpcId: 'vpc-12345',
      vpcCidrBlock: '10.0.0.0/16',
      ownerAccountId: '123456789012',
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      subnetGroups: [
        {
          name: 'Public',
          type: 'Public',
          subnets: [
            { subnetId: 'subnet-pub1', cidr: '10.0.0.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-pub1' },
            { subnetId: 'subnet-pub2', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-pub2' },
          ],
        },
        {
          name: 'Private',
          type: 'Private',
          subnets: [
            { subnetId: 'subnet-priv1', cidr: '10.0.2.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-priv1' },
            { subnetId: 'subnet-priv2', cidr: '10.0.3.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-priv2' },
          ],
        },
      ],
    }),
  };
}

function createTemplate(): Template {
  const context = createTestContext();
  const app = new cdk.App({ context });
  const stack = new ApiStack(app, 'TestApi', {
    environment: 'test',
    hostedZoneId: 'Z1234567890',
    hostedZoneName: 'example.com',
    domainName: 'oc.example.com',
    env: testEnv,
  });
  return Template.fromStack(stack);
}

let template: Template;
beforeAll(() => {
  template = createTemplate();
});

test('ApiStack creates an internet-facing ALB', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('ApiStack creates an ECS Cluster', () => {
  template.resourceCountIs('AWS::ECS::Cluster', 1);
});

test('ApiStack creates a Fargate Service', () => {
  template.resourceCountIs('AWS::ECS::Service', 1);
  template.hasResourceProperties('AWS::ECS::Service', {
    LaunchType: 'FARGATE',
  });
});

test('ApiStack creates a Task Definition with 512 CPU and 1024 MiB memory', () => {
  template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '512',
    Memory: '1024',
  });
});

test('ApiStack creates an ECR Repository', () => {
  template.resourceCountIs('AWS::ECR::Repository', 1);
});

test('ApiStack creates a DynamoDB table with PAY_PER_REQUEST billing', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'key_hash',
        KeyType: 'HASH',
      },
    ],
  });
});

test('ApiStack creates 2 security groups (ALB + service)', () => {
  template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
});

test('ApiStack creates a target group', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
});

test('ApiStack creates an S3 bucket for ALB access logs', () => {
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('ApiStack creates 4 listener rules', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 4);
});

test('ApiStack creates 15 SSM parameters', () => {
  template.resourceCountIs('AWS::SSM::Parameter', 15);
});
