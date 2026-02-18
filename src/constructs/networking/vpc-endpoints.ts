import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VpcEndpointsConstructProps {
  vpc: ec2.IVpc;
  subnetType?: ec2.SubnetType;
}

export class VpcEndpointsConstruct extends Construct {
  public readonly bedrockRuntimeEndpoint: ec2.InterfaceVpcEndpoint;
  public readonly bedrockEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: VpcEndpointsConstructProps) {
    super(scope, id);

    const subnetType = props.subnetType ?? ec2.SubnetType.PRIVATE_WITH_EGRESS;

    // VPC Interface Endpoint for Bedrock Runtime
    this.bedrockRuntimeEndpoint = props.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType },
    });

    // VPC Interface Endpoint for Bedrock
    this.bedrockEndpoint = props.vpc.addInterfaceEndpoint('BedrockEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
      subnets: { subnetType },
    });
  }
}
