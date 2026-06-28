import crypto from 'node:crypto';

export function hashSvg(svgText: string) {
  const bytes = Buffer.from(svgText, 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function bytesSha256(bytes: Uint8Array) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
