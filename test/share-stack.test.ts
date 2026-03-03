import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ShareStack } from '../src/stacks/share-stack';

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
    [ssmKey(`${prefix}/oidc/jwks-url`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test/.well-known/jwks.json',
    [ssmKey(`${prefix}/oidc/issuer`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    [ssmKey(`${prefix}/oidc/cli-client-id`)]: 'test-cli-client-id',
    [ssmKey(`${prefix}/oidc/alb-client-id`)]: 'test-alb-client-id',
    [ssmKey(`${prefix}/oidc/authorization-endpoint`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test/oauth2/authorize',
    [ssmKey(`${prefix}/oidc/token-endpoint`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test/oauth2/token',
    [ssmKey(`${prefix}/oidc/userinfo-endpoint`)]: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test/oauth2/userInfo',
    [ssmKey(`${prefix}/network/vpc-id`)]: 'vpc-12345',
    [ssmKey(`${prefix}/network/public-subnet-ids`)]: 'subnet-pub1,subnet-pub2',
    [ssmKey(`${prefix}/network/public-route-table-ids`)]: 'rtb-pub1,rtb-pub2',
    [ssmKey(`${prefix}/shared/certificate-arn`)]: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert',
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
      ],
    }),
  };
}

function createTemplate(): Template {
  const context = createTestContext();
  const app = new cdk.App({ context });
  const stack = new ShareStack(app, 'TestShare', {
    environment: 'test',
    shareDomain: 'share.oc.example.com',
    hostedZoneId: 'Z1234567890',
    hostedZoneName: 'example.com',
    env: testEnv,
  });
  return Template.fromStack(stack);
}

let template: Template;
beforeAll(() => {
  template = createTemplate();
});

test('ShareStack creates an S3 bucket with encryption and versioning', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256',
          },
        },
      ],
    },
    VersioningConfiguration: {
      Status: 'Enabled',
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('ShareStack creates a DynamoDB table with PAY_PER_REQUEST and TTL', () => {
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'connectionId',
        KeyType: 'HASH',
      },
    ],
    TimeToLiveSpecification: {
      AttributeName: 'ttl',
      Enabled: true,
    },
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
    },
  });
});

test('ShareStack creates DynamoDB GSI for ShareIdIndex', () => {
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    GlobalSecondaryIndexes: [
      {
        IndexName: 'ShareIdIndex',
        KeySchema: [
          {
            AttributeName: 'shareId',
            KeyType: 'HASH',
          },
        ],
        Projection: {
          ProjectionType: 'ALL',
        },
      },
    ],
  });
});

test('ShareStack creates 5 Lambda functions with Node.js 20.x runtime (plus 1 CDK custom resource)', () => {
  // 5 application Lambdas + 1 CDK auto-delete objects custom resource = 6
  template.resourceCountIs('AWS::Lambda::Function', 6);
  // Verify application Lambdas use Node.js 20.x
  const lambdas = template.findResources('AWS::Lambda::Function', {
    Properties: {
      Runtime: 'nodejs20.x',
    },
  });
  expect(Object.keys(lambdas).length).toBe(5);
});

test('ShareStack creates a WebSocket API Gateway with WEBSOCKET protocol', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'WEBSOCKET',
    RouteSelectionExpression: '$request.body.action',
  });
});

test('ShareStack creates 3 WebSocket routes ($connect, $disconnect, $default)', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 3);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: '$connect',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: '$disconnect',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: '$default',
  });
});

test('ShareStack creates an internet-facing ALB', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('ShareStack creates 5 ALB listener rules', () => {
  // Rules: JWT validation, API key passthrough, OIDC viewer, OIDC data, OIDC landing
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 5);
});

test('ShareStack creates 2 CloudWatch alarms (errors and throttles)', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: Match.stringLikeRegexp('errors'),
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: Match.stringLikeRegexp('throttles'),
  });
});

test('ShareStack creates 8 SSM parameters', () => {
  template.resourceCountIs('AWS::SSM::Parameter', 8);
});

test('ShareStack creates a Route53 A record for the share domain', () => {
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'share.oc.example.com.',
    Type: 'A',
  });
});

test('ShareStack creates a WebSocket stage with autoDeploy and throttling', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    StageName: 'prod',
    AutoDeploy: true,
    DefaultRouteSettings: {
      ThrottlingBurstLimit: 1000,
      ThrottlingRateLimit: 500,
    },
  });
});

test('ShareStack creates 2 S3 buckets (data + ALB logs)', () => {
  template.resourceCountIs('AWS::S3::Bucket', 2);
});

test('ShareStack Share API Lambda has correct environment variables', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'dist/index.handler',
    Environment: {
      Variables: {
        OPENCODE_STORAGE_BUCKET: Match.anyValue(),
        OPENCODE_STORAGE_REGION: 'us-east-1',
        BROADCAST_LAMBDA_ARN: Match.anyValue(),
        API_GATEWAY_URL: 'https://share.oc.example.com',
        SHARE_VIEWER_BASE_URL: 'https://share.oc.example.com',
        CORS_ALLOWED_ORIGIN: 'https://share.oc.example.com',
        NODE_ENV: 'production',
      },
    },
  });
});
