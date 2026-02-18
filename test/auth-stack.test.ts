import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AuthStack } from '../src/stacks/auth-stack';

const testEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

describe('AuthStack — Cognito mode', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AuthStack(app, 'TestAuthCognito', {
      environment: 'test',
      provider: 'cognito',
      cognitoDomainPrefix: 'opencode-test',
      appDomainName: 'oc.example.com',
      env: testEnv,
    });
    template = Template.fromStack(stack);
  });

  test('creates a Cognito User Pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('creates a Cognito User Pool Domain', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  test('creates two User Pool Clients (ALB + CLI)', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  });

  test('User Pool has self-sign-up disabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
    });
  });

  test('User Pool has correct password policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
  });

  test('creates 9 SSM parameters (7 OIDC + 2 Cognito-specific)', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 9);
  });

  test('exports Cognito-specific SSM parameters', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/cognito/user-pool-id',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/cognito/user-pool-arn',
    });
  });

  test('exports OIDC SSM parameters', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/issuer',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/jwks-url',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/authorization-endpoint',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/token-endpoint',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/userinfo-endpoint',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/alb-client-id',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/cli-client-id',
    });
  });
});

describe('AuthStack — Cognito mode with IdP federation', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AuthStack(app, 'TestAuthCognitoIdp', {
      environment: 'test',
      provider: 'cognito',
      cognitoDomainPrefix: 'opencode-test',
      appDomainName: 'oc.example.com',
      idpName: 'Okta',
      idpIssuer: 'https://dev-example.okta.com/oauth2/default',
      idpClientId: 'test-client-id',
      idpClientSecret: 'test-client-secret',
      env: testEnv,
    });
    template = Template.fromStack(stack);
  });

  test('creates a User Pool Identity Provider', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 1);
  });

  test('creates User Pool and clients alongside IdP', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  });
});

describe('AuthStack — External mode', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AuthStack(app, 'TestAuthExternal', {
      environment: 'test',
      provider: 'external',
      oidcIssuer: 'https://auth.example.com',
      oidcAlbClientId: 'alb-client-id',
      oidcCliClientId: 'cli-client-id',
      env: testEnv,
    });
    template = Template.fromStack(stack);
  });

  test('does not create any Cognito resources', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  });

  test('creates 7 OIDC SSM parameters only', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 7);
  });

  test('exports OIDC SSM parameters', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/issuer',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/alb-client-id',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/opencode/test/oidc/cli-client-id',
    });
  });
});

describe('AuthStack — Error cases', () => {
  test('external mode throws when oidcIssuer is missing', () => {
    expect(() => {
      const app = new cdk.App();
      new AuthStack(app, 'TestAuthExternalErr', {
        environment: 'test',
        provider: 'external',
        oidcAlbClientId: 'alb-client-id',
        oidcCliClientId: 'cli-client-id',
        env: testEnv,
      });
    }).toThrow('oidcIssuer is required for external provider');
  });

  test('cognito mode throws when cognitoDomainPrefix is missing', () => {
    expect(() => {
      const app = new cdk.App();
      new AuthStack(app, 'TestAuthCognitoErr', {
        environment: 'test',
        provider: 'cognito',
        appDomainName: 'oc.example.com',
        env: testEnv,
      });
    }).toThrow('cognitoDomainPrefix and appDomainName are required for cognito provider');
  });
});
