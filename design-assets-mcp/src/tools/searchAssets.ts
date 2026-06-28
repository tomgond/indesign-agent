import { searchTabler } from '../providers/tabler.js';
import { searchIconifyLocal } from '../providers/iconifyLocal.js';
import { searchIconifyApi } from '../providers/iconifyApi.js';
import { searchAssetsInputSchema } from '../schemas/toolSchemas.js';
import { fail, ok } from './shared.js';

export async function searchAssets(input: unknown, config: { iconifyApiBaseUrl: string }) {
  const parsed = searchAssetsInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('INVALID_INPUT', parsed.error.message);
  }

  const value = parsed.data;
  const maxResults = value.maxResults ?? 20;
  const preferredSources = value.preferredSources ?? ['tabler', 'iconify-local'];
  const warnings: string[] = [];
  const candidates: Array<Record<string, unknown>> = [];

  if (preferredSources.includes('tabler')) {
    candidates.push(...searchTabler(value.query, maxResults - candidates.length).map(({ _rawSvg, ...candidate }) => candidate));
  }
  if (candidates.length < maxResults && preferredSources.includes('iconify-local')) {
    candidates.push(...searchIconifyLocal(value.query, maxResults - candidates.length).map(({ _rawSvg, ...candidate }) => candidate));
  }
  if (value.allowRemote && candidates.length < maxResults && preferredSources.includes('iconify-api')) {
    try {
      candidates.push(...(await searchIconifyApi(value.query, maxResults - candidates.length, config.iconifyApiBaseUrl)).map(({ _remote, ...candidate }) => candidate));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'Iconify API search failed');
    }
  }

  return ok({
    query: value.query,
    candidates,
    warnings
  });
}
