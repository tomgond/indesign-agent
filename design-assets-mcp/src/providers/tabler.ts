import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tablerIconsPath = require.resolve('@iconify-json/tabler/icons.json');
const tablerIcons = JSON.parse(fs.readFileSync(tablerIconsPath, 'utf8')) as {
  icons: Record<string, { body: string; width?: number; height?: number; tags?: string[] }>;
  info?: { license?: { title?: string; url?: string } };
};

function matchesQuery(name: string, query: string) {
  const needle = query.toLowerCase();
  return name.toLowerCase().includes(needle) || name.split('-').some((part) => part.includes(needle));
}

export function searchTabler(query: string, maxResults = 20) {
  const results = [];
  for (const [name, icon] of Object.entries(tablerIcons.icons)) {
    if (!matchesQuery(name, query)) continue;
    results.push({
      candidateId: `tabler:${name}`,
      name,
      source: 'tabler' as const,
      providerAssetId: name,
      style: 'outline',
      tags: [name, ...name.split('-')],
      license: {
        name: 'MIT',
        url: tablerIcons.info?.license?.url ?? 'https://github.com/tabler/tabler-icons/blob/master/LICENSE',
        attributionRequired: false,
        commercialUseAllowed: true
      },
      confidence: 0.95,
      warnings: [],
      _rawSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width ?? 24} ${icon.height ?? 24}">${icon.body}</svg>`
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function getTablerSvg(providerAssetId: string) {
  const icon = tablerIcons.icons[providerAssetId];
  if (!icon) throw new Error(`Unknown Tabler icon: ${providerAssetId}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width ?? 24} ${icon.height ?? 24}">${icon.body}</svg>`;
}
