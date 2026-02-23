import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DistributionStack } from '../src/stacks/distribution-stack';

const testEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

function createTestContext(): Record<string, string> {
  const env = 'test';
  const prefix = `/opencode/${env}`;
  const ssmKey = (name: string) =>
    `ssm:account=${testEnv.account}:parameterName=${name}:region=${testEnv.region}`;

  return {
    [ssmKey(`${prefix}/network/vpc-id`)]: 'vpc-12345',
    [ssmKey(`${prefix}/network/public-subnet-ids`)]: 'subnet-pub1,subnet-pub2',
    [ssmKey(`${prefix}/network/public-route-table-ids`)]: 'rtb-pub1,rtb-pub2',
    [ssmKey(`${prefix}/shared/certificate-arn`)]: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
    [ssmKey(`${prefix}/oidc/issuer`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    [ssmKey(`${prefix}/oidc/alb-client-id`)]: 'test-alb-client-id',
    [ssmKey(`${prefix}/oidc/cli-client-id`)]: 'test-cli-client-id',
    [ssmKey(`${prefix}/oidc/authorization-endpoint`)]: 'https://opencode-test.auth.us-east-1.amazoncognito.com/oauth2/authorize',
    [ssmKey(`${prefix}/oidc/token-endpoint`)]: 'https://opencode-test.auth.us-east-1.amazoncognito.com/oauth2/token',
    [ssmKey(`${prefix}/oidc/userinfo-endpoint`)]: 'https://opencode-test.auth.us-east-1.amazoncognito.com/oauth2/userInfo',
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
  const stack = new DistributionStack(app, 'TestDistribution', {
    environment: 'test',
    hostedZoneId: 'Z1234567890',
    hostedZoneName: 'example.com',
    apiDomain: 'oc.example.com',
    webDomain: 'downloads.oc.example.com',
    env: testEnv,
  });
  return Template.fromStack(stack);
}

let template: Template;
beforeAll(() => {
  template = createTemplate();
});

test('DistributionStack creates 3 S3 buckets (assets, access logs, ALB access logs)', () => {
  template.resourceCountIs('AWS::S3::Bucket', 3);
});

test('DistributionStack creates a landing page Lambda function', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'python3.14',
    MemorySize: 256,
    Timeout: 30,
  });
});

test('DistributionStack creates an internet-facing ALB', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('DistributionStack creates a Lambda target group', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    TargetType: 'lambda',
  });
});

test('DistributionStack creates 2 listener rules with OIDC auth', () => {
  // Rules: unauthenticated /version.json, OIDC-authenticated catch-all
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
});

test('DistributionStack creates 1 security group', () => {
  template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
});

test('DistributionStack creates 8 SSM parameters', () => {
  template.resourceCountIs('AWS::SSM::Parameter', 8);
});
