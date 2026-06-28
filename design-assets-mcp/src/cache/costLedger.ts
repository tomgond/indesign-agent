import fs from 'node:fs';
import path from 'node:path';

import { ensureCacheDir } from './assetCache.js';

export function appendLedgerEntry(entry: Record<string, unknown>, ledgerPath: string) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return ledgerPath;
}

export function dailyUsdSpent(ledgerPath: string, day = new Date().toISOString().slice(0, 10)) {
  if (!fs.existsSync(ledgerPath)) return 0;
  let total = 0;
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.at === 'string' && record.at.startsWith(day) && typeof record.actualUsd === 'number') {
        total += record.actualUsd;
      }
    } catch {
      continue;
    }
  }
  return total;
}

export function ensureLedgerPath(ledgerPath: string) {
  ensureCacheDir(path.dirname(ledgerPath));
  return ledgerPath;
}
