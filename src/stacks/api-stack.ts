import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  environment: string;
  hostedZoneId: string;
  hostedZoneName: string;
  domainName: string;  // e.g., "oc.example.com"
  webDomain?: string;  // e.g., "downloads.oc.example.com" — passed to router as DISTRIBUTION_DOMAIN
}

export class ApiStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly listener: elbv2.ApplicationListener;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Read VPC and subnet information from SSM
    const vpcId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/vpc-id`
    );

    const vpcCidr = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/vpc-cidr`
    );

    const publicSubnetIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/public-subnet-ids`
    );

    const privateSubnetIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/private-subnet-ids`
    );

    // Read route table IDs from SSM
    const publicRouteTableIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/public-route-table-ids`
    );

    const privateRouteTableIdsParam = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/network/private-route-table-ids`
    );

    // Lookup VPC
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
      vpcId: vpcId,
    });

    // Parse subnet IDs and route table IDs
    const publicSubnetIds = publicSubnetIdsParam.split(',').map((s: string) => s.trim());
    const publicRouteTableIds = publicRouteTableIdsParam.split(',').map((s: string) => s.trim());
    const publicSubnets = publicSubnetIds.map((subnetId: string, index: number) =>
      ec2.Subnet.fromSubnetAttributes(this, `PublicSubnet${index}`, {
        subnetId: subnetId,
        routeTableId: publicRouteTableIds[index],
      })
    );

    const privateSubnetIds = privateSubnetIdsParam.split(',').map((s: string) => s.trim());
    const privateRouteTableIds = privateRouteTableIdsParam.split(',').map((s: string) => s.trim());
    const privateSubnets = privateSubnetIds.map((subnetId: string, index: number) =>
      ec2.Subnet.fromSubnetAttributes(this, `PrivateSubnet${index}`, {
        subnetId: subnetId,
        routeTableId: privateRouteTableIds[index],
      })
    );

    // Read certificate ARN from SSM
    const certificateArn = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/shared/certificate-arn`
    );

    // Read OIDC configuration from SSM
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

    // Lookup Route 53 hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    // ============================================
    // Target Group (merged from TargetGroupStack)
    // ============================================
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'RouterTargetGroup', {
      vpc: vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        port: '8080',
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Export target group info to SSM
    new ssm.StringParameter(this, 'RouterTargetGroupArnParam', {
      parameterName: `/opencode/${props.environment}/target-group/router-arn`,
      stringValue: this.targetGroup.targetGroupArn,
      description: 'Router Target Group ARN',
    });

    new ssm.StringParameter(this, 'RouterTargetGroupNameParam', {
      parameterName: `/opencode/${props.environment}/target-group/router-name`,
      stringValue: this.targetGroup.targetGroupName,
      description: 'Router Target Group Name',
    });

    // ============================================
    // DynamoDB — API Keys table
    // ============================================
    const apiKeysTable = new dynamodb.Table(this, 'ApiKeysTable', {
      tableName: `opencode-api-keys-${props.environment}`,
      partitionKey: { name: 'key_hash', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: props.environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    apiKeysTable.addGlobalSecondaryIndex({
      indexName: 'user-sub-index',
      partitionKey: { name: 'user_sub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    new ssm.StringParameter(this, 'ApiKeysTableNameParam', {
      parameterName: `/opencode/${props.environment}/dynamodb/api-keys-table-name`,
      stringValue: apiKeysTable.tableName,
      description: 'API Keys DynamoDB Table Name',
    });

    // ============================================
    // ALB (merged from JwtAlbStack)
    // ============================================
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: vpc,
      description: 'Security group for JWT ALB',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere'
    );

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP for redirect'
    );

    new ssm.StringParameter(this, 'AlbSecurityGroupIdParam', {
      parameterName: `/opencode/${props.environment}/alb/jwt/security-group-id`,
      stringValue: albSecurityGroup.securityGroupId,
    });

    // ALB access logs bucket
    const albAccessLogsBucket = new s3.Bucket(this, 'AlbAccessLogsBucket', {
      bucketName: `opencode-jwt-alb-logs-${props.environment}-${this.account}`,
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

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'JwtAlb', {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: `opencode-jwt-${props.environment}`,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnets: publicSubnets,
      },
      http2Enabled: true,
      dropInvalidHeaderFields: true,
    });

    this.alb.logAccessLogs(albAccessLogsBucket, 'jwt-alb');

    // Extended timeout for Claude models with thinking (can take minutes before first token)
    this.alb.setAttribute('idle_timeout.timeout_seconds', '900');

    new ssm.StringParameter(this, 'AlbArnParam', {
      parameterName: `/opencode/${props.environment}/alb/jwt/arn`,
      stringValue: this.alb.loadBalancerArn,
    });

    new ssm.StringParameter(this, 'AlbDnsNameParam', {
      parameterName: `/opencode/${props.environment}/alb/jwt/dns-name`,
      stringValue: this.alb.loadBalancerDnsName,
    });

    // DNS Record
    new route53.ARecord(this, 'ApiDnsRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(this.alb)
      ),
    });

    new ssm.StringParameter(this, 'ApiDnsNameParam', {
      parameterName: `/opencode/${props.environment}/api/dns-name`,
      stringValue: props.domainName,
    });

    // HTTPS Listener
    this.listener = this.alb.addListener('HttpsListener', {
      port: 443,
      certificates: [{
        certificateArn: certificateArn,
      }],
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden - Authentication required',
      }),
    });

    new ssm.StringParameter(this, 'ListenerArnParam', {
      parameterName: `/opencode/${props.environment}/alb/jwt/listener-arn`,
      stringValue: this.listener.listenerArn,
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
    // ECS Service (merged from RouterStack)
    // ============================================
    this.cluster = new ecs.Cluster(this, 'BedrockRouterCluster', {
      vpc: vpc,
      clusterName: `opencode-${props.environment}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    new ssm.StringParameter(this, 'ClusterNameParam', {
      parameterName: `/opencode/${props.environment}/ecs/cluster-name`,
      stringValue: this.cluster.clusterName,
      description: 'ECS Cluster Name',
    });

    new ssm.StringParameter(this, 'ClusterArnParam', {
      parameterName: `/opencode/${props.environment}/ecs/cluster-arn`,
      stringValue: this.cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });

    // ECR Repository
    const repository = new ecr.Repository(this, 'RouterRepository', {
      repositoryName: `bedrock-router-${props.environment}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });

    new ssm.StringParameter(this, 'EcrRepositoryUriParam', {
      parameterName: `/opencode/${props.environment}/ecr/repository-uri`,
      stringValue: repository.repositoryUri,
      description: 'ECR Repository URI',
    });

    // Task role with Bedrock permissions
    const taskRole = new iam.Role(this, 'RouterTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Task role for Bedrock Router ECS service',
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/moonshotai.*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.moonshotai.*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.*`,
      ],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-mantle:CreateInference',
        'bedrock-mantle:CallWithBearerToken',
      ],
      resources: [
        `arn:aws:bedrock-mantle:*:${this.account}:project/default`,
        '*',
      ],
    }));

    // Grant DynamoDB permissions for API key validation
    apiKeysTable.grantReadWriteData(taskRole);

    // Grant S3 read access to distribution bucket for version policy and download URLs
    const distributionBucketName = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/distribution/assets-bucket-name`
    );
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${distributionBucketName}/downloads/*`],
    }));

    new ssm.StringParameter(this, 'TaskRoleArnParam', {
      parameterName: `/opencode/${props.environment}/ecs/task-role-arn`,
      stringValue: taskRole.roleArn,
      description: 'ECS Task Role ARN',
    });

    // Task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'RouterTaskDef', {
      family: `bedrock-router-${props.environment}`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    new ssm.StringParameter(this, 'TaskDefArnParam', {
      parameterName: `/opencode/${props.environment}/ecs/task-definition-arn`,
      stringValue: this.taskDefinition.taskDefinitionArn,
      description: 'Task Definition ARN',
    });

    // CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'RouterLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Container definition
    const container = this.taskDefinition.addContainer('router', {
      image: ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'router',
        logGroup: logGroup,
      }),
      environment: {
        PORT: '8080',
        LOG_LEVEL: 'INFO',
        BEDROCK_MANTLE_URL: 'https://bedrock-mantle.us-east-1.api.aws',
        SERVICE_VERSION: '1.0.0',
        AWS_REGION: cdk.Aws.REGION,
        API_KEYS_TABLE_NAME: apiKeysTable.tableName,
        DISTRIBUTION_BUCKET: distributionBucketName,
        ...(props.webDomain ? { DISTRIBUTION_DOMAIN: props.webDomain } : {}),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:8080/health\')" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    container.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // ============================================
    // Listener Rules (must be created BEFORE ECS service attaches)
    // ============================================

    // Health check rule (Priority 1) - No auth required
    const healthCheckRule = new elbv2.CfnListenerRule(this, 'HealthCheckRule', {
      listenerArn: this.listener.listenerArn,
      priority: 1,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/health', '/health/*', '/ready'],
          },
        },
      ],
      actions: [
        {
          type: 'forward',
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ],
    });

    // Update endpoints rule (Priority 2) - No ALB auth required
    // These serve non-sensitive data (config patches, presigned download URLs)
    // and must be accessible to clients with expired tokens so they can self-update.
    // The router's own auth middleware handles API key validation for download URLs.
    const updateEndpointRule = new elbv2.CfnListenerRule(this, 'UpdateEndpointRule', {
      listenerArn: this.listener.listenerArn,
      priority: 2,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/v1/update/*'],
          },
        },
      ],
      actions: [
        {
          type: 'forward',
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ],
    });

    // API key management rule (Priority 3) — JWT required for /v1/api-keys* paths
    const apiKeyManagementRule = new elbv2.CfnListenerRule(this, 'ApiKeyManagementRule', {
      listenerArn: this.listener.listenerArn,
      priority: 3,
      conditions: [
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/v1/api-keys*'],
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
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ],
    });

    // JWT Validation rule (Priority 5) - Bearer token required
    const jwtValidationRule = new elbv2.CfnListenerRule(this, 'JwtValidationRule', {
      listenerArn: this.listener.listenerArn,
      priority: 5,
      conditions: [
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
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ],
    });

    // API key passthrough rule (Priority 10) — X-API-Key header, app validates
    const apiKeyPassthroughRule = new elbv2.CfnListenerRule(this, 'ApiKeyPassthroughRule', {
      listenerArn: this.listener.listenerArn,
      priority: 10,
      conditions: [
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
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ],
    });

    // ============================================
    // ECS Service (must be created AFTER listener rules)
    // ============================================

    // Security group for ECS service
    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: vpc,
      description: 'Security group for Bedrock Router ECS service',
      allowAllOutbound: true,
    });

    // Allow traffic from ALB to ECS service on port 8080
    serviceSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(8080),
      'Allow health check and application traffic from ALB'
    );

    new ssm.StringParameter(this, 'ServiceSecurityGroupIdParam', {
      parameterName: `/opencode/${props.environment}/ecs/service-security-group-id`,
      stringValue: serviceSecurityGroup.securityGroupId,
      description: 'ECS Service Security Group ID',
    });

    // Fargate Service
    this.service = new ecs.FargateService(this, 'RouterService', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      serviceName: `bedrock-router-${props.environment}`,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: {
        subnets: privateSubnets,
      },
      securityGroups: [serviceSecurityGroup],
      circuitBreaker: {
        rollback: true,
      },
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // Add dependency on listener rules to ensure target group is associated with ALB first
    this.service.node.addDependency(healthCheckRule);
    this.service.node.addDependency(apiKeyManagementRule);
    this.service.node.addDependency(jwtValidationRule);
    this.service.node.addDependency(apiKeyPassthroughRule);

    // Attach ECS service to target group (after listener rules are created)
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    new ssm.StringParameter(this, 'ServiceNameParam', {
      parameterName: `/opencode/${props.environment}/ecs/router-service-name`,
      stringValue: this.service.serviceName,
      description: 'Router Service Name',
    });

    // Auto-scaling
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ============================================
    // cdk-nag suppressions
    // ============================================
    NagSuppressions.addResourceSuppressions(albSecurityGroup, [
      {
        id: 'AwsSolutions-EC23',
        reason: 'Internet-facing ALB requires 0.0.0.0/0 ingress on ports 80 (redirect) and 443 (HTTPS)',
      },
    ]);

    NagSuppressions.addResourceSuppressions(taskRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard ARNs required for cross-region Bedrock inference profiles (us.anthropic.*, us.moonshotai.*) and foundation models',
        appliesTo: [
          `Resource::arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.*`,
          `Resource::arn:aws:bedrock:*:${this.account}:inference-profile/us.moonshotai.*`,
          'Resource::arn:aws:bedrock:*::foundation-model/anthropic.*',
          'Resource::arn:aws:bedrock:*::foundation-model/moonshotai.*',
          `Resource::arn:aws:bedrock-mantle:*:${this.account}:project/default`,
          'Resource::*',
        ],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(taskRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB grantReadWriteData() generates index/* wildcard for GSI query access — this is CDK standard behavior',
        appliesTo: [
          `Resource::<ApiKeysTable9F4DC7E7.Arn>/index/*`,
        ],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(taskRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'S3 downloads/* wildcard required for version policy lookup and presigned download URL generation — scoped to the downloads/ prefix only',
        appliesTo: [
          `Resource::arn:aws:s3:::${distributionBucketName}/downloads/*`,
        ],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.taskDefinition, [
      {
        id: 'AwsSolutions-ECS2',
        reason: 'Environment variables contain non-sensitive configuration (PORT, LOG_LEVEL, region, table name) — secrets are not passed as env vars',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Execution role wildcard generated by CDK for ECR image pull authorization (ecr:GetAuthorizationToken requires Resource: *)',
        appliesTo: ['Resource::*'],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(albAccessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the ALB access logs bucket itself — enabling access logs on the log bucket would create infinite recursion',
      },
    ]);

    // ============================================
    // Outputs
    // ============================================
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'JWT ALB DNS Name',
    });

    new cdk.CfnOutput(this, 'ApiDomainName', {
      value: props.domainName,
      description: 'API Domain Name',
    });

    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      description: 'Target Group ARN',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster Name',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS Service Name',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: repository.repositoryUri,
      description: 'ECR Repository URI',
    });

    new cdk.CfnOutput(this, 'JwksUrl', {
      value: oidcJwksUrl,
      description: 'JWKS URL for JWT validation',
    });
  }
}
