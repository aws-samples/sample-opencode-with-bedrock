import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  environment: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    // VPC with public and private subnets across 2 AZs
    this.vpc = new ec2.Vpc(this, 'OpenCodeVpc', {
      maxAzs: 2,
      natGateways: 1,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // VPC Flow Logs
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogGroup', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Export VPC ID to SSM
    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: `/opencode/${props.environment}/network/vpc-id`,
      stringValue: this.vpc.vpcId,
      description: 'VPC ID for OpenCode',
    });

    // Export VPC CIDR to SSM
    new ssm.StringParameter(this, 'VpcCidrParam', {
      parameterName: `/opencode/${props.environment}/network/vpc-cidr`,
      stringValue: this.vpc.vpcCidrBlock,
      description: 'VPC CIDR block',
    });

    // Export private subnet IDs to SSM
    new ssm.StringListParameter(this, 'PrivateSubnetIdsParam', {
      parameterName: `/opencode/${props.environment}/network/private-subnet-ids`,
      stringListValue: this.vpc.privateSubnets.map(s => s.subnetId),
      description: 'Private subnet IDs',
    });

    // Export public subnet IDs to SSM
    new ssm.StringListParameter(this, 'PublicSubnetIdsParam', {
      parameterName: `/opencode/${props.environment}/network/public-subnet-ids`,
      stringListValue: this.vpc.publicSubnets.map(s => s.subnetId),
      description: 'Public subnet IDs',
    });

    // Export public subnet route table IDs to SSM
    new ssm.StringListParameter(this, 'PublicRouteTableIdsParam', {
      parameterName: `/opencode/${props.environment}/network/public-route-table-ids`,
      stringListValue: this.vpc.publicSubnets.map(s => s.routeTable.routeTableId),
      description: 'Public subnet route table IDs',
    });

    // Export private subnet route table IDs to SSM
    new ssm.StringListParameter(this, 'PrivateRouteTableIdsParam', {
      parameterName: `/opencode/${props.environment}/network/private-route-table-ids`,
      stringListValue: this.vpc.privateSubnets.map(s => s.routeTable.routeTableId),
      description: 'Private subnet route table IDs',
    });

    // VPC Interface Endpoints for Bedrock — PrivateLink eliminates NAT gateway
    // as intermediary for Bedrock API traffic, improving connection reliability.
    this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.vpc.addInterfaceEndpoint('BedrockEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Export availability zones to SSM
    new ssm.StringListParameter(this, 'AvailabilityZonesParam', {
      parameterName: `/opencode/${props.environment}/network/availability-zones`,
      stringListValue: this.vpc.availabilityZones,
      description: 'Availability zones',
    });

    // cdk-nag suppressions
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'CdkNagValidationFailure',
          reason: 'VPC endpoint security groups use VPC CIDR intrinsic reference which cdk-nag cannot validate at synth time',
        },
      ],
      true,
    );

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: 'VPC CIDR',
    });
  }
}
