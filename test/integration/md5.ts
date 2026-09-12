/**
 * RFC 1321 MD5, for the digest-authentication test's expected values.
 *
 * Deliberately a second implementation rather than the one SIP.js uses: the test's job is to
 * check that the UA's Authorization response is the digest the RFC prescribes over the
 * provisioned ha1, and reusing the implementation under test could only agree with itself.
 * (Node's own `crypto` would do the same job, but the project types exclude @types/node.)
 */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

const rotl = (x: number, c: number): number => ((x << c) | (x >>> (32 - c))) >>> 0;
/** A 32-bit word as MD5 prints it: little-endian hex. */
const hexLE = (n: number): string =>
  [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, "0")).join("");

export function md5(input: string): string {
  const bytes = [...new TextEncoder().encode(input)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  for (let i = 0; i < 8; i++) {
    bytes.push(Math.floor(bitLength / 2 ** (8 * i)) & 0xff);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const o = chunk + i * 4;
      words[i] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + SINES[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, SHIFTS[i])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(hexLE).join("");
}
