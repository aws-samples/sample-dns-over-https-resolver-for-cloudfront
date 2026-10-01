import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as dnsPacket from 'dns-packet';
import { loadRecordsConfig, toKvsEntries } from '../lib/records';

const FUNCTION_FILE = path.join(__dirname, '..', 'cloudfront-functions', 'doh-resolver.js');
const RECORDS_FILE = path.join(__dirname, '..', 'config', 'records.json');

type Handler = (event: unknown) => Promise<any>;

// Values the function passed to cf.logCustomData(), most recent last.
const logged: string[] = [];

// Runs the CloudFront Function in a Node.js VM with an in-memory stand-in for
// the KeyValueStore, seeded from the same config the stack deploys.
function loadHandler(): Handler {
  const store = new Map(toKvsEntries(loadRecordsConfig(RECORDS_FILE)).map((e) => [e.key, e.value]));
  const cf = {
    logCustomData: (data: string) => logged.push(data),
    kvs: () => ({
      get: async (key: string, options?: { format?: string }) => {
        const value = store.get(key);
        if (value === undefined) {
          throw new Error(`Key ${key} not found`);
        }
        return options?.format === 'json' ? JSON.parse(value) : value;
      },
    }),
  };
  const source = fs.readFileSync(FUNCTION_FILE, 'utf-8').replace("import cf from 'cloudfront';", '');
  return vm.runInNewContext(`${source}\nhandler;`, { cf, Buffer, Math }) as Handler;
}

function encodeQuery(name: string, type = 'A', id = 0): string {
  return dnsPacket
    .encode({ type: 'query', id, flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: type as dnsPacket.RecordType, name }] })
    .toString('base64url');
}

function event(dns: string | undefined, opts: { country?: string; method?: string; uri?: string } = {}) {
  const headers: Record<string, { value: string }> = {};
  if (opts.country) {
    headers['cloudfront-viewer-country'] = { value: opts.country };
  }
  return {
    version: '1.0',
    context: { eventType: 'viewer-request' },
    viewer: { ip: '198.51.100.1' },
    request: {
      method: opts.method ?? 'GET',
      uri: opts.uri ?? '/dns-query',
      querystring: dns === undefined ? {} : { dns: { value: dns } },
      headers,
      cookies: {},
    },
  };
}

// The bundled dns-packet types omit rcode and flag fields, so decode loosely.
function decode(response: any): any {
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type'].value).toBe('application/dns-message');
  expect(response.body.encoding).toBe('base64');
  return dnsPacket.decode(Buffer.from(response.body.data, 'base64'));
}

const handler = loadHandler();

test('fits within the CloudFront Functions 10 KB code size limit', () => {
  expect(fs.statSync(FUNCTION_FILE).size).toBeLessThan(10 * 1024);
});

test('answers the default A record when the viewer country has no override', async () => {
  const res = await handler(event(encodeQuery('api.example.com', 'A', 4242), { country: 'US' }));
  const msg = decode(res);
  expect(msg.id).toBe(4242);
  expect(msg.rcode).toBe('NOERROR');
  expect(msg.flag_rd).toBe(true);
  expect(msg.answers).toEqual([expect.objectContaining({ type: 'A', name: 'api.example.com', ttl: 30, data: '203.0.113.10' })]);
  expect(res.headers['cache-control'].value).toBe('private, max-age=30');
});

test('answers the country-specific record for the viewer country', async () => {
  const msg = decode(await handler(event(encodeQuery('api.example.com'), { country: 'SG' })));
  expect(msg.answers!.map((a: any) => a.data).sort()).toEqual(['203.0.113.40', '203.0.113.41']);
});

test('shuffles the order of multiple addresses across queries', async () => {
  const firstAddresses = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const msg = decode(await handler(event(encodeQuery('api.example.com'), { country: 'SG' })));
    expect(msg.answers).toHaveLength(2);
    firstAddresses.add(msg.answers[0].data);
  }
  expect(firstAddresses).toEqual(new Set(['203.0.113.40', '203.0.113.41']));
});

test('answers AAAA records and matches names case-insensitively', async () => {
  const msg = decode(await handler(event(encodeQuery('API.Example.COM', 'AAAA'), { country: 'JP' })));
  expect(msg.answers).toEqual([expect.objectContaining({ type: 'AAAA', data: '2001:db8::20' })]);
});

test('does not fall back to default AAAA when the country override has only A', async () => {
  const msg = decode(await handler(event(encodeQuery('api.example.com', 'AAAA'), { country: 'HK' })));
  expect(msg.rcode).toBe('NOERROR');
  expect(msg.answers).toEqual([]);
});

test('uses the per-record TTL', async () => {
  const msg = decode(await handler(event(encodeQuery('login.example.com'))));
  expect(msg.answers![0].ttl).toBe(300);
});

test('returns an empty NOERROR answer for other record types on an allowlisted name', async () => {
  const res = await handler(event(encodeQuery('api.example.com', 'MX')));
  const msg = decode(res);
  expect(msg.rcode).toBe('NOERROR');
  expect(msg.answers).toEqual([]);
  expect(msg.questions).toEqual([expect.objectContaining({ name: 'api.example.com', type: 'MX' })]);
});

