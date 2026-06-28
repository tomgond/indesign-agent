import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function searchInCollection(collection: string, query: string, maxResults: number) {
  const iconJsonPath = require.resolve(`@iconify-json/${collection}/icons.json`);
  const data = JSON.parse(fs.readFileSync(iconJsonPath, 'utf8')) as {
    prefix?: string;
    icons?: Record<string, { body: string; width?: number; height?: number; tags?: string[] }>;
    info?: { license?: { title?: string; url?: string } };
  };
  const results = [];
  for (const [name, icon] of Object.entries(data.icons || {})) {
    const haystack = `${collection}:${name}`.toLowerCase();
    if (!haystack.includes(query.toLowerCase())) continue;
    results.push({
      candidateId: `iconify:${collection}:${name}`,
      name,
      source: 'iconify-local' as const,
      providerAssetId: `${collection}:${name}`,
      style: undefined,
      tags: [collection, name, ...name.split('-')],
      license: {
        name: data.info?.license?.title,
        url: data.info?.license?.url,
        attributionRequired: false,
        commercialUseAllowed: true
      },
      confidence: 0.8,
      warnings: [],
      _rawSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width ?? 24} ${icon.height ?? 24}">${icon.body}</svg>`
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function searchIconifyLocal(query: string, maxResults = 20, preferredCollections: string[] = []) {
  const root = path.dirname(require.resolve('@iconify-json/tabler/package.json'));
  const jsonRoot = path.join(root, '..');
  const collections = new Set<string>(preferredCollections);

  if (collections.size === 0) {
    for (const entry of fs.readdirSync(jsonRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('@')) continue;
      if (entry.isDirectory() && entry.name) collections.add(entry.name);
    }
  }

  const results = [];
  for (const collection of collections) {
    if (collection === 'tabler') continue;
    try {
      results.push(...searchInCollection(collection, query, maxResults - results.length));
      if (results.length >= maxResults) break;
    } catch {
      continue;
    }
  }
  return results;
}

export function getIconifyLocalSvg(providerAssetId: string) {
  const [collection, name] = providerAssetId.split(':');
  if (!collection || !name) throw new Error(`Invalid Iconify providerAssetId: ${providerAssetId}`);
  const iconJsonPath = require.resolve(`@iconify-json/${collection}/icons.json`);
  const data = JSON.parse(fs.readFileSync(iconJsonPath, 'utf8')) as {
    icons?: Record<string, { body: string; width?: number; height?: number }>;
  };
  const icon = data.icons?.[name];
  if (!icon) throw new Error(`Unknown Iconify icon: ${providerAssetId}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width ?? 24} ${icon.height ?? 24}">${icon.body}</svg>`;
}
