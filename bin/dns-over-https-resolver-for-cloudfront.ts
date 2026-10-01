#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DnsOverHttpsResolverStack } from '../lib/dns-over-https-resolver-stack';

const app = new cdk.App();

// AWS WAF accepts rate-based rule limits from 10 to 2,000,000,000.
const rateLimitPer5Min = Number(app.node.tryGetContext('rateLimitPer5Min') ?? 2000);
if (!Number.isInteger(rateLimitPer5Min) || rateLimitPer5Min < 10 || rateLimitPer5Min > 2_000_000_000) {
  throw new Error('rateLimitPer5Min must be an integer between 10 and 2000000000');
}

new DnsOverHttpsResolverStack(app, 'DnsOverHttpsResolverStack', {
  rateLimitPer5Min,
  domainName: app.node.tryGetContext('domainName'),
  certificateArn: app.node.tryGetContext('certificateArn'),
  accessLogs: String(app.node.tryGetContext('accessLogs') ?? 'true') !== 'false',
  // AWS WAF web ACLs for CloudFront must be created in us-east-1.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