test('refuses names that are not on the allowlist', async () => {
  const res = await handler(event(encodeQuery('www.example.org')));
  const msg = decode(res);
  expect(msg.rcode).toBe('REFUSED');
  expect(msg.answers).toEqual([]);
  expect(res.headers['cache-control'].value).toBe('no-store');
});

test('refuses names containing characters that could collide with store keys', async () => {
  const msg = decode(await handler(event(encodeQuery('api.example.com#jp'))));
  expect(msg.rcode).toBe('REFUSED');
});

test('returns FORMERR for a truncated question', async () => {
  const wire = dnsPacket.encode({ type: 'query', id: 7, questions: [{ type: 'A', name: 'api.example.com' }] });
  const msg = decode(await handler(event(wire.subarray(0, wire.length - 3).toString('base64url'))));
  expect(msg.id).toBe(7);
  expect(msg.rcode).toBe('FORMERR');
});

test('returns FORMERR for a compression pointer in the question', async () => {
  const wire = Buffer.from([0, 9, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]);
  const msg = decode(await handler(event(wire.toString('base64url'))));
  expect(msg.rcode).toBe('FORMERR');
});

test('rejects non-GET methods with 405', async () => {
  const res = await handler(event(encodeQuery('api.example.com'), { method: 'POST' }));
  expect(res.statusCode).toBe(405);
  expect(res.headers.allow.value).toBe('GET');
});

test('rejects other paths with 404', async () => {
  const res = await handler(event(encodeQuery('api.example.com'), { uri: '/' }));
  expect(res.statusCode).toBe(404);
});

test('rejects a missing or undersized dns parameter with 400', async () => {
  expect((await handler(event(undefined))).statusCode).toBe(400);
  expect((await handler(event('AAAA'))).statusCode).toBe(400);
});

test('rejects DNS responses sent as queries with 400', async () => {
  const wire = dnsPacket.encode({ type: 'response', id: 1, questions: [{ type: 'A', name: 'api.example.com' }] });
  expect((await handler(event(wire.toString('base64url')))).statusCode).toBe(400);
});

test('records the DNS result in the access log data field', async () => {
  await handler(event(encodeQuery('api.example.com', 'AAAA'), { country: 'JP' }));
  expect(logged.at(-1)).toBe('NOERROR:api.example.com:AAAA:JP');
  await handler(event(encodeQuery('api.example.com'), { country: 'US' }));
  expect(logged.at(-1)).toBe('NOERROR:api.example.com:A:default');
  await handler(event(encodeQuery('www.example.org')));
  expect(logged.at(-1)).toBe('REFUSED:www.example.org:A:-');
});

test('does not log names that fail hostname validation', async () => {
  await handler(event(encodeQuery('bad#name.example.com')));
  expect(logged.at(-1)).toBe('REFUSED:-:-:-');
});

test('answers every country in a country group', async () => {
  for (const country of ['JP', 'KR', 'TW']) {
    const msg = decode(await handler(event(encodeQuery('api.example.com'), { country })));
    expect(msg.answers[0].data).toBe('203.0.113.20');
  }
});

test('accepts a base64url parameter sent with padding', async () => {
  const padded = encodeQuery('api.example.com') + '==';
  expect(decode(await handler(event(padded))).rcode).toBe('NOERROR');
  expect(decode(await handler(event(encodeQuery('api.example.com') + '%3D'))).rcode).toBe('NOERROR');
});

test('answers queries that carry an EDNS(0) OPT record', async () => {
  const wire = dnsPacket.encode({
    type: 'query',
    id: 0,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name: 'api.example.com' }],
    additionals: [{ type: 'OPT', name: '.', udpPayloadSize: 4096, flags: 0, options: [{ code: 12, length: 16 }] } as any],
  });
  const msg = decode(await handler(event(wire.toString('base64url'))));
  expect(msg.rcode).toBe('NOERROR');
  expect(msg.answers[0].data).toBe('203.0.113.10');
});

test('echoes the question with its original letter case (DNS 0x20)', async () => {
  const msg = decode(await handler(event(encodeQuery('aPi.eXaMpLe.CoM'))));
  expect(msg.questions[0].name).toBe('aPi.eXaMpLe.CoM');
  expect(msg.answers[0].data).toBe('203.0.113.10');
});

test('returns a well-formed HTTP response for random input without throwing', async () => {
  // Deterministic pseudo-random bytes, so failures are reproducible.
  let seed = 42;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 256;
  const valid = dnsPacket.encode({ type: 'query', id: 1, questions: [{ type: 'A', name: 'api.example.com' }] });
  for (let i = 0; i < 2000; i++) {
    // Half fully random, half a valid query with a few corrupted bytes.
    const bytes = i % 2 === 0 ? Buffer.from(Array.from({ length: next() % 64 }, next)) : Buffer.from(valid);
    if (i % 2 === 1) {
      for (let j = 0; j < 3; j++) bytes[next() % bytes.length] = next();
    }
    const res = await handler(event(bytes.toString('base64url')));
    expect([200, 400]).toContain(res.statusCode);
  }
});
