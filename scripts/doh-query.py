#!/usr/bin/env python3
"""Minimal RFC 8484 DNS over HTTPS client (GET method), standard library only.

Usage: python3 scripts/doh-query.py <doh-endpoint-url> <hostname> [A|AAAA]
"""
import base64
import ipaddress
import struct
import sys
import urllib.parse
import urllib.request

TYPES = {"A": 1, "AAAA": 28}
RCODES = {0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED"}


def build_query(hostname, qtype):
    # ID 0 per RFC 8484 section 4.1 (cache friendly); RD set; one question.
    header = struct.pack(">HHHHHH", 0, 0x0100, 1, 0, 0, 0)
    name = b"".join(bytes([len(label)]) + label.encode("ascii") for label in hostname.rstrip(".").split("."))
    return header + name + b"\x00" + struct.pack(">HH", qtype, 1)


def skip_name(msg, offset):
    while True:
        length = msg[offset]
        if length == 0:
            return offset + 1
        if length & 0xC0 == 0xC0:
            return offset + 2
        offset += 1 + length


def parse_answers(msg):
    _, flags, qdcount, ancount, _, _ = struct.unpack(">HHHHHH", msg[:12])
    offset = 12
    for _ in range(qdcount):
        offset = skip_name(msg, offset) + 4
    answers = []
    for _ in range(ancount):
        offset = skip_name(msg, offset)
        rtype, _, ttl, rdlength = struct.unpack(">HHIH", msg[offset:offset + 10])
        rdata = msg[offset + 10:offset + 10 + rdlength]
        offset += 10 + rdlength
        if rtype in (1, 28):
            answers.append((str(ipaddress.ip_address(rdata)), ttl))
    return RCODES.get(flags & 0x0F, str(flags & 0x0F)), answers


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    endpoint, hostname = sys.argv[1], sys.argv[2]
    qtype = sys.argv[3].upper() if len(sys.argv) == 4 else "A"
    # DoH runs over HTTPS only; this also keeps urlopen away from file:// and other schemes.
    if urllib.parse.urlsplit(endpoint).scheme != "https":
        sys.exit("The DoH endpoint must be an https:// URL")
    if qtype not in TYPES:
        sys.exit(f"Record type must be one of: {', '.join(TYPES)}")
    dns = base64.urlsafe_b64encode(build_query(hostname, TYPES[qtype])).rstrip(b"=").decode()
    request = urllib.request.Request(f"{endpoint}?dns={dns}", headers={"Accept": "application/dns-message"})
    with urllib.request.urlopen(request, timeout=5) as response:  # nosemgrep: dynamic-urllib-use-detected -- scheme restricted to https above
        rcode, answers = parse_answers(response.read())
        print(f"{hostname} {qtype} -> {rcode}  (Cache-Control: {response.headers.get('Cache-Control')})")
        for address, ttl in answers:
            print(f"  {address}  ttl={ttl}")


if __name__ == "__main__":
    main()
