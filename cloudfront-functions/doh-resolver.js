import cf from 'cloudfront';

// DNS over HTTPS (RFC 8484, GET method) resolver for an allowlist of
// application hostnames, answered entirely at the edge. Records live in the associated
// CloudFront KeyValueStore under "<name>#<country>" and "<name>#default"
// (see lib/records.ts). Any name without a record is answered with REFUSED,
// so this endpoint doesn't act as an open resolver.
//
// Each DNS answer is recorded in the viewer-request-log-data field of the
// distribution's access logs as "<rcode>:<name>:<type>:<record set>", for
// example "NOERROR:api.example.com:A:JP".
const kvs = cf.kvs();

const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;
const RCODE_NOERROR = 0;
const RCODE_FORMERR = 1;
const RCODE_NOTIMP = 4;
const RCODE_REFUSED = 5;
const RCODE_NAMES = { 1: 'FORMERR', 4: 'NOTIMP', 5: 'REFUSED' };
const TYPE_NAMES = { 1: 'A', 28: 'AAAA' };
const HEADER_BYTES = 12;
const MAX_QUERY_BYTES = 512;
// Keep in sync with HOSTNAME in lib/records.ts (functions can't import modules).
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

async function handler(event) {
  const request = event.request;

  if (request.uri !== '/dns-query') {
    return httpError(404, 'Not Found');
  }
  if (request.method !== 'GET') {
    const notAllowed = httpError(405, 'Method Not Allowed');
    notAllowed.headers.allow = { value: 'GET' };
    return notAllowed;
  }

  const param = request.querystring.dns;
  if (!param || !param.value) {
    return httpError(400, 'Missing dns query parameter');
  }
  let query;
  try {
    // RFC 8484 omits padding, but tolerate clients that send it.
    query = Buffer.from(param.value.replace(/(=|%3D)+$/i, ''), 'base64url');
  } catch (e) {
    return httpError(400, 'dns parameter is not base64url');
  }
  if (query.length < HEADER_BYTES || query.length > MAX_QUERY_BYTES) {
    return httpError(400, 'Invalid DNS message length');
  }

  const flags = query.readUInt16BE(2);
  if (flags & 0x8000) {
    return httpError(400, 'DNS message is not a query');
  }
  if (((flags >> 11) & 0x0f) !== 0) {
    return dnsError(query, 0, RCODE_NOTIMP, null);
  }

  const question = parseQuestion(query);
  if (question === null) {
    return dnsError(query, 0, RCODE_FORMERR, null);
  }
  if (question.qclass !== CLASS_IN || !HOSTNAME.test(question.name)) {
    // Not logged by name: it may contain arbitrary bytes.
    return dnsError(query, question.end, RCODE_REFUSED, null);
  }

  const countryHeader = request.headers['cloudfront-viewer-country'];
  const country = countryHeader ? countryHeader.value : '';

  const found = await lookup(question.name, country);
  if (found === null) {
    return dnsError(query, question.end, RCODE_REFUSED, question);
  }
  const entry = found.entry;

  // A name on the allowlist with no records of the requested type (for
  // example an HTTPS or MX query) gets an empty NOERROR answer.
  let rdata = [];
  if (question.qtype === TYPE_A && entry.A) {
    rdata = entry.A;
  } else if (question.qtype === TYPE_AAAA && entry.AAAA) {
    rdata = entry.AAAA;
  }
  // Shuffle so clients that connect to the first address spread across all of
  // them, the way round-robin DNS does.
  const answers = [];
  for (let i = 0; i < rdata.length; i++) {
    answers.push(Buffer.from(rdata[i], 'hex'));
  }
  for (let i = answers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = answers[i];
    answers[i] = answers[j];
    answers[j] = swap;
  }
  const ttl = entry.ttl;
  logAnswer('NOERROR', question, found.location);
  return dnsResponse(buildMessage(query, question.end, RCODE_NOERROR, answers, ttl, question.qtype), ttl);
}

