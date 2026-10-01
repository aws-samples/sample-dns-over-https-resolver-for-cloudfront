// Applies config/records.json to the deployed KeyValueStore: puts new or changed
// entries and deletes entries no longer in the config. Changes reach CloudFront
// edge locations shortly after the update, without a stack update.
//
// Usage: npm run sync-records [-- --dry-run] [-- --force] [-- path/to/records.json]
// Uses the AWS CLI (v2) because KeyValueStore API calls require SigV4A signing.
import { execFileSync } from 'child_process';
import * as path from 'path';
import { loadRecordsConfig, toKvsEntries } from '../lib/records';

const STACK_NAME = 'DnsOverHttpsResolverStack';
const REGION = 'us-east-1';
// UpdateKeys accepts at most 50 puts and deletes combined per call.
const BATCH_SIZE = 50;

function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf-8' });
  return out.trim() ? JSON.parse(out) : {};
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const recordsFile = args.find((a) => !a.startsWith('--')) ?? path.join(__dirname, '..', 'config', 'records.json');

const desired = new Map(toKvsEntries(loadRecordsConfig(recordsFile)).map((e) => [e.key, e.value]));

let outputs: { OutputKey: string; OutputValue: string }[] = [];
try {
  outputs = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME, '--query', 'Stacks[0].Outputs']) ?? [];
} catch {
  // The AWS CLI has already printed the reason (for example, the stack doesn't exist).
}
const kvsArn = outputs.find((o) => o.OutputKey === 'KeyValueStoreArn')?.OutputValue;
if (!kvsArn) {
  console.error(`No KeyValueStoreArn output found on stack ${STACK_NAME} in ${REGION}. Run cdk deploy first.`);
  process.exit(1);
}

const current = new Map<string, string>(
  (aws(['cloudfront-keyvaluestore', 'list-keys', '--kvs-arn', kvsArn]).Items ?? []).map(
    (item: { Key: string; Value: string }) => [item.Key, item.Value],
  ),
);

const changes: ({ put: { Key: string; Value: string } } | { del: { Key: string } })[] = [];
for (const [key, value] of desired) {
  if (current.get(key) !== value) {
    changes.push({ put: { Key: key, Value: value } });
  }
}
for (const key of current.keys()) {
  if (!desired.has(key)) {
    changes.push({ del: { Key: key } });
  }
}

for (const change of changes) {
  console.log('put' in change ? `put    ${change.put.Key} ${change.put.Value}` : `delete ${change.del.Key}`);
}
if (changes.length === 0 || dryRun) {
  console.log(changes.length === 0 ? 'KeyValueStore already matches config.' : 'Dry run, no changes applied.');
  process.exit(0);
}

// Deleting a key removes that name (or country override) from the allowlist,
// so a wrong records file could turn most answers into REFUSED at once.
const deleteCount = changes.filter((c) => 'del' in c).length;
if (!force && current.size > 0 && deleteCount > current.size / 2) {
  console.error(
    `Refusing to delete ${deleteCount} of ${current.size} keys. Check the records file, ` +
      'or rerun with --force if this is intended.',
  );
  process.exit(1);
}

let etag: string = aws(['cloudfront-keyvaluestore', 'describe-key-value-store', '--kvs-arn', kvsArn]).ETag;
for (let i = 0; i < changes.length; i += BATCH_SIZE) {
  const batch = changes.slice(i, i + BATCH_SIZE);
  const puts = batch.flatMap((c) => ('put' in c ? [c.put] : []));
  const deletes = batch.flatMap((c) => ('del' in c ? [c.del] : []));
  const updateArgs = ['cloudfront-keyvaluestore', 'update-keys', '--kvs-arn', kvsArn, '--if-match', etag];
  if (puts.length > 0) updateArgs.push('--puts', JSON.stringify(puts));
  if (deletes.length > 0) updateArgs.push('--deletes', JSON.stringify(deletes));
  etag = aws(updateArgs).ETag;
}
console.log(`Applied ${changes.length} change(s).`);
