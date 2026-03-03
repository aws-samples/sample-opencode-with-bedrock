import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ShareStackProps extends cdk.StackProps {
  environment: string;
  shareDomain: string;     // e.g., share.oc.3pmod.dev
  hostedZoneId: string;
  hostedZoneName: string;
}

export class ShareStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ShareStackProps) {
    super(scope, id, props);

    // ================================================================
    // Read SSM parameters from other stacks
    // ================================================================
    const oidcJwksUrl = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/jwks-url`
    );
    const oidcIssuer = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/issuer`
    );
    const oidcCliClientId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/cli-client-id`
    );

    // OIDC endpoints for browser auth (authenticate-oidc ALB action)
    const oidcAlbClientId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/alb-client-id`
    );
    const oidcAuthorizationEndpoint = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/authorization-endpoint`
    );
    const oidcTokenEndpoint = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/token-endpoint`
    );
    const oidcUserInfoEndpoint = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/userinfo-endpoint`
    );

    // Client secret for OIDC ALB (stored in Secrets Manager)
    const clientSecret = cdk.SecretValue.secretsManager(
      `opencode/${props.environment}/oidc-alb-client-secret`
    ).unsafeUnwrap();

    // VPC / subnet references
    const vpcId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/vpc-id`
    );
    const publicSubnetIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/public-subnet-ids`
    );
    const publicRouteTableIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/public-route-table-ids`
    );

    // Shared certificate (*.oc.3pmod.dev — covers share.oc.3pmod.dev)
    const certificateArn = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/shared/certificate-arn`
    );

    // VPC lookup
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });
    const publicSubnetIds = publicSubnetIdsParam.split(',').map((s: string) => s.trim());
    const publicRouteTableIds = publicRouteTableIdsParam.split(',').map((s: string) => s.trim());
    const publicSubnets = publicSubnetIds.map((subnetId: string, index: number) =>
      ec2.Subnet.fromSubnetAttributes(this, `PublicSubnet${index}`, {
        subnetId,
        routeTableId: publicRouteTableIds[index],
      })
    );

    // Hosted zone for DNS
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    // ================================================================
    // S3 Bucket — Share Event Store
    // ================================================================
    const shareBucket = new s3.Bucket(this, 'ShareDataBucket', {
      bucketName: `opencode-share-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.environment !== 'prod',
      lifecycleRules: [
        {
          id: 'expire-old-versions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'expire-old-events',
          prefix: 'share_event/',
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // ================================================================
    // DynamoDB Table — WebSocket Connections
    // ================================================================
    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: `opencode-share-connections-${props.environment}`,
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: props.environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'ShareIdIndex',
      partitionKey: { name: 'shareId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ================================================================
    // WebSocket API Gateway
    // ================================================================
    const wsApi = new apigatewayv2.CfnApi(this, 'ShareWebSocketApi', {
      name: `opencode-share-ws-${props.environment}`,
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    const wsLogGroup = new logs.LogGroup(this, 'WebSocketLogGroup', {
      logGroupName: `/aws/apigateway/opencode-share-ws-${props.environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const wsStage = new apigatewayv2.CfnStage(this, 'WebSocketStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: 1000,
        throttlingRateLimit: 500,
      },
      accessLogSettings: {
        destinationArn: wsLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          routeKey: '$context.routeKey',
          status: '$context.status',
        }),
      },
    });

    // ================================================================
    // IAM Role — WebSocket Lambdas (shared)
    // ================================================================
    const wsLambdaRole = new iam.Role(this, 'WebSocketLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // DynamoDB access — scoped to connections table only (no Scan)
    wsLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      resources: [
        connectionsTable.tableArn,
        `${connectionsTable.tableArn}/index/*`,
      ],
    }));

    // API Gateway management — scoped to this WebSocket API
    wsLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'execute-api:ManageConnections',
      ],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
      ],
    }));

    const wsEndpoint = `${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`;

    // ================================================================
    // WebSocket Lambda Functions
    // ================================================================
    const connectLambda = new lambda.Function(this, 'ConnectLambda', {
      functionName: `opencode-share-ws-connect-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/connect.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'services', 'share', 'websocket')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      role: wsLambdaRole,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
    });

    const disconnectLambda = new lambda.Function(this, 'DisconnectLambda', {
      functionName: `opencode-share-ws-disconnect-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/disconnect.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'services', 'share', 'websocket')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      role: wsLambdaRole,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
    });

    const defaultLambda = new lambda.Function(this, 'DefaultLambda', {
      functionName: `opencode-share-ws-default-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/default.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'services', 'share', 'websocket')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      role: wsLambdaRole,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        API_GATEWAY_ENDPOINT: wsEndpoint,
      },
    });

    const broadcastLambda = new lambda.Function(this, 'BroadcastLambda', {
      functionName: `opencode-share-ws-broadcast-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/broadcast.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'services', 'share', 'websocket')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      role: wsLambdaRole,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        API_GATEWAY_ENDPOINT: wsEndpoint,
      },
    });

    // ================================================================
    // WebSocket API Integrations & Routes
    // ================================================================
    const connectIntegration = new apigatewayv2.CfnIntegration(this, 'ConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${connectLambda.functionArn}/invocations`,
      integrationMethod: 'POST',
    });

    const disconnectIntegration = new apigatewayv2.CfnIntegration(this, 'DisconnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${disconnectLambda.functionArn}/invocations`,
      integrationMethod: 'POST',
    });

    const defaultIntegration = new apigatewayv2.CfnIntegration(this, 'DefaultIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${defaultLambda.functionArn}/invocations`,
      integrationMethod: 'POST',
    });

    // Routes
    const connectRoute = new apigatewayv2.CfnRoute(this, 'ConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    const disconnectRoute = new apigatewayv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    const defaultRoute = new apigatewayv2.CfnRoute(this, 'DefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${defaultIntegration.ref}`,
    });

    // Lambda permissions for API Gateway
    connectLambda.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
    });
    disconnectLambda.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
    });
    defaultLambda.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
    });

    // ================================================================
    // Share API Lambda
    // ================================================================
    const shareApiRole = new iam.Role(this, 'ShareApiLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // S3 access — scoped to share bucket only
    shareApiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
      ],
      resources: [
        shareBucket.bucketArn,
        `${shareBucket.bucketArn}/*`,
      ],
    }));

    // Lambda invoke — scoped to broadcast Lambda only
    shareApiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [broadcastLambda.functionArn],
    }));

    const shareApiLogGroup = new logs.LogGroup(this, 'ShareApiLogGroup', {
      logGroupName: `/aws/lambda/opencode-share-api-${props.environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const shareApiLambda = new lambda.Function(this, 'ShareApiLambda', {
      functionName: `opencode-share-api-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'services', 'share', 'lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      role: shareApiRole,
      logGroup: shareApiLogGroup,
      environment: {
        OPENCODE_STORAGE_BUCKET: shareBucket.bucketName,
        OPENCODE_STORAGE_REGION: this.region,
        BROADCAST_LAMBDA_ARN: broadcastLambda.functionArn,
        API_GATEWAY_URL: `https://${props.shareDomain}`,
        SHARE_VIEWER_BASE_URL: `https://${props.shareDomain}`,
        CORS_ALLOWED_ORIGIN: `https://${props.shareDomain}`,
        NODE_ENV: 'production',
      },
    });

    // ================================================================
    // Dedicated Share ALB — share.oc.3pmod.dev
    // ================================================================

    // Security group
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: vpc,
      description: 'Security group for Share ALB',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere'
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP for redirect'
    );

    // Access logs bucket
    const albAccessLogsBucket = new s3.Bucket(this, 'AlbAccessLogsBucket', {
      bucketName: `opencode-share-alb-logs-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ShareAlb', {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: `opencode-share-${props.environment}`,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnets: publicSubnets,
      },
      http2Enabled: true,
      dropInvalidHeaderFields: true,
    });
    // Note: ALB→Lambda has a hard 1MB payload limit (request + response).
    // The share plugin chunks sync data to stay under this limit.

    alb.logAccessLogs(albAccessLogsBucket, 'share-alb');

    // Route53 DNS — share.oc.3pmod.dev -> ALB
    new route53.ARecord(this, 'ShareDnsRecord', {
      zone: hostedZone,
      recordName: props.shareDomain,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(alb)
      ),
    });

    // HTTPS listener with default 404
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [{
        certificateArn: certificateArn,
      }],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // HTTP-to-HTTPS redirect
    alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    // ================================================================
    // ALB Target Groups & Listener Rules
    // ================================================================
    const shareApiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ShareApiTargetGroup', {
      targetType: elbv2.TargetType.LAMBDA,
    });
    shareApiTargetGroup.addTarget(new elbv2_targets.LambdaTarget(shareApiLambda));

    // Rule 1: Share API routes with JWT validation (Priority 1)
    // POST /api/share, POST /api/share/*/sync, GET /api/share/*/data, DELETE /api/share/*
    new elbv2.CfnListenerRule(this, 'ShareApiWriteRule', {
      listenerArn: httpsListener.listenerArn,
      priority: 1,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/api/share', '/api/share/*'],
          },
        },
        {
          field: 'http-header',
          httpHeaderConfig: {
            httpHeaderName: 'Authorization',
            values: ['Bearer*'],
          },
        },
      ],
      actions: [
        {
          type: 'jwt-validation',
          order: 1,
          jwtValidationConfig: {
            jwksEndpoint: oidcJwksUrl,
            issuer: oidcIssuer,
            additionalClaims: [
              {
                name: 'aud',
                values: [oidcCliClientId],
                format: 'single-string',
              },
            ],
          },
        },
        {
          type: 'forward',
          order: 2,
          targetGroupArn: shareApiTargetGroup.targetGroupArn,
        },
      ],
    });

    // Rule 2: Share API routes via API key passthrough (Priority 2)
    new elbv2.CfnListenerRule(this, 'ShareApiKeyRule', {
      listenerArn: httpsListener.listenerArn,
      priority: 2,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/api/share', '/api/share/*'],
          },
        },
        {
          field: 'http-header',
          httpHeaderConfig: {
            httpHeaderName: 'X-API-Key',
            values: ['oc_*'],
          },
        },
      ],
      actions: [
        {
          type: 'forward',
          targetGroupArn: shareApiTargetGroup.targetGroupArn,
        },
      ],
    });

    // OIDC auth config (reused by viewer and data rules)
    const oidcAuthAction = {
      type: 'authenticate-oidc',
      order: 1,
      authenticateOidcConfig: {
        issuer: oidcIssuer,
        authorizationEndpoint: oidcAuthorizationEndpoint,
        tokenEndpoint: oidcTokenEndpoint,
        userInfoEndpoint: oidcUserInfoEndpoint,
        clientId: oidcAlbClientId,
        clientSecret: clientSecret,
        sessionCookieName: 'AWSELBAuthSessionCookie',
        sessionTimeout: 43200,
        scope: 'openid email profile',
        onUnauthenticatedRequest: 'authenticate',
      },
    };

    // Rule 3: Share viewer — GET /share/* with OIDC auth (browser redirect)
    new elbv2.CfnListenerRule(this, 'ShareViewerRule', {
      listenerArn: httpsListener.listenerArn,
      priority: 3,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/share/*'],
          },
        },
      ],
      actions: [
        oidcAuthAction,
        {
          type: 'forward',
          order: 2,
          targetGroupArn: shareApiTargetGroup.targetGroupArn,
        },
      ],
    });

    // Rule 4: Share data API — GET /api/share/*/data with OIDC auth (browser cookie)
    // The viewer JavaScript fetches this endpoint; the OIDC session cookie from
    // rule 3 carries over so the user isn't prompted again.
    new elbv2.CfnListenerRule(this, 'ShareDataRule', {
      listenerArn: httpsListener.listenerArn,
      priority: 4,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/api/share/*/data'],
          },
        },
      ],
      actions: [
        oidcAuthAction,
        {
          type: 'forward',
          order: 2,
          targetGroupArn: shareApiTargetGroup.targetGroupArn,
        },
      ],
    });

    // Rule 5: Landing page — GET / with OIDC auth (browser redirect)
    new elbv2.CfnListenerRule(this, 'ShareLandingRule', {
      listenerArn: httpsListener.listenerArn,
      priority: 5,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/'],
          },
        },
      ],
      actions: [
        oidcAuthAction,
        {
          type: 'forward',
          order: 2,
          targetGroupArn: shareApiTargetGroup.targetGroupArn,
        },
      ],
    });

    // ================================================================
    // CloudWatch Alarms
    // ================================================================
    new cloudwatch.Alarm(this, 'ShareApiErrorsAlarm', {
      alarmName: `opencode-share-api-errors-${props.environment}`,
      alarmDescription: 'Share API Lambda errors exceed threshold',
      metric: shareApiLambda.metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      evaluationPeriods: 5,
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    new cloudwatch.Alarm(this, 'ShareApiThrottlesAlarm', {
      alarmName: `opencode-share-api-throttles-${props.environment}`,
      alarmDescription: 'Share API Lambda throttles exceed threshold',
      metric: shareApiLambda.metricThrottles({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      evaluationPeriods: 5,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // ================================================================
    // SSM Parameter Exports
    // ================================================================
    new ssm.StringParameter(this, 'ShareBucketNameParam', {
      parameterName: `/opencode/${props.environment}/share/bucket-name`,
      stringValue: shareBucket.bucketName,
    });

    new ssm.StringParameter(this, 'ShareApiLambdaArnParam', {
      parameterName: `/opencode/${props.environment}/share/api-lambda-arn`,
      stringValue: shareApiLambda.functionArn,
    });

    new ssm.StringParameter(this, 'WebSocketEndpointParam', {
      parameterName: `/opencode/${props.environment}/share/websocket-endpoint`,
      stringValue: `wss://${wsEndpoint}`,
    });

    new ssm.StringParameter(this, 'ConnectionsTableParam', {
      parameterName: `/opencode/${props.environment}/share/connections-table`,
      stringValue: connectionsTable.tableName,
    });

    new ssm.StringParameter(this, 'ShareDomainParam', {
      parameterName: `/opencode/${props.environment}/share/domain`,
      stringValue: props.shareDomain,
    });

    new ssm.StringParameter(this, 'AlbArnParam', {
      parameterName: `/opencode/${props.environment}/alb/share/arn`,
      stringValue: alb.loadBalancerArn,
    });

    new ssm.StringParameter(this, 'AlbDnsNameParam', {
      parameterName: `/opencode/${props.environment}/alb/share/dns-name`,
      stringValue: alb.loadBalancerDnsName,
    });

    new ssm.StringParameter(this, 'ListenerArnParam', {
      parameterName: `/opencode/${props.environment}/alb/share/listener-arn`,
      stringValue: httpsListener.listenerArn,
    });

    // ================================================================
    // cdk-nag suppressions
    // ================================================================
    NagSuppressions.addResourceSuppressions(wsLambdaRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs access',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcard required for GSI query access. execute-api /* wildcard required for WebSocket connection management on any route/stage.',
        appliesTo: [
          `Resource::<ConnectionsTable8000B8A1.Arn>/index/*`,
          `Resource::arn:aws:execute-api:${this.region}:${this.account}:<ShareWebSocketApi>/*`,
        ],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(shareApiRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs access',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'S3 bucket/* wildcard required because share data keys are dynamic (share/{id}.json, share_event/{id}/{ulid}.json, etc.)',
        appliesTo: [
          `Resource::<ShareDataBucket1639E917.Arn>/*`,
        ],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(shareBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Share data bucket does not need server access logging — it contains only share event data, not access-sensitive content. Lifecycle rules handle data cleanup.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(albAccessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the ALB access logs bucket itself — enabling access logs on the log bucket would create infinite recursion.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(albSecurityGroup, [
      {
        id: 'AwsSolutions-EC23',
        reason: 'Internet-facing ALB requires 0.0.0.0/0 ingress on ports 80 (redirect) and 443 (HTTPS) to serve public share links.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      [connectLambda, disconnectLambda, defaultLambda, broadcastLambda, shareApiLambda],
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'Node.js 20.x is the current LTS runtime; will upgrade when 22.x LTS is available in Lambda',
        },
      ],
      true
    );

    // Suppress ECS2 for all Lambdas that use environment variables
    NagSuppressions.addResourceSuppressions(
      [connectLambda, disconnectLambda, defaultLambda, broadcastLambda, shareApiLambda],
      [
        {
          id: 'AwsSolutions-ECS2',
          reason: 'Environment variables contain non-sensitive configuration (table names, endpoints, bucket names)',
        },
      ],
      true
    );

    // Suppress APIG4 for WebSocket routes — WebSocket APIs use $connect-level
    // auth (query string tokens, Lambda authorizers) rather than per-route IAM/Cognito.
    // Share links embed the shareId in the WS URL; the connect handler validates it.
    NagSuppressions.addResourceSuppressions(
      [connectRoute, disconnectRoute, defaultRoute],
      [
        {
          id: 'AwsSolutions-APIG4',
          reason: 'WebSocket API routes use application-level authorization in the $connect handler (shareId validation) rather than IAM or Cognito authorizers. The connect Lambda validates the shareId before allowing the connection.',
        },
      ],
    );

    // ================================================================
    // Outputs
    // ================================================================
    new cdk.CfnOutput(this, 'ShareDomain', {
      value: `https://${props.shareDomain}`,
      description: 'Share feature base URL',
    });

    new cdk.CfnOutput(this, 'ShareBucketName', {
      value: shareBucket.bucketName,
      description: 'Share data S3 bucket',
    });

    new cdk.CfnOutput(this, 'WebSocketEndpoint', {
      value: `wss://${wsEndpoint}`,
      description: 'WebSocket endpoint for real-time updates',
    });

    new cdk.CfnOutput(this, 'ShareApiEndpoint', {
      value: `https://${props.shareDomain}/api/share`,
      description: 'Share API endpoint',
    });

    new cdk.CfnOutput(this, 'ShareViewerEndpoint', {
      value: `https://${props.shareDomain}/share`,
      description: 'Share viewer endpoint',
    });
  }
}
