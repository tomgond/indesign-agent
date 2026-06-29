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
  let outputPath: string | null = null;
  let tempDir: string | null = null;
  try {
    if (input.rasterBase64) {
      tempDir = fs.mkdtempSync('/tmp/design-assets-mcp-');
      rasterPath = `${tempDir}/input.${input.rasterMimeType?.split('/')[1] ?? 'png'}`;
      outputPath = `${tempDir}/output.svg`;
      const normalized = String(input.rasterBase64).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        return { success: false, error: { code: 'RASTER_BAD_BASE64', message: 'rasterBase64 is not valid base64' } };
      }
      const rasterBytes = Buffer.from(normalized, 'base64');
      if (rasterBytes.toString('base64') !== normalized) {
        return { success: false, error: { code: 'RASTER_BAD_BASE64', message: 'rasterBase64 is not valid base64' } };
      }
      if (rasterBytes.length > 5 * 1024 * 1024) {
        return { success: false, error: { code: 'RASTER_TOO_LARGE', message: 'Raster input exceeds size cap' } };
      }
      fs.writeFileSync(rasterPath, rasterBytes);
    } else if (input.inputPath) {
      tempDir = fs.mkdtempSync('/tmp/design-assets-mcp-');
      outputPath = `${tempDir}/output.svg`;
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

    if (!rasterPath || !outputPath) {
      return { success: false, error: { code: 'VTRACER_BAD_INPUT', message: 'Unable to resolve vtracer input or output path' } };
    }

    const traceArgs = buildTraceArgs(rasterPath, outputPath, input.mode ?? 'poster');
    const traced = await runCommand(config.vtracerCommand, traceArgs, config.vtracerTimeoutMs);
    if (traced.code !== 0) {
      return { success: false, error: { code: 'VTRACER_FAILED', message: traced.stderr || 'vtracer failed' } };
    }

    if (!fs.existsSync(outputPath)) {
      return { success: false, error: { code: 'VTRACER_FAILED', message: 'vtracer did not produce an output file' } };
    }
    const svgText = fs.readFileSync(outputPath, 'utf8');
    const finalSanitized = sanitizeSvg(stripSvgPreamble(svgText), { maxBytes: 2 * 1024 * 1024 });
    const sha256 = bytesSha256(Buffer.from(finalSanitized.svgText, 'utf8'));
    return {
      success: true,
      asset: {
        assetId: `vtracer:${sha256.slice(0, 16)}`,
        encoding: input.outputEncoding ?? 'svgText',
        svgText: input.outputEncoding === 'base64' ? undefined : finalSanitized.svgText,
        svgBase64: input.outputEncoding === 'base64' ? Buffer.from(finalSanitized.svgText, 'utf8').toString('base64') : undefined,
        sha256,
        byteLength: Buffer.byteLength(finalSanitized.svgText, 'utf8'),
        recommendedFilename: `${sha256.slice(0, 16)}.svg`,
        metadata: {
          source: 'vtracer',
          createdAt: new Date().toISOString(),
          provenance: {
            steps: [step('vtracer-trace', { mode: input.mode ?? 'poster' }, { outputSha256: sha256 })]
          }
        },
        safetyReport: finalSanitized.safetyReport,
        previewPngBase64: input.includePreview ? renderPreview(finalSanitized.svgText) : undefined
      }
    }
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildTraceArgs(inputPath: string, outputPath: string, mode: NonNullable<VtracerRequest['mode']>) {
  const args = ['--input', inputPath, '--output', outputPath];
  if (mode === 'bw') {
    args.push('--preset', 'bw');
  } else if (mode === 'poster') {
    args.push('--preset', 'poster');
  } else if (mode === 'photo') {
    args.push('--preset', 'photo');
  } else if (mode === 'line-art') {
    args.push('--preset', 'bw', '--colormode', 'bw');
  }
  return args;
}

function stripSvgPreamble(svgText: string) {
  const index = svgText.search(/<svg\b/i);
  return index >= 0 ? svgText.slice(index) : svgText;
}
