import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssetHandlers } from '../src/handlers/assetHandlers.js';
import { clearActiveWorkspace, initWorkspace } from '../src/core/workspaceState.js';
import { assertWorkspacePath } from '../src/utils/pathGuard.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-asset-materialization-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');

const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18"/></svg>';
const safeSvgBase64 = Buffer.from(safeSvg, 'utf8').toString('base64');
const safeSha = crypto.createHash('sha256').update(Buffer.from(safeSvg, 'utf8')).digest('hex');
const previewPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3Zz4sAAAAASUVORK5CYII=';
const invalidPreviewBase64 = Buffer.from('not a png', 'utf8').toString('base64');
const invalidUtf8Base64 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function expectFailure(args, pattern) {
    const result = await AssetHandlers.materializeInlineSvgAsset(args);
    assert.equal(result.success, false);
    assert.match(result.result, pattern);
    return result;
}

async function run() {
    fs.writeFileSync(original, 'fake-indd-bytes');
    initWorkspace({ originalSourcePath: original, workspaceRoot, overwriteExistingWorkspace: true });

    try {
        const topLevel = await AssetHandlers.materializeInlineSvgAsset({
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

        assert.equal(topLevel.success, true);
        assert.ok(topLevel.result.assetPath.endsWith(path.join('assets', 'imports', 'tabler:trophy', 'asset.svg')));
        assert.ok(fs.existsSync(topLevel.result.assetPath));
        assert.ok(fs.existsSync(topLevel.result.metadataPath));
        assert.ok(fs.existsSync(topLevel.result.previewPath));
        assert.equal(path.basename(path.dirname(topLevel.result.assetPath)), 'tabler:trophy');
        assert.equal(fs.readFileSync(topLevel.result.assetPath, 'utf8'), safeSvg);
        assert.equal(assertWorkspacePath(topLevel.result.assetPath, { kind: 'assets' }).path, topLevel.result.assetPath);

        const metadata = readJson(topLevel.result.metadataPath);
        assert.equal(metadata.assetId, 'tabler:trophy');
        assert.equal(metadata.safeAssetKey, 'tabler:trophy');
        assert.equal(metadata.recommendedFilename, 'trophy.svg');
        assert.equal(metadata.suppliedSha256, safeSha);
        assert.equal(metadata.computedSha256, safeSha);
        assert.equal(metadata.byteLength, Buffer.byteLength(safeSvg, 'utf8'));
        assert.equal(metadata.metadata.source, 'tabler');
        assert.equal(metadata.safetyReport.validatorVersion, 'mac-cheap-svg-validator-v2');
        assert.equal(metadata.safetyReport.passed, true);
        assert.equal(metadata.safetyReport.hasText, false);
        assert.equal(metadata.safetyReport.hasEmbeddedImages, false);

        const assetObject = await AssetHandlers.materializeInlineSvgAsset({
            asset: {
                assetId: 'iconify:home',
                encoding: 'base64',
                svgBase64: safeSvgBase64,
                sha256: safeSha,
                byteLength: Buffer.byteLength(safeSvg, 'utf8'),
                recommendedFilename: '../home.svg',
                metadata: { source: 'iconify-local', title: 'Home' },
                safetyReport: { warnings: ['from payload'] }
            }
        });

        assert.equal(assetObject.success, true);
        assert.equal(path.basename(path.dirname(assetObject.result.assetPath)), 'iconify:home');
        assert.equal(fs.readFileSync(assetObject.result.assetPath, 'utf8'), safeSvg);
        assert.equal(readJson(assetObject.result.metadataPath).metadata.title, 'Home');

        const fallback = await AssetHandlers.materializeInlineSvgAsset({
            assetId: '../../escape',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha,
            byteLength: Buffer.byteLength(safeSvg, 'utf8')
        });

        assert.equal(fallback.success, true);
        assert.equal(fallback.result.assetKey, safeSha);
        assert.equal(path.basename(path.dirname(fallback.result.assetPath)), safeSha);
        assert.ok(!fallback.result.assetPath.includes('..'));

        const traversalCases = ['../x', '/tmp/x', 'a/b', 'a\\b', '', '   '];
        for (const assetId of traversalCases) {
            const result = await AssetHandlers.materializeInlineSvgAsset({
                assetId,
                encoding: 'svgText',
                svgText: safeSvg,
                sha256: safeSha
            });
            assert.equal(result.success, true);
            assert.equal(path.basename(path.dirname(result.result.assetPath)), safeSha);
            assert.equal(result.result.safeAssetKey, safeSha);
            assert.ok(result.result.assetPath.includes(path.join('assets', 'imports', safeSha)));
        }

        const dotAsset = await AssetHandlers.materializeInlineSvgAsset({
            assetId: '.',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha
        });
        assert.equal(path.basename(path.dirname(dotAsset.result.assetPath)), safeSha);

        const hiddenAsset = await AssetHandlers.materializeInlineSvgAsset({
            assetId: '.hidden',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha
        });
        assert.equal(path.basename(path.dirname(hiddenAsset.result.assetPath)), safeSha);

        const dotdotAsset = await AssetHandlers.materializeInlineSvgAsset({
            assetId: '..',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha
        });
        assert.equal(path.basename(path.dirname(dotdotAsset.result.assetPath)), safeSha);

        const hostileInputs = [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>bad</div></foreignObject></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com">bad</a></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="//example.com">bad</a></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="file:///etc/passwd">bad</a></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://example.com/x.css");</style></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{background:url(https://example.com/x.png)}</style></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>',
            '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><svg><script/></svg></svg>'
        ];

        for (let i = 0; i < hostileInputs.length; i++) {
            await expectFailure({
                assetId: `hostile-${i}`,
                encoding: 'svgText',
                svgText: hostileInputs[i]
            }, /rejected|not allowed|DOCTYPE|ENTITY|data:|href=|style|script|foreignObject/i);
            assert.equal(fs.existsSync(path.join(workspaceRoot, 'assets', 'imports', `hostile-${i}`)), false);
        }

        await expectFailure({
            assetId: 'invalid-b64',
            encoding: 'base64',
            svgBase64: 'not-base64!!'
        }, /not valid base64/i);

        await expectFailure({
            assetId: 'invalid-utf8',
            encoding: 'base64',
            svgBase64: invalidUtf8Base64
        }, /UTF-8/i);

        const oversizedSvg = `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(600000)}</svg>`;
        await expectFailure({
            assetId: 'oversized',
            encoding: 'svgText',
            svgText: oversizedSvg,
            maxSvgBytes: 1024
        }, /exceeds maxSvgBytes/i);

        await expectFailure({
            assetId: 'bad-sha',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: 'deadbeef'
        }, /SHA-256 mismatch/i);

        await expectFailure({
            assetId: 'bad-preview',
            encoding: 'svgText',
            svgText: safeSvg,
            sha256: safeSha,
            previewPngBase64: invalidPreviewBase64
        }, /PNG image/i);

        clearActiveWorkspace();
        const noWorkspace = await AssetHandlers.materializeInlineSvgAsset({
            assetId: 'no-workspace',
            encoding: 'svgText',
            svgText: safeSvg
        });
        assert.equal(noWorkspace.success, false);
        assert.match(noWorkspace.result, /workspace is not attached/i);

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
