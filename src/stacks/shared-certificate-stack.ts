import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface SharedCertificateStackProps extends cdk.StackProps {
  environment: string;
  hostedZoneId: string;
  hostedZoneName: string;
  domainName: string;
}

export class SharedCertificateStack extends cdk.Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: SharedCertificateStackProps) {
    super(scope, id, props);

    // Lookup existing Route 53 hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    // Create ACM certificate with DNS validation
    // Domain name is wildcard (e.g., *.oc.example.com) but we also need the apex domain
    // as a Subject Alternative Name (SAN)
    const apexDomain = props.domainName.replace(/^\*\./, ''); // Remove *. prefix
    
    this.certificate = new acm.Certificate(this, 'SharedCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [apexDomain],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Export certificate ARN to SSM for other stacks
    new ssm.StringParameter(this, 'CertificateArnParam', {
      parameterName: `/opencode/${props.environment}/shared/certificate-arn`,
      stringValue: this.certificate.certificateArn,
      description: 'Shared ACM Certificate ARN for OpenCode',
    });

    // Outputs
    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM Certificate ARN',
    });

    new cdk.CfnOutput(this, 'DomainName', {
      value: props.domainName,
      description: 'Certificate Domain Name',
    });
  }
}
