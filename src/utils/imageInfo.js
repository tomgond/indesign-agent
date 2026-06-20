import fs from 'node:fs';

export function imageInfo(filePath) {
    const b = fs.readFileSync(filePath);
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { mimeType: 'image/png', widthPx: b.readUInt32BE(16), heightPx: b.readUInt32BE(20) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
        for (let i = 2; i < b.length - 9;) {
            if (b[i] !== 0xff) break;
            const marker = b[i + 1], len = b.readUInt16BE(i + 2);
            if (marker >= 0xc0 && marker <= 0xc3) return { mimeType: 'image/jpeg', widthPx: b.readUInt16BE(i + 7), heightPx: b.readUInt16BE(i + 5) };
            i += 2 + len;
        }
    }
    return { mimeType: 'application/octet-stream', widthPx: null, heightPx: null };
}
