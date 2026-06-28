import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssetHandlers } from '../src/handlers/assetHandlers.js';
import { clearActiveWorkspace, initWorkspace } from '../src/core/workspaceState.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-asset-materialization-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');

const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18"/></svg>';
const safeSha = crypto.createHash('sha256').update(Buffer.from(safeSvg, 'utf8')).digest('hex');
const previewPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3Zz4sAAAAASUVORK5CYII=';

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function run() {
    fs.writeFileSync(original, 'fake-indd-bytes');
    initWorkspace({ originalSourcePath: original, workspaceRoot, overwriteExistingWorkspace: true });

    try {
        const success = await AssetHandlers.materializeInlineSvgAsset({
            assetId: 'tabler:trophy',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha,
            byteLength: Buffer.byteLength(safeSvg, 'utf8'),
            recommendedFilename: '../../trophy.svg',
            metadata: {
                source: 'tabler',
                title: 'Trophy',
                license: { name: 'MIT', commercialUseAllowed: true }
            },
            safetyReport: { passed: true, sanitizerVersion: 'linux-pass' },
            previewPngBase64
        });

        assert.equal(success.success, true);
        const asset = success.result;
        assert.equal(asset.readyForPlacement, true);
        assert.equal(asset.sha256, safeSha);
        assert.ok(fs.existsSync(asset.assetPath));
        assert.ok(fs.existsSync(asset.metadataPath));
        assert.ok(fs.existsSync(asset.previewPath));
        assert.equal(path.basename(path.dirname(asset.assetPath)), 'tabler:trophy');
        assert.equal(fs.readFileSync(asset.assetPath, 'utf8'), safeSvg);

        const metadata = readJson(asset.metadataPath);
        assert.equal(metadata.receivedSha256, safeSha);
        assert.equal(metadata.sha256, safeSha);
        assert.equal(metadata.materializedAt, asset.materializedAt);
        assert.equal(metadata.metadata.source, 'tabler');
        assert.equal(metadata.safetyReport.sanitizerVersion, 'mac-cheap-svg-validator-v1');
        assert.equal(metadata.safetyReport.passed, true);
        assert.equal(metadata.safetyReport.receivedAt, asset.materializedAt);

        const fallback = await AssetHandlers.materializeInlineSvgAsset({
            assetId: '../../escape',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha,
            byteLength: Buffer.byteLength(safeSvg, 'utf8')
        });
        assert.equal(fallback.success, true);
        const fallbackAsset = fallback.result;
        assert.equal(fallbackAsset.assetKey, safeSha);
        assert.equal(path.basename(path.dirname(fallbackAsset.assetPath)), safeSha);
        assert.ok(!fallbackAsset.assetPath.includes('..'));

        const hostileInputs = [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>bad</div></foreignObject></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com">bad</a></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://example.com/x.css");</style></svg>',
            '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>'
        ];

        for (let i = 0; i < hostileInputs.length; i++) {
            const assetId = `hostile-${i}`;
            const result = await AssetHandlers.materializeInlineSvgAsset({
                assetId,
                encoding: 'svgText',
                svgText: hostileInputs[i]
            });
            assert.equal(result.success, false);
            assert.match(result.result, /rejected|not allowed|DOCTYPE|ENTITY|base64/i);
            assert.equal(fs.existsSync(path.join(workspaceRoot, 'assets', 'imports', assetId)), false);
        }

        const shaMismatch = await AssetHandlers.materializeInlineSvgAsset({
            assetId: 'sha-mismatch',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: 'deadbeef'
        });
        assert.equal(shaMismatch.success, false);
        assert.match(shaMismatch.result, /SHA-256 mismatch/i);
        assert.equal(fs.existsSync(path.join(workspaceRoot, 'assets', 'imports', 'sha-mismatch')), false);

        console.log('Asset materialization tests passed');
    } finally {
        clearActiveWorkspace();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    clearActiveWorkspace();
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
});
