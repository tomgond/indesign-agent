import os from 'node:os';
import path from 'node:path';

export type DesignAssetsConfig = {
  cacheDir: string;
  recraftLedgerPath: string;
  recraftApiToken?: string;
  recraftDailyCapUsd: number;
  recraftDefaultMaxCostUsd: number;
  recraftApiBaseUrl: string;
  iconifyApiBaseUrl: string;
  vtracerCommand: string;
  vtracerTimeoutMs: number;
  allowedInputRoots: string[];
};

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(value: string) {
  return value.replace(/^~(?=$|\/)/, os.homedir());
}

export function loadConfig(overrides: Partial<DesignAssetsConfig> = {}): DesignAssetsConfig {
  const cacheDir = overrides.cacheDir
    ?? process.env.DESIGN_ASSETS_CACHE_DIR
    ?? path.join(os.homedir(), '.cache', 'design-assets-mcp');

  return {
    cacheDir,
    recraftLedgerPath: overrides.recraftLedgerPath
      ?? process.env.RECRAFT_LEDGER_PATH
      ?? path.join(cacheDir, 'recraft-ledger.jsonl'),
    recraftApiToken: overrides.recraftApiToken ?? process.env.RECRAFT_API_TOKEN,
    recraftDailyCapUsd: overrides.recraftDailyCapUsd ?? readNumber(process.env.RECRAFT_DAILY_CAP_USD, 1.0),
    recraftDefaultMaxCostUsd: overrides.recraftDefaultMaxCostUsd ?? readNumber(process.env.RECRAFT_DEFAULT_MAX_COST_USD, 0.1),
    recraftApiBaseUrl: overrides.recraftApiBaseUrl ?? process.env.RECRAFT_API_BASE_URL ?? 'https://external.api.recraft.ai',
    iconifyApiBaseUrl: overrides.iconifyApiBaseUrl ?? process.env.ICONIFY_API_BASE_URL ?? 'https://api.iconify.design',
    vtracerCommand: overrides.vtracerCommand ?? process.env.VTRACER_COMMAND ?? 'vtracer',
    vtracerTimeoutMs: overrides.vtracerTimeoutMs ?? readNumber(process.env.VTRACER_TIMEOUT_MS, 60_000),
    allowedInputRoots: (overrides.allowedInputRoots ?? (process.env.DESIGN_ASSETS_ALLOWED_INPUT_ROOTS?.split(path.delimiter) ?? []))
      .filter(Boolean)
      .map(expandHome)
  };
}
