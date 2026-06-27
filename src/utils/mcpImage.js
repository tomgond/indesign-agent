import fs from 'node:fs';
import { imageInfo } from './imageInfo.js';

export function buildMcpImagePayload(filePath, mimeType = null) {
    const info = imageInfo(filePath);
    const resolvedMimeType = mimeType || info.mimeType;
    return {
        mimeType: resolvedMimeType,
        data: fs.readFileSync(filePath).toString('base64')
    };
}
