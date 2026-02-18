import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface DistributionStackProps extends cdk.StackProps {
  environment: string;
  hostedZoneId: string;
  hostedZoneName: string;
  apiDomain: string;
  webDomain: string;
}

export class DistributionStack extends cdk.Stack {
  public readonly landingPageLambda: lambda.Function;
  public readonly assetsBucket: s3.Bucket;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: DistributionStackProps) {
    super(scope, id, props);

    // Read VPC and subnet information from SSM
    const vpcId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/vpc-id`
    );

    const publicSubnetIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/public-subnet-ids`
    );

    // Read public route table IDs from SSM
    const publicRouteTableIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/public-route-table-ids`
    );

    // Lookup VPC
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
      vpcId: vpcId,
    });

    // Parse public subnet IDs and route table IDs
    const publicSubnetIds = publicSubnetIdsParam.split(',').map((s: string) => s.trim());
    const publicRouteTableIds = publicRouteTableIdsParam.split(',').map((s: string) => s.trim());
    const publicSubnets = publicSubnetIds.map((subnetId: string, index: number) =>
      ec2.Subnet.fromSubnetAttributes(this, `PublicSubnet${index}`, {
        subnetId: subnetId,
        routeTableId: publicRouteTableIds[index],
      })
    );

    // Read certificate ARN from SSM
    const certificateArn = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/shared/certificate-arn`
    );

    // Read OIDC configuration from SSM
    const oidcIssuer = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/issuer`
    );

    const oidcAlbClientId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/alb-client-id`
    );

    const oidcCliClientId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/oidc/cli-client-id`
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

    // Lookup Route 53 hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    // ============================================
    // S3 Bucket for Assets (from original DistributionStack)
    // ============================================
    // Server access logging bucket
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `opencode-dist-logs-${props.environment}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) },
      ],
    });

    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `opencode-distribution-${props.environment}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'assets-logs/',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    new ssm.StringParameter(this, 'AssetsBucketNameParam', {
      parameterName: `/opencode/${props.environment}/distribution/assets-bucket-name`,
      stringValue: this.assetsBucket.bucketName,
      description: 'Distribution Assets Bucket Name',
    });

    // ============================================
    // Landing Page Lambda (from original DistributionStack)
    // ============================================
    const lambdaRole = new iam.Role(this, 'LandingPageLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    this.assetsBucket.grantRead(lambdaRole);

    // ============================================
    // Landing Page Lambda
    // ============================================
    this.landingPageLambda = new lambda.Function(this, 'LandingPageLambda', {
      functionName: `opencode-landing-page-${props.environment}`,
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 10,
      role: lambdaRole,
      environment: {
        ASSETS_BUCKET: this.assetsBucket.bucketName,
        API_DOMAIN: props.apiDomain,
        WEB_DOMAIN: props.webDomain,
        OIDC_CLI_CLIENT_ID: oidcCliClientId,
        OIDC_ISSUER: oidcIssuer,
        ENVIRONMENT: props.environment,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'services', 'distribution', 'lambda')),
    });

    new ssm.StringParameter(this, 'LandingPageLambdaArnParam', {
      parameterName: `/opencode/${props.environment}/distribution/landing-page-lambda-arn`,
      stringValue: this.landingPageLambda.functionArn,
      description: 'Landing Page Lambda ARN',
    });

    // ============================================
    // OIDC ALB (merged from OidcAlbStack)
    // ============================================
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: vpc,
      description: 'Security group for OIDC ALB',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere'
    );

    new ssm.StringParameter(this, 'AlbSecurityGroupIdParam', {
      parameterName: `/opencode/${props.environment}/alb/oidc/security-group-id`,
      stringValue: albSecurityGroup.securityGroupId,
    });

    // ALB access logs bucket
    const albAccessLogsBucket = new s3.Bucket(this, 'AlbAccessLogsBucket', {
      bucketName: `opencode-oidc-alb-logs-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'OidcAlb', {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: `opencode-oidc-${props.environment}`,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnets: publicSubnets,
      },
      http2Enabled: true,
      preserveHostHeader: true,
      dropInvalidHeaderFields: true,
    });

    this.alb.logAccessLogs(albAccessLogsBucket, 'oidc-alb');

    new ssm.StringParameter(this, 'AlbArnParam', {
      parameterName: `/opencode/${props.environment}/alb/oidc/arn`,
      stringValue: this.alb.loadBalancerArn,
    });

    new ssm.StringParameter(this, 'AlbDnsNameParam', {
      parameterName: `/opencode/${props.environment}/alb/oidc/dns-name`,
      stringValue: this.alb.loadBalancerDnsName,
    });

    // DNS Record
    new route53.ARecord(this, 'WebDnsRecord', {
      zone: hostedZone,
      recordName: props.webDomain,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(this.alb)
      ),
    });

    new ssm.StringParameter(this, 'WebDnsNameParam', {
      parameterName: `/opencode/${props.environment}/web/dns-name`,
      stringValue: props.webDomain,
    });

    // Lambda target group for distribution service
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'DistributionTargetGroup', {
      vpc: vpc,
      targetType: elbv2.TargetType.LAMBDA,
    });

    // Add Lambda as target
    targetGroup.addTarget(new elbv2_targets.LambdaTarget(this.landingPageLambda));

    // Grant ALB permission to invoke Lambda
    this.landingPageLambda.addPermission('AlbInvokePermission', {
      principal: new iam.ServicePrincipal('elasticloadbalancing.amazonaws.com'),
      sourceArn: this.alb.loadBalancerArn,
    });

    new ssm.StringParameter(this, 'TargetGroupArnParam', {
      parameterName: `/opencode/${props.environment}/alb/oidc/target-group-arn`,
      stringValue: targetGroup.targetGroupArn,
    });

    // OIDC ALB client secret is stored in Secrets Manager.
    // For Cognito mode, `deploy.sh auth` creates this automatically via ensure_alb_client_secret().
    // For external OIDC providers, `setup.sh` or `setup-oidc-provider.sh` handles creation.
    // CloudFormation dynamic reference keeps the secret out of the template.
    const secretName = `opencode/${props.environment}/oidc-alb-client-secret`;
    const clientSecret = cdk.Fn.sub('{{resolve:secretsmanager:' + secretName + ':SecretString}}');

    // HTTPS Listener with OIDC authentication
    const httpsListener = new elbv2.CfnListener(this, 'HttpsListener', {
      loadBalancerArn: this.alb.loadBalancerArn,
      port: 443,
      protocol: 'HTTPS',
      sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      certificates: [
        {
          certificateArn: certificateArn,
        },
      ],
      defaultActions: [
        {
          type: 'fixed-response',
          fixedResponseConfig: {
            statusCode: '404',
            contentType: 'text/plain',
            messageBody: 'Not Found',
          },
        },
      ],
    });

    new ssm.StringParameter(this, 'ListenerArnParam', {
      parameterName: `/opencode/${props.environment}/alb/oidc/listener-arn`,
      stringValue: httpsListener.ref,
    });

    // OIDC Authentication rule
    new elbv2.CfnListenerRule(this, 'OidcAuthRule', {
      listenerArn: httpsListener.ref,
      priority: 10,
      conditions: [
        {
          field: 'host-header',
          hostHeaderConfig: {
            values: [props.webDomain],
          },
        },
      ],
      actions: [
        {
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
        },
        {
          type: 'forward',
          order: 2,
          targetGroupArn: targetGroup.targetGroupArn,
        },
      ],
    });

    // HTTP Listener (redirect to HTTPS)
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    // ============================================
    // cdk-nag suppressions
    // ============================================
    NagSuppressions.addResourceSuppressions(lambdaRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs access',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'S3 read wildcards (s3:GetBucket*, s3:GetObject*, s3:List*) generated by CDK grantRead() for assets bucket access',
        appliesTo: [
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          `Resource::<AssetsBucket5CB76180.Arn>/*`,
        ],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(albSecurityGroup, [
      {
        id: 'AwsSolutions-EC23',
        reason: 'Internet-facing ALB requires 0.0.0.0/0 ingress on port 443 (HTTPS) for public web access',
      },
    ]);

    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the S3 access logs bucket itself — enabling access logs on the log bucket would create infinite recursion',
      },
    ]);

    NagSuppressions.addResourceSuppressions(albAccessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the ALB access logs bucket itself — enabling access logs on the log bucket would create infinite recursion',
      },
    ]);


    // ============================================
    // Outputs
    // ============================================
    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: this.assetsBucket.bucketName,
      description: 'Assets Bucket Name',
    });

    new cdk.CfnOutput(this, 'LandingPageLambdaArn', {
      value: this.landingPageLambda.functionArn,
      description: 'Landing Page Lambda ARN',
    });

    new cdk.CfnOutput(this, 'ConfigEndpoint', {
      value: `https://${props.webDomain}/config.json`,
      description: 'Config JSON Endpoint',
    });

    new cdk.CfnOutput(this, 'InstallScriptUrl', {
      value: `https://${props.webDomain}/install.sh`,
      description: 'Install Script URL',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'OIDC ALB DNS Name',
    });

    new cdk.CfnOutput(this, 'WebDomainName', {
      value: props.webDomain,
      description: 'Web Domain Name',
    });

    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: targetGroup.targetGroupArn,
      description: 'Target Group ARN',
    });
  }
}