// A country-specific entry replaces the default entry entirely, so a viewer
// isn't handed IPv4 and IPv6 addresses that point at different regions.
// get() rejects when a key doesn't exist, which is the expected path for
// countries without an override. A value that fails to parse is treated the
// same way; sync-records validates every value before writing it.
async function lookup(name, country) {
  if (country) {
    try {
      return { entry: await kvs.get(name + '#' + country, { format: 'json' }), location: country };
    } catch (e) {
      // No country-specific entry; fall through to the default.
    }
  }
  try {
    return { entry: await kvs.get(name + '#default', { format: 'json' }), location: 'default' };
  } catch (e) {
    return null;
  }
}

function dnsError(query, questionEnd, rcode, question) {
  logAnswer(RCODE_NAMES[rcode], question, '-');
  return dnsResponse(buildMessage(query, questionEnd, rcode, [], 0), 0);
}

function logAnswer(rcode, question, location) {
  const name = question ? question.name : '-';
  const type = question ? TYPE_NAMES[question.qtype] || String(question.qtype) : '-';
  cf.logCustomData(rcode + ':' + name + ':' + type + ':' + location);
}

// Parses the single question in a query. Returns null for anything malformed,
// including compression pointers, which a stub resolver never sends in a query.
function parseQuestion(buf) {
  if (buf.readUInt16BE(4) !== 1) {
    return null;
  }
  const labels = [];
  let offset = HEADER_BYTES;
  let wireLength = 1;
  while (true) {
    if (offset >= buf.length) {
      return null;
    }
    const len = buf[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    wireLength += len + 1;
    if (len > 63 || wireLength > 255 || offset + 1 + len > buf.length) {
      return null;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len).toLowerCase());
    offset += 1 + len;
  }
  if (labels.length === 0 || offset + 4 > buf.length) {
    return null;
  }
  return {
    name: labels.join('.'),
    qtype: buf.readUInt16BE(offset),
    qclass: buf.readUInt16BE(offset + 2),
    end: offset + 4,
  };
}

// Builds a response that echoes the query ID, RD bit, and question section.
// questionEnd of 0 omits the question (used when it could not be parsed).
// Answers reuse the question name through a compression pointer to offset 12.
function buildMessage(query, questionEnd, rcode, answers, ttl, qtype) {
  const questionBytes = questionEnd > 0 ? questionEnd - HEADER_BYTES : 0;
  let size = HEADER_BYTES + questionBytes;
  for (let i = 0; i < answers.length; i++) {
    size += 12 + answers[i].length;
  }
  const out = Buffer.alloc(size);
  out.writeUInt16BE(query.readUInt16BE(0), 0);
  // QR=1, AA=1, RD copied from the query, RA=1.
  out.writeUInt16BE(0x8000 | 0x0400 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | rcode, 2);
  out.writeUInt16BE(questionBytes > 0 ? 1 : 0, 4);
  out.writeUInt16BE(answers.length, 6);
  for (let i = 0; i < questionBytes; i++) {
    out[HEADER_BYTES + i] = query[HEADER_BYTES + i];
  }
  let offset = HEADER_BYTES + questionBytes;
  for (let i = 0; i < answers.length; i++) {
    out.writeUInt16BE(0xc00c, offset);
    out.writeUInt16BE(qtype, offset + 2);
    out.writeUInt16BE(CLASS_IN, offset + 4);
    out.writeUInt32BE(ttl, offset + 6);
    out.writeUInt16BE(answers[i].length, offset + 10);
    for (let j = 0; j < answers[i].length; j++) {
      out[offset + 12 + j] = answers[i][j];
    }
    offset += 12 + answers[i].length;
  }
  return out;
}

// Answers vary by viewer country, so they are only cacheable by the client
// itself ("private"), for no longer than the record TTL (RFC 8484 section 5.1).
function dnsResponse(message, ttl) {
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: 'application/dns-message' },
      'cache-control': { value: ttl > 0 ? 'private, max-age=' + ttl : 'no-store' },
    },
    body: { encoding: 'base64', data: message.toString('base64') },
  };
}

function httpError(statusCode, message) {
  return {
    statusCode: statusCode,
    statusDescription: message,
    headers: {
      'content-type': { value: 'text/plain' },
      'cache-control': { value: 'no-store' },
    },
    body: message,
  };
}
