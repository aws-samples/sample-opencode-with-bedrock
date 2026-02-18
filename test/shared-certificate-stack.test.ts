import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SharedCertificateStack } from '../src/stacks/shared-certificate-stack';

const testEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

test('SharedCertificateStack creates an ACM certificate with DNS validation', () => {
  const app = new cdk.App();
  const stack = new SharedCertificateStack(app, 'TestCert', {
    environment: 'test',
    hostedZoneId: 'Z1234567890',
    hostedZoneName: 'example.com',
    domainName: '*.oc.example.com',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::CertificateManager::Certificate', 1);

  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: '*.oc.example.com',
    ValidationMethod: 'DNS',
  });
});

test('SharedCertificateStack includes apex domain as SAN', () => {
  const app = new cdk.App();
  const stack = new SharedCertificateStack(app, 'TestCertSAN', {
    environment: 'test',
    hostedZoneId: 'Z1234567890',
    hostedZoneName: 'example.com',
    domainName: '*.oc.example.com',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    SubjectAlternativeNames: ['oc.example.com'],
  });
});

test('SharedCertificateStack exports certificate ARN to SSM', () => {
  const app = new cdk.App();
  const stack = new SharedCertificateStack(app, 'TestCertSSM', {
    environment: 'test',
    hostedZoneId: 'Z1234567890',
    hostedZoneName: 'example.com',
    domainName: '*.oc.example.com',
    env: testEnv,
  });

  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/opencode/test/shared/certificate-arn',
  });
});
