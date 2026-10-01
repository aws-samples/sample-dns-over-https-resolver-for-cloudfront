# DNS over HTTPS Resolver for Amazon CloudFront

A DNS over HTTPS (DoH) endpoint, answered entirely at Amazon CloudFront edge locations, that your mobile, desktop, or embedded client app uses to resolve its own hostnames (for example, API, sign-in, and regional service endpoints) instead of relying on the user's local DNS resolver. It returns per-country addresses and refuses names that aren't on your allowlist.

## Problem it solves

When a client app resolves one of your hostnames, such as `api.example.com`, the query normally goes to whatever resolver the user's network hands out, usually the one from the user's internet service provider (ISP). In some markets and on some networks, that resolver returns a wrong answer: an ad or portal page, a stale address, or an address that routes the user to a distant server. The user sees a sign-in failure or slow responses and blames the app.

Client apps address this with a pattern often called HTTPDNS: the client resolves its own critical hostnames over HTTPS, directly against a resolver the publisher controls. This sample implements that pattern on AWS with no servers:

- **CloudFront Functions** parse RFC 8484 DNS wire-format queries and build responses at the edge. No origin is contacted.
- **CloudFront KeyValueStore** holds the hostname allowlist and addresses. Updates reach edge locations shortly after you make them, without redeploying.
- **`CloudFront-Viewer-Country`** selects a per-country record set, so users in Japan and Singapore can get different server addresses.
- **AWS WAF** applies a per-IP rate-based rule to the endpoint.
- **CloudFront standard logging (v2)** records each query's result (`NOERROR`, `REFUSED`, and so on), hostname, and record set in Amazon CloudWatch Logs, through the function's `cf.logCustomData()` call.

### How this compares with other options

This sample answers one question: how does an app you distribute to the public resolve *its own* hostnames without depending on the resolver of the user's network? Other AWS and DNS options solve related problems:

