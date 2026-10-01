import * as fs from 'fs';
import * as net from 'net';

/** One set of addresses for a hostname, as written in config/records.json. */
export interface RecordSet {
  readonly A?: string[];
  readonly AAAA?: string[];
  readonly ttl?: number;
}

export interface RecordsConfig {
  readonly defaultTtlSeconds: number;
  /**
   * hostname -> location -> record set. A location is "default" or one or more
   * comma-separated ISO 3166-1 alpha-2 country codes, such as "JP" or "JP,KR,TW".
   */
  readonly records: Record<string, Record<string, RecordSet>>;
}

/** A key/value pair in the format CloudFront KeyValueStore imports and serves. */
export interface KvsEntry {
  readonly key: string;
  readonly value: string;
}

// KeyValueStore limits: 512-byte keys, 1 KB values.
const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 1024;
// Keep in sync with HOSTNAME in cloudfront-functions/doh-resolver.js.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const COUNTRY = /^[A-Z]{2}$/;

export function loadRecordsConfig(file: string): RecordsConfig {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as RecordsConfig;
}

/**
 * Validates the human-readable config and converts it to KeyValueStore entries.
 * Addresses are pre-encoded to DNS wire-format hex so the edge function only has
 * to copy bytes, and bad input fails at synth time instead of at query time.
 */
export function toKvsEntries(config: RecordsConfig): KvsEntry[] {
  const entries: KvsEntry[] = [];
  for (const [hostname, byLocation] of Object.entries(config.records)) {
    if (!HOSTNAME.test(hostname)) {
      throw new Error(`Invalid hostname "${hostname}": use lowercase letters, digits, "-", "_" and no trailing dot`);
    }
    if (!byLocation.default) {
      throw new Error(`"${hostname}" needs a "default" record set`);
    }
    const seen = new Set<string>();
    for (const [locationList, recordSet] of Object.entries(byLocation)) {
      const ttl = recordSet.ttl ?? config.defaultTtlSeconds;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
        throw new Error(`"${hostname}" "${locationList}": ttl must be an integer between 1 and 86400`);
      }
      const value = JSON.stringify({
        ttl,
        A: (recordSet.A ?? []).map((ip) => encodeIpv4(ip, hostname)),
        AAAA: (recordSet.AAAA ?? []).map((ip) => encodeIpv6(ip, hostname)),
      });
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) {
        throw new Error(`"${hostname}" "${locationList}": too many addresses for one KeyValueStore value (1 KB)`);
      }
      for (const location of locationList.split(',').map((l) => l.trim())) {
        if (location !== 'default' && !COUNTRY.test(location)) {
          throw new Error(`"${hostname}": "${location}" is not "default" or an uppercase ISO 3166-1 alpha-2 country code`);
        }
        if (seen.has(location)) {
          throw new Error(`"${hostname}": "${location}" appears in more than one record set`);
        }
        seen.add(location);
        const key = `${hostname}#${location}`;
        if (Buffer.byteLength(key) > MAX_KEY_BYTES) {
          throw new Error(`"${key}" exceeds the KeyValueStore key size limit (512 bytes)`);
        }
        entries.push({ key, value });
      }
    }
  }
  return entries;
}

function encodeIpv4(ip: string, hostname: string): string {
  if (!net.isIPv4(ip)) {
    throw new Error(`"${hostname}": "${ip}" is not an IPv4 address`);
  }
  return Buffer.from(ip.split('.').map(Number)).toString('hex');
}

function encodeIpv6(ip: string, hostname: string): string {
  if (!net.isIPv6(ip) || ip.includes('.')) {
    throw new Error(`"${hostname}": "${ip}" is not an IPv6 address in hex notation`);
  }
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const zeros = ip.includes('::') ? 8 - headGroups.length - tailGroups.length : 0;
  const groups = [...headGroups, ...Array<string>(zeros).fill('0'), ...tailGroups];
  return groups.map((group) => group.padStart(4, '0')).join('').toLowerCase();
}
