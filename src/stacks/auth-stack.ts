import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export type AuthProvider = 'cognito' | 'external';

export interface AuthStackProps extends cdk.StackProps {
  environment: string;
  provider: AuthProvider;

  // Cognito mode props
  cognitoDomainPrefix?: string;
  appDomainName?: string;
  idpName?: string;
  idpIssuer?: string;
  idpClientId?: string;
  idpClientSecret?: string;

  // External mode props — pre-configured OIDC provider
  oidcIssuer?: string;
  oidcAuthorizationEndpoint?: string;
  oidcTokenEndpoint?: string;
  oidcUserInfoEndpoint?: string;
  oidcJwksUrl?: string;
  oidcAlbClientId?: string;
  oidcCliClientId?: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool?: cognito.UserPool;
  public readonly albClient?: cognito.CfnUserPoolClient;
  public readonly cliClient?: cognito.CfnUserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    if (props.provider === 'cognito') {
      this.createCognitoResources(props);
    } else {
      this.createExternalResources(props);
    }
  }

  private createCognitoResources(props: AuthStackProps) {
    if (!props.cognitoDomainPrefix || !props.appDomainName) {
      throw new Error('cognitoDomainPrefix and appDomainName are required for cognito provider');
    }

    // Cognito User Pool
    (this as any).userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `opencode-${props.environment}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: props.environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const userPool = (this as any).userPool as cognito.UserPool;

    // Cognito Domain
    new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
    });

    const cognitoDomain = `${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;

    // OIDC endpoints derived from Cognito
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    const jwksUrl = `${issuer}/.well-known/jwks.json`;
    const authorizationEndpoint = `https://${cognitoDomain}/oauth2/authorize`;
    const tokenEndpoint = `https://${cognitoDomain}/oauth2/token`;
    const userInfoEndpoint = `https://${cognitoDomain}/oauth2/userInfo`;

    // Callback URLs
    const callbackUrls = [
      `https://${props.appDomainName}/oauth2/idpresponse`,
      `https://downloads.${props.appDomainName}/oauth2/idpresponse`,
      'http://localhost:8080/callback',
      'http://127.0.0.1:8080/callback',
      'http://localhost:19876/callback',
      'http://127.0.0.1:19876/callback',
    ];

    const logoutUrls = [
      `https://${props.appDomainName}/`,
      `https://downloads.${props.appDomainName}/`,
    ];

    // Identity Provider (fully configurable — no defaults)
    let identityProvider: cognito.CfnUserPoolIdentityProvider | undefined;
    if (props.idpClientId || props.idpClientSecret) {
      if (!props.idpName || !props.idpIssuer) {
        throw new Error(
          'idpName and idpIssuer are required when idpClientId/idpClientSecret are provided. ' +
          'Example: -c idpName=Okta -c idpIssuer=https://your-org.okta.com/oauth2/default'
        );
      }
      if (!props.idpClientId || !props.idpClientSecret) {
        throw new Error(
          'Both idpClientId and idpClientSecret are required for IdP federation. ' +
          'Provide both or neither.'
        );
      }
    }

    const idpName = props.idpName;
    const idpIssuer = props.idpIssuer;

    if (props.idpClientId && props.idpClientSecret && idpName && idpIssuer) {
      identityProvider = new cognito.CfnUserPoolIdentityProvider(this, 'OidcProvider', {
        userPoolId: userPool.userPoolId,
        providerName: idpName,
        providerType: 'OIDC',
        providerDetails: {
          client_id: props.idpClientId,
          client_secret: props.idpClientSecret,
          oidc_issuer: idpIssuer,
          authorize_scopes: 'openid email profile',
          attributes_request_method: 'GET',
        },
        attributeMapping: {
          email: 'email',
          email_verified: 'email_verified',
          given_name: 'given_name',
          family_name: 'family_name',
          username: 'sub',
        },
      });
    }

    const supportedProviders = identityProvider && idpName ? [idpName] : ['COGNITO'];

    // ALB Client (with secret for ALB OIDC auth)
    const albClient = new cognito.CfnUserPoolClient(this, 'AlbClient', {
      userPoolId: userPool.userPoolId,
      clientName: `opencode-alb-${props.environment}`,
      generateSecret: true,
      allowedOAuthFlows: ['code'],
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      callbackUrLs: callbackUrls,
      logoutUrLs: logoutUrls,
      accessTokenValidity: 1,
      idTokenValidity: 1,
      refreshTokenValidity: 12,
      tokenValidityUnits: {
        accessToken: 'hours',
        idToken: 'hours',
        refreshToken: 'hours',
      },
      supportedIdentityProviders: supportedProviders,
      preventUserExistenceErrors: 'ENABLED',
      enableTokenRevocation: true,
    });
    (this as any).albClient = albClient;

    if (identityProvider) {
      albClient.node.addDependency(identityProvider);
    }

    // CLI Client (public client for PKCE)
    const cliClient = new cognito.CfnUserPoolClient(this, 'CliClient', {
      userPoolId: userPool.userPoolId,
      clientName: `opencode-cli-${props.environment}`,
      generateSecret: false,
      allowedOAuthFlows: ['code'],
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      callbackUrLs: [
        'http://localhost:8080/callback',
        'http://127.0.0.1:8080/callback',
        'http://localhost:19876/callback',
        'http://127.0.0.1:19876/callback',
      ],
      accessTokenValidity: 1,
      idTokenValidity: 1,
      refreshTokenValidity: 12,
      tokenValidityUnits: {
        accessToken: 'hours',
        idToken: 'hours',
        refreshToken: 'hours',
      },
      supportedIdentityProviders: supportedProviders,
      preventUserExistenceErrors: 'ENABLED',
      enableTokenRevocation: true,
    });
    (this as any).cliClient = cliClient;

    if (identityProvider) {
      cliClient.node.addDependency(identityProvider);
    }

    // Write unified OIDC SSM parameters
    this.writeOidcParams(props.environment, {
      issuer,
      jwksUrl,
      authorizationEndpoint,
      tokenEndpoint,
      userInfoEndpoint,
      albClientId: albClient.ref,
      cliClientId: cliClient.ref,
    });

    // cdk-nag suppressions
    NagSuppressions.addResourceSuppressions(userPool, [
      {
        id: 'AwsSolutions-COG2',
        reason: 'MFA is not required — users authenticate via federated IdP (Okta/OIDC) which enforces its own MFA policy',
      },
    ]);

    // Additional Cognito-specific SSM params (for Cognito-specific operations)
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `/opencode/${props.environment}/cognito/user-pool-id`,
      stringValue: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new ssm.StringParameter(this, 'UserPoolArnParam', {
      parameterName: `/opencode/${props.environment}/cognito/user-pool-arn`,
      stringValue: userPool.userPoolArn,
      description: 'Cognito User Pool ARN',
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'AlbClientId', {
      value: albClient.ref,
      description: 'ALB Client ID',
    });

    new cdk.CfnOutput(this, 'CliClientId', {
      value: cliClient.ref,
      description: 'CLI Client ID',
    });

    new cdk.CfnOutput(this, 'OidcIssuer', {
      value: issuer,
      description: 'OIDC Issuer URL',
    });

    new cdk.CfnOutput(this, 'JwksUrl', {
      value: jwksUrl,
      description: 'JWKS URL for JWT validation',
    });

    new cdk.CfnOutput(this, 'AlbClientSecretCommand', {
      value: `aws cognito-idp describe-user-pool-client --user-pool-id ${userPool.userPoolId} --client-id ${albClient.ref} --query 'UserPoolClient.ClientSecret' --output text`,
      description: 'Command to retrieve ALB client secret',
    });
  }

  private createExternalResources(props: AuthStackProps) {
    if (!props.oidcIssuer) {
      throw new Error('oidcIssuer is required for external provider');
    }
    if (!props.oidcAlbClientId || !props.oidcCliClientId) {
      throw new Error('oidcAlbClientId and oidcCliClientId are required for external provider');
    }

    // For external providers, derive endpoints from issuer if not provided
    const issuer = props.oidcIssuer;
    const authorizationEndpoint = props.oidcAuthorizationEndpoint || `${issuer}/authorize`;
    const tokenEndpoint = props.oidcTokenEndpoint || `${issuer}/oauth/token`;
    const userInfoEndpoint = props.oidcUserInfoEndpoint || `${issuer}/userinfo`;
    const jwksUrl = props.oidcJwksUrl || `${issuer}/.well-known/jwks.json`;

    // Write unified OIDC SSM parameters
    this.writeOidcParams(props.environment, {
      issuer,
      jwksUrl,
      authorizationEndpoint,
      tokenEndpoint,
      userInfoEndpoint,
      albClientId: props.oidcAlbClientId,
      cliClientId: props.oidcCliClientId,
    });

    // Outputs
    new cdk.CfnOutput(this, 'OidcIssuer', {
      value: issuer,
      description: 'OIDC Issuer URL',
    });

    new cdk.CfnOutput(this, 'AlbClientId', {
      value: props.oidcAlbClientId,
      description: 'ALB Client ID',
    });

    new cdk.CfnOutput(this, 'CliClientId', {
      value: props.oidcCliClientId,
      description: 'CLI Client ID',
    });
  }

  private writeOidcParams(environment: string, params: {
    issuer: string;
    jwksUrl: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
    albClientId: string;
    cliClientId: string;
  }) {
    new ssm.StringParameter(this, 'OidcIssuerParam', {
      parameterName: `/opencode/${environment}/oidc/issuer`,
      stringValue: params.issuer,
      description: 'OIDC Issuer URL',
    });

    new ssm.StringParameter(this, 'OidcJwksUrlParam', {
      parameterName: `/opencode/${environment}/oidc/jwks-url`,
      stringValue: params.jwksUrl,
      description: 'OIDC JWKS URL',
    });

    new ssm.StringParameter(this, 'OidcAuthorizationEndpointParam', {
      parameterName: `/opencode/${environment}/oidc/authorization-endpoint`,
      stringValue: params.authorizationEndpoint,
      description: 'OIDC Authorization Endpoint',
    });

    new ssm.StringParameter(this, 'OidcTokenEndpointParam', {
      parameterName: `/opencode/${environment}/oidc/token-endpoint`,
      stringValue: params.tokenEndpoint,
      description: 'OIDC Token Endpoint',
    });

    new ssm.StringParameter(this, 'OidcUserInfoEndpointParam', {
      parameterName: `/opencode/${environment}/oidc/userinfo-endpoint`,
      stringValue: params.userInfoEndpoint,
      description: 'OIDC UserInfo Endpoint',
    });

    new ssm.StringParameter(this, 'OidcAlbClientIdParam', {
      parameterName: `/opencode/${environment}/oidc/alb-client-id`,
      stringValue: params.albClientId,
      description: 'OIDC ALB Client ID',
    });

    new ssm.StringParameter(this, 'OidcCliClientIdParam', {
      parameterName: `/opencode/${environment}/oidc/cli-client-id`,
      stringValue: params.cliClientId,
      description: 'OIDC CLI Client ID',
    });
  }
}