| Option | Fits when | Difference from this sample |
|---|---|---|
| [Amazon Route 53 Resolver endpoints](https://aws.amazon.com/blogs/networking-and-content-delivery/encrypt-dns-queries-using-dns-over-https-doh-with-amazon-route-53-resolver-endpoints/) with DoH | On-premises networks resolve names in your VPCs over a VPN or AWS Direct Connect | Inbound endpoints use private IP addresses in a VPC, so clients on the public internet can't reach them |
| [Amazon Route 53 Global Resolver](https://aws.amazon.com/route53/global-resolver/) | Your organization resolves the DNS traffic of devices and sites it manages, with filtering and centralized logging | It's a recursive resolver for public and private domains, with clients identified by IP address ranges or access tokens. This sample resolves only your allowlisted names, with no client credentials in the app |
| Amazon Route 53 geolocation routing, queried through the user's resolver | Standard DNS resolution meets your needs | The query still travels to the resolver of the user's network, which is the hop this sample moves to HTTPS. Route 53 geolocation also sees the resolver's location unless the resolver forwards the client subnet |
| A public DoH resolver on the client, querying your Route 53 records | You accept a third-party resolver in the path | You don't control that resolver's availability in each market, its caching, or where query data goes |
| [An HTTP DNS API on AWS Lambda](https://github.com/aws-samples/serverless-httpdns) behind AWS Global Accelerator | You want static anycast IP addresses so the client skips resolving the resolver's own hostname, or you want arbitrary names resolved through an upstream resolver without maintaining a record list | Global Accelerator includes static anycast IP addresses in its fixed accelerator fee, which is a less expensive route to a DNS-free bootstrap than AWS-provided IPv4 Anycast static IPs on CloudFront. That sample exposes a JSON API and forwards queries upstream; this one implements the RFC 8484 wire format that DoH client libraries speak, answers only your allowlisted names at the edge, and changes answers through KeyValueStore |
| A server list fetched over HTTPS by the app | Your app already has a bootstrap configuration call | Works without DNS, but each app implements its own format and caching. DoH keeps hostnames, TLS Server Name Indication (SNI), and TTL semantics, and DoH-capable HTTP client libraries use it with a few lines of code |

## Architecture

![Architecture diagram: a client app sends DNS over HTTPS queries through AWS WAF to Amazon CloudFront, where CloudFront Functions answers them from CloudFront KeyValueStore; an operator updates the KeyValueStore, and access logs go to Amazon CloudWatch in the Region](docs/architecture.png)

The editable source is [`docs/architecture.drawio`](docs/architecture.drawio). The request path in detail:

```
Client app (DoH client for your hostnames only)
   |  GET https://<distribution>/dns-query?dns=<base64url DNS query>
   v
AWS WAF (CloudFront scope) --- per-IP rate-based rule
   |
   v
CloudFront viewer request -> CloudFront Function (cloudfront-js-2.0)
   |   1. parse the DNS question
   |   2. look up "<name>#<viewer country>", then "<name>#default"
   |      in CloudFront KeyValueStore
   |   3. build an application/dns-message response
   v
Response returned from the edge location (no origin request)
   |
   v
CloudFront access log (standard logging v2) -> Amazon CloudWatch Logs
   viewer-request-log-data = "<rcode>:<name>:<type>:<record set>"

config/records.json --(npm run sync-records)--> KeyValueStore
```

Response behavior:

| Query | Response |
|---|---|
| A or AAAA for an allowlisted name | `NOERROR` with the addresses for the viewer's country, or the `default` set |
| Other types (for example `HTTPS`, `MX`) for an allowlisted name | `NOERROR` with no answers |
| Name not in the allowlist | `REFUSED` |
| Malformed question | `FORMERR` |
| `POST` or another method CloudFront doesn't allow on the behavior | HTTP 403 from CloudFront, before the function runs |
| `HEAD`, wrong path, or bad `dns` parameter | HTTP 405, 404, or 400 from the function |

A country-specific record set replaces the `default` set entirely. If `HK` defines only `A` records, an `AAAA` query from Hong Kong gets an empty answer rather than the default IPv6 address, so a dual-stack client doesn't mix addresses from two regions.

The placeholder Amazon S3 origin exists only because a CloudFront distribution requires an origin. It's empty, private, and reachable only through origin access control (OAC).

### How the client resolves the DoH hostname

The client still resolves the DoH endpoint's hostname (`dxxxxxxxx.cloudfront.net`) through local DNS once. If a resolver returns a wrong address for it, the TLS handshake fails, because a server at that address can't present a valid certificate for the name. A tampered answer becomes a connection failure the client can detect and handle, instead of a silent redirect. To remove the local DNS lookup entirely, use [CloudFront Anycast static IPs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/request-static-ips.html) and connect to a fixed address with the TLS Server Name Indication (SNI) set to your hostname. You request an Anycast static IP list from CloudFront and describe your workload, and the distribution must use all edge locations. A list holds 3 or 21 addresses. On cost: AWS-provided IPv4 addresses carry a per-address hourly charge, AWS-provided IPv6 addresses carry no CloudFront charge, and addresses you bring yourself through [VPC IP Address Manager (IPAM)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/bring-your-own-ip-address-using-ipam.html) carry no CloudFront list charge. An IPv6 or dual-stack list is therefore the least expensive route to a DNS-free bootstrap, if your clients' networks carry IPv6. See [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/).

## Prerequisites

- An AWS account with permissions to create CloudFront, CloudFront KeyValueStore, AWS WAF, and Amazon S3 resources
- [AWS Cloud Development Kit (AWS CDK)](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) v2 and Node.js 18 or later
- AWS Command Line Interface (AWS CLI) version 2, configured with credentials for the target account (used by `npm run sync-records`)
- Python 3 (for the test client in `scripts/doh-query.py`)

The stack deploys to `us-east-1`, because AWS WAF web ACLs for CloudFront must be created there. CloudFront itself serves traffic globally.

## Deploy

1. Edit `config/records.json` with your hostnames and addresses. The bundled file uses documentation-only addresses (`203.0.113.0/24`, `198.51.100.0/24`, `2001:db8::/32`).

   ```json
   {
     "defaultTtlSeconds": 30,
     "records": {
       "api.example.com": {
         "default": { "A": ["203.0.113.10"], "AAAA": ["2001:db8::10"] },
         "JP,KR,TW": { "A": ["203.0.113.20"], "AAAA": ["2001:db8::20"] }
       },
       "login.example.com": {
         "default": { "A": ["198.51.100.5"], "ttl": 300 }
       }
     }
   }
   ```

   Hostnames are lowercase with no trailing dot. Keys under a hostname are `default` (required) or one or more comma-separated uppercase ISO 3166-1 alpha-2 country codes, so you can map the countries a regional server fleet covers to one record set. A country can appear in only one record set per hostname. `npm test` validates the bundled config, and `npm run sync-records` validates it again before writing.

2. Install, test, and deploy the stack:

   ```bash
   npm install
   npm test
   cdk bootstrap aws://<account-id>/us-east-1   # first time only
   cdk deploy
   ```

   Optional context values:
   - `-c rateLimitPer5Min=<n>` sets the AWS WAF rate limit per client IP per 5 minutes. The default is `2000`. Users behind carrier-grade network address translation (NAT) share a public IP address, so set this based on your peak concurrent users per network, not per device.
   - `-c accessLogs=false` turns off CloudFront access logs and the CloudWatch Logs log group. Access logs are on by default.
   - `-c domainName=<name> -c certificateArn=<arn>` serves the endpoint on your own domain name with a TLS 1.2 minimum protocol version. The certificate must be in AWS Certificate Manager (ACM) in `us-east-1` and cover the name. After deploying, point a CNAME (or Amazon Route 53 alias) record for the name at the `DistributionDomainName` output.

3. Write the records to the KeyValueStore:

   ```bash
   npm run sync-records
   ```

   The stack creates the KeyValueStore empty, so the endpoint answers `REFUSED` until this step runs. Records aren't part of the stack on purpose: AWS CloudFormation can't update a KeyValueStore's import source, so seeding records through the stack would make later stack updates fail.

The stack outputs `DohEndpoint`, `DistributionDomainName`, `FunctionName`, `KeyValueStoreArn`, and (with access logs on) `AccessLogGroupName`.

## Test

```bash
DOH_ENDPOINT=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name DnsOverHttpsResolverStack \
  --query "Stacks[0].Outputs[?OutputKey=='DohEndpoint'].OutputValue" --output text)

# Allowlisted name: answered with the record set for your country (or default).
python3 scripts/doh-query.py "$DOH_ENDPOINT" api.example.com A
python3 scripts/doh-query.py "$DOH_ENDPOINT" api.example.com AAAA

# Name not on the allowlist: REFUSED.
python3 scripts/doh-query.py "$DOH_ENDPOINT" www.example.org A
```

If your `dig` is BIND 9.18 or later, it can query the endpoint too:

```bash
DOH_HOST=${DOH_ENDPOINT#https://}; DOH_HOST=${DOH_HOST%/dns-query}
dig @"$DOH_HOST" +https-get=/dns-query api.example.com
```

To see the per-country answers without traveling, run the function against a synthetic event that sets the viewer country header:

```bash
FUNCTION_NAME=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name DnsOverHttpsResolverStack \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text)
ETAG=$(aws cloudfront describe-function --name "$FUNCTION_NAME" --stage LIVE --query ETag --output text)
QUERY=$(python3 -c 'import base64,struct;q=struct.pack(">6H",0,256,1,0,0,0)+b"\x04play\x07example\x03com\x00"+struct.pack(">HH",1,1);print(base64.urlsafe_b64encode(q).rstrip(b"=").decode())')

cat > /tmp/doh-test-event.json <<EOF
{"version":"1.0","context":{"eventType":"viewer-request"},"viewer":{"ip":"198.51.100.1"},
 "request":{"method":"GET","uri":"/dns-query","querystring":{"dns":{"value":"$QUERY"}},
 "headers":{"cloudfront-viewer-country":{"value":"JP"}},"cookies":{}}}
EOF

aws cloudfront test-function --name "$FUNCTION_NAME" --stage LIVE --if-match "$ETAG" \
  --event-object fileb:///tmp/doh-test-event.json \
  --query 'TestResult.{Output:FunctionOutput,Error:FunctionErrorMessage,Compute:ComputeUtilization}'
```

## Update records without redeploying

`config/records.json` is the source of truth for the KeyValueStore. After editing it, apply the changes with:

```bash
npm run sync-records -- --dry-run   # show puts and deletes
npm run sync-records                # apply them
```

The script diffs the config against the deployed store and applies the changes with `aws cloudfront-keyvaluestore update-keys`. If the changes would delete more than half of the keys, which usually means the wrong records file, the script stops unless you pass `--force`. To use a different file, pass its path: `npm run sync-records -- path/to/records.json`. Edge locations serve the new answers shortly after the update completes. Clients pick them up when their cached answer's time to live (TTL) expires, so keep TTLs short (the default is 30 seconds) for hostnames you fail over.

## Demo: move Japan, Korea, and Taiwan users to another region

This walkthrough shows the failover path you'd use if a regional server fleet becomes unavailable.

1. Confirm the current answer for a viewer in Japan with the `test-function` commands in [Test](#test). The output contains `203.0.113.20`.
2. In `config/records.json`, change the `"JP,KR,TW"` record set of `api.example.com` to the Singapore addresses:

   ```json
   "JP,KR,TW": { "A": ["203.0.113.40", "203.0.113.41"] },
   ```

3. Preview and apply the change:

   ```bash
   npm run sync-records -- --dry-run
   npm run sync-records
   ```

   The dry run lists three `put` lines, one each for `api.example.com#JP`, `#KR`, and `#TW`.

4. Query the endpoint or run `test-function` again. Shortly after the update, the answer for `JP` is `203.0.113.40` and `203.0.113.41`. Clients switch when their cached answer expires, 30 seconds with the bundled config.

To fail back, revert the file and run `npm run sync-records` again.

## Monitor queries

With access logs on, each request is a JSON log event in the `AccessLogGroupName` log group. The `viewer-request-log-data` field holds the DNS result as `<rcode>:<name>:<type>:<record set>`, for example `NOERROR:api.example.com:A:JP`. The name is `-` when the query was malformed or failed hostname validation, and the whole field is `-` for requests the function answered with an HTTP error (400, 404, or 405) or that CloudFront rejected before the function ran (403).

In CloudWatch Logs Insights, select the log group and run:

```
fields @timestamp
| parse `viewer-request-log-data` "*:*:*:*" as rcode, qname, qtype, recordSet
| filter ispresent(rcode)
| stats count(*) as queries by rcode, `c-country`, recordSet
| sort queries desc
```

Useful variations:

- `| filter rcode = "REFUSED" and qname != "-" | stats count(*) by qname` shows names clients ask for that aren't on the allowlist, which usually points to a client build using a hostname you haven't added.
- `` | filter recordSet = "default" | stats count(*) by `c-country` `` shows which countries fall back to `default` and might need their own record set.
- `` | stats count(*) as requests by `c-ip` | sort requests desc | limit 20 `` shows the busiest client IP addresses, which helps you choose `rateLimitPer5Min` for networks with many users behind one address.

CloudFront Functions metrics (invocations, execution errors, compute utilization) and AWS WAF metrics (allowed and blocked requests) are in CloudWatch in `us-east-1` without additional setup.

## Using it from a client app

Use the DoH endpoint only for your own hostnames, and keep the platform resolver for everything else. With OkHttp on Android, for example:

```kotlin
val bootstrap = OkHttpClient()
val appDoh = DnsOverHttps.Builder()
    .client(bootstrap)
    .url("https://dxxxxxxxx.cloudfront.net/dns-query".toHttpUrl())
    .post(false) // this endpoint implements the RFC 8484 GET method
    .build()

val appDns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> =
        if (hostname.endsWith(".example.com")) appDoh.lookup(hostname) else Dns.SYSTEM.lookup(hostname)
}

val client = bootstrap.newBuilder().dns(appDns).build()
```

On iOS 14 and later, Network framework's `NWParameters.PrivacyContext` can send name resolution to a DoH server with `requireEncryptedNameResolution(_:fallbackResolver:)`. Apply it to a dedicated privacy context that you set only on the connections to your own hostnames, not to `PrivacyContext.default`: the default context covers lookups across the whole app, including third-party SDK hostnames, which this resolver answers with `REFUSED`. In testing with Network framework on macOS, each lookup sent `GET` requests over HTTP/2 for the `A`, `AAAA`, and `HTTPS` record types, which this endpoint answers. Test on your target iOS versions and devices before you rely on it.

Decide deliberately what the client does when the DoH lookup fails (for example, a network that blocks the endpoint): fall back to the system resolver and accept the risk of a tampered answer, or surface an error. Either way, keep TLS certificate validation on for your app traffic. TLS is what turns a tampered DNS answer into a detectable failure.

## Limitations

- **GET only.** RFC 8484 servers are expected to support both `GET` and `POST`. CloudFront Functions can't read request bodies, so the distribution allows only `GET` and `HEAD`, and CloudFront answers `POST` with HTTP 403. Clients you ship can use `GET`. To support third-party DoH clients that only send `POST`, add a Lambda@Edge function or a regional origin for `POST` requests.
- **IPv6-only networks.** On an IPv6-only network, the network's resolver usually synthesizes AAAA records (DNS64) so devices can reach IPv4-only servers. This resolver doesn't synthesize records. Publish AAAA records for your servers, or confirm that your target devices translate IPv4 addresses locally (for example, with 464XLAT).
- **A and AAAA only.** Other record types on an allowlisted name get an empty answer. There's no `SOA` in negative answers and no EDNS(0) support.
- **Country granularity.** Steering uses `CloudFront-Viewer-Country`. For finer control, extend the function to key on `CloudFront-Viewer-Country-Region` or `CloudFront-Viewer-ASN` (add the header to the origin request policy in `lib/dns-over-https-resolver-stack.ts`).
- **Reachability varies by network.** Some networks restrict DoH traffic or specific CDN addresses. Test the endpoint from the networks your users are on, and decide how the client falls back (see [Using it from a client app](#using-it-from-a-client-app)).
- **TLS policy on the default domain.** Without `domainName` and `certificateArn`, the endpoint uses the `*.cloudfront.net` certificate, whose security policy CloudFront fixes. To require TLS 1.2 or later, deploy with your own domain name (see [Deploy](#deploy)).

## Cost note

You are responsible for the cost of the AWS services used while running this sample. The stack has no idle compute. Charges come from CloudFront requests and data transfer, CloudFront Functions invocations, CloudFront KeyValueStore reads, and AWS WAF. With no traffic, the stack costs about USD 6 per month in `us-east-1`, from the AWS WAF web ACL and its one rule (both prorated hourly), at the time of writing. Everything else is billed by usage, so destroy the stack when you're not demoing it, and consider an [AWS Budgets](https://aws.amazon.com/aws-cost-management/aws-budgets/) alert on the account to catch unexpected request volume. Each query is one CloudFront HTTPS request, one AWS WAF request, one CloudFront Functions invocation, and one or two KeyValueStore reads. In Asia Pacific, that adds up to roughly USD 2 per million queries before logging, at the time of writing, with AWS WAF at about a third of it. Cost scales with client lookups, not with users: each lookup is two queries from clients that ask for `A` and `AAAA` records, and three from clients that also ask for `HTTPS` records, and there's no shared ISP resolver cache in between. To keep volume down, choose TTLs as long as your failover time allows, and consider turning DoH on only for the markets or networks where lookups fail. [CloudFront flat-rate plans](https://aws.amazon.com/cloudfront/pricing/) bundle AWS WAF, but they throttle requests beyond the plan's allowance, which for a resolver means failed lookups, so size a plan with headroom or stay on pay-as-you-go pricing. With access logs on, CloudWatch Logs also bills for log data ingested and stored. Each query produces one log event, and the log group keeps events for 7 days. At high query volumes, turn access logs off with `-c accessLogs=false` or lower the volume by removing fields in `ACCESS_LOG_FIELDS` in `lib/dns-over-https-resolver-stack.ts`. See [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) and [AWS WAF pricing](https://aws.amazon.com/waf/pricing/), and estimate costs with the [AWS Pricing Calculator](https://calculator.aws).

## Teardown

```bash
cdk destroy
```

This removes the CloudFront distribution, CloudFront Function, KeyValueStore (and the records in it), AWS WAF web ACL, origin request policy, placeholder S3 bucket, and, with access logs on, the log group, its log delivery configuration, and its CloudWatch Logs resource policy. If you deployed with a custom domain, delete the DNS record you created for it; the ACM certificate isn't managed by this stack. CloudFront distributions take several minutes to disable and delete.

## Security notes

This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory, and compliance requirements before deployment.


- **Not an open resolver.** The function answers only names in the KeyValueStore and doesn't forward queries. It doesn't resolve names outside your allowlist, and its responses go only to the client that sent the HTTPS request.
- **Who can change answers.** Anyone who can call `UpdateKeys` on the KeyValueStore controls where your hostnames point, so give the identity that runs `npm run sync-records` only what it needs, and keep `config/records.json` under code review. A policy like the following covers the script (replace the account ID and KeyValueStore ID with the values from the `KeyValueStoreArn` output):

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "SyncRecords",
        "Effect": "Allow",
        "Action": [
          "cloudfront-keyvaluestore:DescribeKeyValueStore",
          "cloudfront-keyvaluestore:ListKeys",
          "cloudfront-keyvaluestore:UpdateKeys"
        ],
        "Resource": "arn:aws:cloudfront::111122223333:key-value-store/<key-value-store-id>"
      },
      {
        "Sid": "ReadStackOutputs",
        "Effect": "Allow",
        "Action": "cloudformation:DescribeStacks",
        "Resource": "arn:aws:cloudformation:us-east-1:111122223333:stack/DnsOverHttpsResolverStack/*"
      }
    ]
  }
  ```

  AWS CloudTrail records each `UpdateKeys` call with the event source `edgekeyvaluestore.amazonaws.com`, so you can review or alert on record changes with CloudTrail or Amazon EventBridge.
- **Rate limiting.** The AWS WAF rate-based rule limits requests per client IP. It isn't client authentication. A client that knows the endpoint can resolve your allowlisted names, which are public hostnames already.
- **Input handling.** Queries over 512 bytes, compression pointers in the question, non-query messages, and hostnames with characters outside `a-z 0-9 - _` are rejected before a KeyValueStore lookup.
- **Answers aren't signed.** The response is protected in transit by TLS between the client and CloudFront. The sample doesn't implement DNSSEC.
- **Logging.** AWS WAF metrics and sampled requests are enabled. Access logs contain viewer IP addresses, countries, and the hostnames each viewer resolved, so treat them as personal data under your retention policy. The log group keeps events for 7 days. The CloudWatch Logs resource policy that lets CloudFront write to the log group allows only `delivery.logs.amazonaws.com`, only for this log group, and only for delivery sources in this account and Region.

## Project layout

```
bin/                                   CDK app entry point and context options
cloudfront-functions/doh-resolver.js   DoH request parsing and response building (runs at the edge)
config/records.json                    hostname allowlist and per-country addresses
lib/records.ts                         config validation and KeyValueStore encoding
lib/dns-over-https-resolver-stack.ts   CDK stack
scripts/sync-records.ts                apply config changes to the deployed KeyValueStore
scripts/doh-query.py                   standard-library DoH test client
docs/architecture.drawio               architecture diagram source (docs/architecture.png is the export)
test/                                  unit tests (function runs in a Node.js VM against the bundled config)
```

The CDK (TypeScript) choice keeps the function, the config validation, and the tests in one toolchain that is familiar to AWS-native teams.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the MIT-0 License. See [LICENSE](LICENSE).
