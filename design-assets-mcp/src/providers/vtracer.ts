import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type { DesignAssetsConfig } from '../config.js';
import { sanitizeSvg } from '../svg/sanitizeSvg.js';
import { bytesSha256 } from '../svg/hash.js';
import { renderPreview } from '../svg/renderPreview.js';
import { step } from '../cache/provenance.js';

export type VtracerRequest = {
  inputPath?: string;
  rasterBase64?: string;
  rasterMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  mode?: 'poster' | 'photo' | 'bw' | 'line-art';
  tracing?: Record<string, unknown>;
  outputEncoding?: 'svgText' | 'base64';
  includePreview?: boolean;
};

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('VTRACER_TIMEOUT'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function isInsideRoot(candidate: string, root: string) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function vectorizeWithVTracer(config: DesignAssetsConfig, input: VtracerRequest) {
  const hasInputPath = Boolean(input.inputPath);
  const hasBase64 = Boolean(input.rasterBase64);
  if (hasInputPath === hasBase64) {
    return { success: false, error: { code: 'VTRACER_BAD_INPUT', message: 'Provide exactly one of inputPath or rasterBase64' } };
  }

  try {
    await runCommand(config.vtracerCommand, ['--version'], 5000);
  } catch {
    return { success: false, error: { code: 'VTRACER_UNAVAILABLE', message: 'vtracer is not available on this system' } };
  }

  let rasterPath = input.inputPath ?? null;
  let tempDir = null;
  if (input.rasterBase64) {
    tempDir = fs.mkdtempSync('/tmp/design-assets-mcp-');
    rasterPath = `${tempDir}/input.${input.rasterMimeType?.split('/')[1] ?? 'png'}`;
    const rasterBytes = Buffer.from(input.rasterBase64, 'base64');
    if (rasterBytes.length > 5 * 1024 * 1024) {
      return { success: false, error: { code: 'RASTER_TOO_LARGE', message: 'Raster input exceeds size cap' } };
    }
    fs.writeFileSync(rasterPath, rasterBytes);
  } else if (input.inputPath) {
    const allowedRoots = config.allowedInputRoots.length > 0 ? config.allowedInputRoots : [config.cacheDir];
    if (!allowedRoots.some((root) => isInsideRoot(input.inputPath!, root))) {
      return { success: false, error: { code: 'INPUT_PATH_NOT_ALLOWED', message: 'inputPath must stay inside an allowed input root' } };
    }
    if (!fs.existsSync(input.inputPath)) {
      return { success: false, error: { code: 'INPUT_PATH_MISSING', message: 'inputPath does not exist' } };
    }
    if (fs.statSync(input.inputPath).size > 5 * 1024 * 1024) {
      return { success: false, error: { code: 'INPUT_TOO_LARGE', message: 'inputPath exceeds size cap' } };
    }
  }

  const traceArgs = [rasterPath!, '--output', '-', '--mode', input.mode ?? 'poster'];
  const traced = await runCommand(config.vtracerCommand, traceArgs, config.vtracerTimeoutMs);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (traced.code !== 0) {
    return { success: false, error: { code: 'VTRACER_FAILED', message: traced.stderr || 'vtracer failed' } };
  }

  const sanitized = sanitizeSvg(traced.stdout, { maxBytes: 2 * 1024 * 1024 });
  const sha256 = bytesSha256(Buffer.from(sanitized.svgText, 'utf8'));
  return {
    success: true,
    asset: {
      assetId: `vtracer:${sha256.slice(0, 16)}`,
      encoding: input.outputEncoding ?? 'svgText',
      svgText: input.outputEncoding === 'base64' ? undefined : sanitized.svgText,
      svgBase64: input.outputEncoding === 'base64' ? Buffer.from(sanitized.svgText, 'utf8').toString('base64') : undefined,
      sha256,
      byteLength: Buffer.byteLength(sanitized.svgText, 'utf8'),
      recommendedFilename: `${sha256.slice(0, 16)}.svg`,
      metadata: {
        source: 'vtracer',
        createdAt: new Date().toISOString(),
        provenance: {
          steps: [step('vtracer-trace', { mode: input.mode ?? 'poster' }, { outputSha256: sha256 })]
        }
      },
      safetyReport: sanitized.safetyReport,
      previewPngBase64: input.includePreview ? renderPreview(sanitized.svgText) : undefined
    }
  };
}
