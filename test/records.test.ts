import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DnsOverHttpsResolverStack, DnsOverHttpsResolverStackProps } from '../lib/dns-over-https-resolver-stack';
import { loadRecordsConfig, RecordsConfig, toKvsEntries } from '../lib/records';

function entriesFor(records: RecordsConfig['records']) {
  return toKvsEntries({ defaultTtlSeconds: 30, records });
}

test('encodes addresses to wire-format hex, expanding IPv6 zero compression', () => {
  const [entry] = entriesFor({ 'api.example.com': { default: { A: ['203.0.113.10'], AAAA: ['2001:db8::1:0:10'] } } });
  expect(entry.key).toBe('api.example.com#default');
  expect(JSON.parse(entry.value)).toEqual({
    ttl: 30,
    A: ['cb00710a'],
    AAAA: ['20010db8000000000000000100000010'],
  });
});

test.each([
  ['a hostname with a trailing dot', { 'api.example.com.': { default: { A: ['203.0.113.10'] } } }],
  ['an uppercase hostname', { 'Api.example.com': { default: { A: ['203.0.113.10'] } } }],
  ['a missing default record set', { 'api.example.com': { JP: { A: ['203.0.113.10'] } } }],
  ['a lowercase country code', { 'api.example.com': { default: { A: ['203.0.113.10'] }, jp: { A: ['203.0.113.20'] } } }],
  ['an invalid IPv4 address', { 'api.example.com': { default: { A: ['203.0.113.300'] } } }],
  ['an IPv6 address in the A list', { 'api.example.com': { default: { A: ['2001:db8::1'] } } }],
  ['an IPv4-mapped IPv6 address', { 'api.example.com': { default: { AAAA: ['::ffff:203.0.113.10'] } } }],
  ['a zero TTL', { 'api.example.com': { default: { A: ['203.0.113.10'], ttl: 0 } } }],
])('rejects %s', (_label, records) => {
  expect(() => entriesFor(records)).toThrow();
});

test('expands a comma-separated country group to one key per country', () => {
  const entries = entriesFor({
    'api.example.com': { default: { A: ['203.0.113.10'] }, 'JP, KR,TW': { A: ['203.0.113.20'] } },
  });
  expect(entries.map((e) => e.key)).toEqual([
    'api.example.com#default',
    'api.example.com#JP',
    'api.example.com#KR',
    'api.example.com#TW',
  ]);
  expect(entries[1].value).toBe(entries[3].value);
});

test('rejects a country listed in two record sets', () => {
  expect(() =>
    entriesFor({
      'api.example.com': { default: { A: ['203.0.113.10'] }, 'JP,KR': { A: ['203.0.113.20'] }, KR: { A: ['203.0.113.30'] } },
    }),
  ).toThrow(/more than one record set/);
});

test('rejects a record set too large for one KeyValueStore value', () => {
  const many = Array.from({ length: 100 }, (_, i) => `203.0.113.${i % 256}`);
  expect(() => entriesFor({ 'api.example.com': { default: { A: many } } })).toThrow(/1 KB/);
});

test('the bundled config is valid', () => {
  expect(toKvsEntries(loadRecordsConfig(path.join(__dirname, '..', 'config', 'records.json'))).length).toBeGreaterThan(0);
});

function synth(props: Partial<DnsOverHttpsResolverStackProps> = {}) {
  const app = new cdk.App();
  const stack = new DnsOverHttpsResolverStack(app, 'TestStack', {
    rateLimitPer5Min: 2000,
    accessLogs: true,
    env: { account: '111111111111', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

test('stack wires the function, store, and rate-based rule together', () => {
  const template = synth();
  // Created empty; CloudFormation can't update an import source later.
  template.hasResourceProperties('AWS::CloudFront::KeyValueStore', { ImportSource: Match.absent() });
  template.hasResourceProperties('AWS::CloudFront::Function', {
    FunctionConfig: { Runtime: 'cloudfront-js-2.0' },
  });
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'CLOUDFRONT',
    Rules: [{ Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP' } } }],
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: { HttpVersion: 'http2and3', ViewerCertificate: Match.absent() },
  });
});

test('access logs deliver the DNS result field to a log group with finite retention', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ACCESS_LOGS' });
  template.hasResourceProperties('AWS::Logs::Delivery', {
    RecordFields: Match.arrayWith(['c-country', 'viewer-request-log-data']),
  });
  template.resourceCountIs('AWS::Logs::ResourcePolicy', 1);
  // Plain log group ARN (no trailing ":*"), as log delivery expects.
  const [destination] = Object.values(template.findResources('AWS::Logs::DeliveryDestination'));
  const arn = JSON.stringify(destination.Properties.DestinationResourceArn);
  expect(arn).toContain(':log-group:');
  expect(arn).not.toContain(':*');
  const [policy] = Object.values(template.findResources('AWS::Logs::ResourcePolicy'));
  expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain(':log-stream:*');
  expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain(':*:log-stream');
});

test('access logs can be turned off', () => {
  const template = synth({ accessLogs: false });
  template.resourceCountIs('AWS::Logs::LogGroup', 0);
  template.resourceCountIs('AWS::Logs::Delivery', 0);
});

test('custom domain sets the alias and a TLS 1.2 minimum', () => {
  const template = synth({
    domainName: 'doh.example.com',
    certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000',
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      Aliases: ['doh.example.com'],
      ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021', SslSupportMethod: 'sni-only' }),
    },
  });
});

test('custom domain requires both domainName and certificateArn', () => {
  expect(() => synth({ domainName: 'doh.example.com' })).toThrow(/must be set together/);
});
