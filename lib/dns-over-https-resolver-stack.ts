import * as path from 'path';
import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface DnsOverHttpsResolverStackProps extends cdk.StackProps {
  /** AWS WAF rate-based rule limit: requests per client IP per 5-minute window. */
  readonly rateLimitPer5Min: number;
  /**
   * Optional alternate domain name for the endpoint, such as "doh.example.com".
   * Requires certificateArn. Without it, the endpoint uses the *.cloudfront.net name.
   */
  readonly domainName?: string;
  /** ARN of an ACM certificate in us-east-1 that covers domainName. */
  readonly certificateArn?: string;
  /** Deliver CloudFront access logs, including per-query DNS results, to CloudWatch Logs. */
  readonly accessLogs: boolean;
}

// Access log fields: the viewer-request-log-data field carries the DNS result
// the function records with cf.logCustomData().
const ACCESS_LOG_FIELDS = [
  'timestamp(ms)',
  'x-edge-location',
  'x-edge-request-id',
  'c-ip',
  'c-country',
  'asn',
  'cs-method',
  'cs-protocol-version',
  'sc-status',
  'time-taken',
  'viewer-request-log-data',
];

export class DnsOverHttpsResolverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsOverHttpsResolverStackProps) {
    super(scope, id, props);

    if (Boolean(props.domainName) !== Boolean(props.certificateArn)) {
      throw new Error('domainName and certificateArn must be set together');
    }

    // Created empty on purpose. CloudFormation can't update a KeyValueStore's
    // import source, so seeding records here would make every later stack update
    // fail once config/records.json changes. `npm run sync-records` writes the
    // records after deploy instead.
    const recordStore = new cloudfront.KeyValueStore(this, 'RecordStore', {
      comment: 'Hostname allowlist and per-country addresses for the DoH resolver',
    });

    const resolverFunction = new cloudfront.Function(this, 'DohResolverFunction', {
      comment: 'Answers RFC 8484 GET queries for allowlisted hostnames',
      code: cloudfront.FunctionCode.fromInline(
        fs.readFileSync(path.join(__dirname, '..', 'cloudfront-functions', 'doh-resolver.js'), 'utf-8'),
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: recordStore,
    });

    // The function answers every request itself, so this origin is never
    // contacted. CloudFront requires one, and an empty private bucket is the
    // lowest-risk choice.
    const placeholderOrigin = new s3.Bucket(this, 'PlaceholderOriginBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudFront only adds the viewer country header to the request a viewer
    // request function sees when a policy on the behavior references it.
    const viewerCountryPolicy = new cloudfront.OriginRequestPolicy(this, 'ViewerCountryPolicy', {
      comment: 'Exposes CloudFront-Viewer-Country to the DoH resolver function',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('CloudFront-Viewer-Country'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'DnsOverHttpsResolverWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.rateLimitPer5Min,
              evaluationWindowSec: 300,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitPerIp',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'DNS over HTTPS resolver for app clients',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: webAcl.attrArn,
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate: props.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)
        : undefined,
      // The default *.cloudfront.net certificate has a fixed security policy, so
      // a minimum TLS version can only be set with a custom certificate.
      minimumProtocolVersion: props.certificateArn ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(placeholderOrigin),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: viewerCountryPolicy,
        functionAssociations: [
          {
            function: resolverFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });

    if (props.accessLogs) {
      this.addAccessLogs(distribution);
    }

    new cdk.CfnOutput(this, 'DohEndpoint', {
      value: `https://${props.domainName ?? distribution.distributionDomainName}/dns-query`,
      description: 'DNS over HTTPS endpoint URL to configure in the client app',
    });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'Point a CNAME or alias record for domainName here when using a custom domain',
    });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: resolverFunction.functionName,
      description: 'CloudFront Function name, for aws cloudfront test-function',
    });
    new cdk.CfnOutput(this, 'KeyValueStoreArn', {
      value: recordStore.keyValueStoreArn,
      description: 'KeyValueStore that holds the record allowlist',
    });
  }

  // CloudFront standard logging (v2) to a CloudWatch Logs log group in us-east-1.
  private addAccessLogs(distribution: cloudfront.Distribution): void {
    const logGroup = new logs.LogGroup(this, 'AccessLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // LogGroup.logGroupArn ends in ":*", which log delivery and resource
    // policies don't expect, so build the plain log group ARN.
    const logGroupArn = this.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: logGroup.logGroupName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    // Managed by the stack, so it's removed on teardown, and scoped to this
    // log group and account instead of an account-wide log delivery policy.
    const deliveryPolicy = new logs.CfnResourcePolicy(this, 'AccessLogDeliveryPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-cloudfront-access-logs`,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontLogDelivery',
            Effect: 'Allow',
            Principal: { Service: 'delivery.logs.amazonaws.com' },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: `${logGroupArn}:log-stream:*`,
            Condition: {
              StringEquals: { 'aws:SourceAccount': this.account },
              ArnLike: { 'aws:SourceArn': `arn:${this.partition}:logs:${this.region}:${this.account}:delivery-source:*` },
            },
          },
        ],
      }),
    });

    const logDeliveryName = `${cdk.Aws.STACK_NAME}-access-logs`;
    const source = new logs.CfnDeliverySource(this, 'AccessLogSource', {
      name: logDeliveryName,
      logType: 'ACCESS_LOGS',
      resourceArn: `arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    });

    const destination = new logs.CfnDeliveryDestination(this, 'AccessLogDestination', {
      name: logDeliveryName,
      destinationResourceArn: logGroupArn,
      outputFormat: 'json',
    });
    destination.node.addDependency(deliveryPolicy);

    const delivery = new logs.CfnDelivery(this, 'AccessLogDelivery', {
      deliverySourceName: logDeliveryName,
      deliveryDestinationArn: destination.attrArn,
      recordFields: ACCESS_LOG_FIELDS,
    });
    delivery.node.addDependency(source);

    new cdk.CfnOutput(this, 'AccessLogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Logs log group with CloudFront access logs and per-query DNS results',
    });
  }
}
