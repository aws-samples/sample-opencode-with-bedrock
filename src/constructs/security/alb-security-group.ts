import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface AlbSecurityGroupConstructProps {
  vpc: ec2.IVpc;
  description?: string;
  allowHttp?: boolean;
}

export class AlbSecurityGroupConstruct extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AlbSecurityGroupConstructProps) {
    super(scope, id);

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: props.description ?? 'Security group for ALB',
      allowAllOutbound: true,
    });

    // Allow HTTPS from anywhere
    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere'
    );

    // Allow HTTP if requested (for redirect)
    if (props.allowHttp !== false) {
      this.securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'Allow HTTP for redirect'
      );
    }
  }
}
