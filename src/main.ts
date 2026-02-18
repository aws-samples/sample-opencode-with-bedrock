#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NetworkStack } from './stacks/network-stack';
import { SharedCertificateStack } from './stacks/shared-certificate-stack';
import { AuthStack, AuthProvider } from './stacks/auth-stack';
import { ApiStack } from './stacks/api-stack';
import { DistributionStack } from './stacks/distribution-stack';

const app = new cdk.App();

// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';

// Configuration from context
const hostedZoneId = app.node.tryGetContext('hostedZoneId') || 'example.com';
const hostedZoneName = app.node.tryGetContext('hostedZoneName') || 'example.com';
const certificateDomain = app.node.tryGetContext('certificateDomain') || '*.oc.example.com';
const apiDomain = app.node.tryGetContext('apiDomain') || 'oc.example.com';
const webDomain = app.node.tryGetContext('webDomain') || 'downloads.oc.example.com';

// Auth provider selection: 'cognito' (default) or 'external'
const authProvider = (app.node.tryGetContext('authProvider') || 'cognito') as AuthProvider;

// Common stack props
const stackProps = {
  environment,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  tags: {
    Environment: environment,
    Project: 'opencode',
  },
};

// ============================================
// Phase 1: Foundation
// ============================================

// Network stack - VPC, subnets, NAT Gateway
// Exports to SSM: /opencode/{env}/network/*
const networkStack = new NetworkStack(app, `OpenCodeNetwork-${environment}`, {
  ...stackProps,
});

// Shared certificate stack - ACM certificate for all ALBs
// Exports to SSM: /opencode/{env}/shared/certificate-arn
const certificateStack = new SharedCertificateStack(app, `OpenCodeCertificate-${environment}`, {
  ...stackProps,
  hostedZoneId,
  hostedZoneName,
  domainName: certificateDomain,
});

// ============================================
// Phase 2: Authentication
// ============================================

// Auth stack - Provider-agnostic authentication
// Cognito mode: creates user pool, domain, app clients, optional OIDC IdP federation
// External mode: writes pre-configured OIDC endpoint URLs to SSM
// Exports to SSM: /opencode/{env}/oidc/*
const authStack = new AuthStack(app, `OpenCodeAuth-${environment}`, {
  ...stackProps,
  provider: authProvider,

  // Cognito mode props
  cognitoDomainPrefix: `opencode-${environment}`,
  appDomainName: apiDomain,
  idpName: app.node.tryGetContext('idpName') || undefined,
  idpIssuer: app.node.tryGetContext('idpIssuer') || undefined,
  idpClientId: process.env.IDP_CLIENT_ID || undefined,
  idpClientSecret: process.env.IDP_CLIENT_SECRET || undefined,

  // External mode props
  oidcIssuer: app.node.tryGetContext('oidcIssuer') || undefined,
  oidcAuthorizationEndpoint: app.node.tryGetContext('oidcAuthorizationEndpoint') || undefined,
  oidcTokenEndpoint: app.node.tryGetContext('oidcTokenEndpoint') || undefined,
  oidcUserInfoEndpoint: app.node.tryGetContext('oidcUserInfoEndpoint') || undefined,
  oidcJwksUrl: app.node.tryGetContext('oidcJwksUrl') || undefined,
  oidcAlbClientId: app.node.tryGetContext('oidcAlbClientId') || undefined,
  oidcCliClientId: app.node.tryGetContext('oidcCliClientId') || undefined,
});

// ============================================
// Phase 3: API Stack (Merged)
// ============================================

// API Stack - Combines TargetGroup, JWT ALB, and Router ECS service
// Creates all components in one stack to avoid circular dependencies:
// - Target group for ECS service
// - JWT ALB with HTTPS listener
// - ECS Fargate service with Bedrock proxy
// - Listener rules (health check and JWT validation)
// Exports to SSM: /opencode/{env}/target-group/*, /alb/jwt/*, /ecs/*
const apiStack = new ApiStack(app, `OpenCodeApi-${environment}`, {
  ...stackProps,
  hostedZoneId,
  hostedZoneName,
  domainName: apiDomain,
});

// ============================================
// Phase 4: Distribution
// ============================================

// Distribution stack - Landing page for downloads with OIDC ALB
// Creates Lambda function, S3 bucket, and OIDC ALB for browser authentication
// Exports to SSM: /opencode/{env}/distribution/*, /alb/oidc/*
const distributionStack = new DistributionStack(app, `OpenCodeDistribution-${environment}`, {
  ...stackProps,
  hostedZoneId,
  hostedZoneName,
  apiDomain,
  webDomain,
});

// cdk-nag: AWS Solutions checks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Note: No addDependency() calls between stacks!
// All cross-stack references use SSM Parameter Store.
//
// Deployment Order:
// 1. NetworkStack (creates VPC, exports to SSM)
// 2. CertificateStack (creates ACM cert, exports to SSM)
// 3. AuthStack (creates OIDC config, exports to SSM)
// 4. ApiStack (creates ALB, target group, ECS service, and listener rules)
// 5. DistributionStack (creates Lambda + S3 + OIDC ALB for web traffic)
//
// This allows independent updates and easier troubleshooting.
// Stacks can be deployed individually as long as their SSM dependencies exist.

app.synth();
