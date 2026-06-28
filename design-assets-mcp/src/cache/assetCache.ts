import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssetPayload } from '../schemas/assetPayload.js';

export function cacheDir(baseDir?: string) {
  return baseDir ?? process.env.DESIGN_ASSETS_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'design-assets-mcp');
}

export function ensureCacheDir(baseDir?: string) {
  const dir = cacheDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetCachePath(sha256: string, baseDir?: string) {
  return path.join(ensureCacheDir(baseDir), 'assets', sha256.slice(0, 2), `${sha256}.json`);
}

export function writeCachedAsset(asset: AssetPayload, baseDir?: string) {
  const filePath = assetCachePath(asset.sha256, baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(asset, null, 2)}\n`, 'utf8');
  return filePath;
}

export function readCachedAssets(baseDir?: string) {
  const root = path.join(ensureCacheDir(baseDir), 'assets');
  if (!fs.existsSync(root)) return [];
  const entries: string[] = [];
  for (const bucket of fs.readdirSync(root)) {
    const bucketPath = path.join(root, bucket);
    if (!fs.statSync(bucketPath).isDirectory()) continue;
    for (const file of fs.readdirSync(bucketPath)) {
      if (file.endsWith('.json')) entries.push(path.join(bucketPath, file));
    }
  }
  return entries;
}

export function listCachedAssets(baseDir?: string, source?: string, limit = 50) {
  const files = readCachedAssets(baseDir);
  const items = [];
  for (const file of files) {
    try {
      const asset = JSON.parse(fs.readFileSync(file, 'utf8')) as AssetPayload;
      if (source && asset.metadata?.source !== source) continue;
      items.push({
        assetId: asset.assetId,
        sha256: asset.sha256,
        source: asset.metadata.source,
        file,
        createdAt: asset.metadata.createdAt
      });
      if (items.length >= limit) break;
    } catch {
      continue;
    }
  }
  return items;
}
