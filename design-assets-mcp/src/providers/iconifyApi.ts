export async function searchIconifyApi(query: string, maxResults = 20, baseUrl = 'https://api.iconify.design') {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(maxResults));
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Iconify API search failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { icons?: Array<{ provider?: string; prefix?: string; name?: string; title?: string; tags?: string[] }> };
  return (data.icons || []).slice(0, maxResults).map((icon) => ({
    candidateId: `iconify-api:${icon.prefix ?? 'unknown'}:${icon.name ?? 'unknown'}`,
    name: icon.name ?? 'unknown',
    source: 'iconify-api' as const,
    providerAssetId: `${icon.prefix ?? 'unknown'}:${icon.name ?? 'unknown'}`,
    style: undefined,
    tags: icon.tags || [],
    license: undefined,
    confidence: 0.6,
    materializable: false,
    warnings: ['Remote Iconify API candidates are discovery-only in this build.'],
    _remote: true
  }));
}
