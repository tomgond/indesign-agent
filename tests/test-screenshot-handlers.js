/**
 * Manual regression tests for screenshot handlers — ES module version.
 *
 * Run: node tests/test-screenshot-handlers.js
 *
 * Tests requiring a display/InDesign will be skipped when environment
 * is headless. Run on a real Mac/Windows desktop for full coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ScreenshotHandlers } from '../src/handlers/screenshotHandlers.js';

// Regression guard: DocumentHandlers.zoomToPage must NOT use page.zoomToFit
const documentHandlersSrc = fs.readFileSync(
    new URL('../src/handlers/documentHandlers.js', import.meta.url),
    'utf8'
);
const hasZoomToFit = /page\s*\.\s*zoomToFit/.test(documentHandlersSrc);
if (hasZoomToFit) {
    console.error('REGRESSION: page.zoomToFit still present in documentHandlers.js');
    process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(label, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.log(`  FAIL  ${label}  ${detail || ''}`);
        failed++;
    }
}

function assertErrorResponse(res, label, expectedSubstring) {
    const ok = res && res.success === false && typeof res.result === 'string' &&
        (!expectedSubstring || res.result.includes(expectedSubstring));
    assert(label, ok, res ? JSON.stringify(res).slice(0, 200) : 'null');
}

async function runTests() {
    console.log('\n=== Screenshot Handler Tests ===\n');

    // ===== normalizePngPath =====
    console.log('--- normalizePngPath ---');
    assert('keeps existing .png',
        ScreenshotHandlers.normalizePngPath('/tmp/test.png').endsWith('.png') &&
        !ScreenshotHandlers.normalizePngPath('/tmp/test.png').endsWith('.png.png'));
    assert('appends .png when missing',
        ScreenshotHandlers.normalizePngPath('/tmp/test').endsWith('test.png'));
    assert('resolves to absolute path',
        ScreenshotHandlers.normalizePngPath('test.png') === path.resolve('test.png'));

    let threw;
    threw = false; try { ScreenshotHandlers.normalizePngPath(''); } catch (e) { threw = true; }
    assert('empty string throws', threw);

    threw = false; try { ScreenshotHandlers.normalizePngPath(null); } catch (e) { threw = true; }
    assert('null throws', threw);

    threw = false; try { ScreenshotHandlers.normalizePngPath(undefined); } catch (e) { threw = true; }
    assert('undefined throws', threw);

    let errMsg;
    threw = false; try { ScreenshotHandlers.normalizePngPath('/tmp/test.jpg'); } catch (e) { threw = true; errMsg = e.message; }
    assert('wrong .jpg extension throws', threw && errMsg.includes('.png'));

    threw = false; errMsg = ''; try { ScreenshotHandlers.normalizePngPath('/tmp/test.JPEG'); } catch (e) { threw = true; errMsg = e.message; }
    assert('wrong .JPEG extension throws', threw);

    // ===== ensureDirForFile =====
    console.log('\n--- ensureDirForFile ---');
    const testDir = '/tmp/screenshot-test-deep';
    fs.rmSync(testDir, { recursive: true, force: true });
    ScreenshotHandlers.ensureDirForFile(path.join(testDir, 'a', 'b', 'out.png'));
    assert('creates nested directories', fs.existsSync(path.join(testDir, 'a', 'b')));

    // ===== validateCommonArgs =====
    console.log('\n--- validateCommonArgs ---');
    const op = 'TestOp';

    let r = ScreenshotHandlers.validateCommonArgs(null, op);
    assertErrorResponse(r, 'null args rejected', 'Args must be an object');

    r = ScreenshotHandlers.validateCommonArgs(undefined, op);
    assertErrorResponse(r, 'undefined args rejected', 'Args must be an object');

    r = ScreenshotHandlers.validateCommonArgs({}, op);
    assertErrorResponse(r, 'missing outputPath rejected', 'outputPath is required');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '' }, op);
    assertErrorResponse(r, 'empty outputPath rejected', 'outputPath is required');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: 123 }, op);
    assertErrorResponse(r, 'non-string outputPath rejected', 'outputPath is required');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.jpg' }, op);
    assertErrorResponse(r, '.jpg extension rejected', '.png extension');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.png', delayMs: -1 }, op);
    assertErrorResponse(r, 'negative delayMs rejected', 'delayMs');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.png', delayMs: 5001 }, op);
    assertErrorResponse(r, 'delayMs > 5000 rejected', 'delayMs');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.png', delayMs: 1.5 }, op);
    assertErrorResponse(r, 'non-integer delayMs rejected', 'delayMs');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.png', delayMs: 'fast' }, op);
    assertErrorResponse(r, 'string delayMs rejected', 'delayMs');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.png', captureMode: 'window' }, op);
    assertErrorResponse(r, 'unsupported captureMode rejected', 'captureMode');

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test.png', delayMs: 300, captureMode: 'screen' }, op);
    assert('valid common args returns null', r === null);

    r = ScreenshotHandlers.validateCommonArgs({ outputPath: '/tmp/test' }, op);
    assert('valid args without ext returns null', r === null);

    // ===== validateInDesignArgs =====
    console.log('\n--- validateInDesignArgs ---');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png' }, op);
    assertErrorResponse(r, 'missing pageIndex rejected', 'pageIndex is required');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: null }, op);
    assertErrorResponse(r, 'null pageIndex rejected', 'pageIndex is required');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: -1 }, op);
    assertErrorResponse(r, 'negative pageIndex rejected', 'non-negative integer');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: '0' }, op);
    assertErrorResponse(r, 'string pageIndex rejected', 'non-negative integer');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: 0.5 }, op);
    assertErrorResponse(r, 'float pageIndex rejected', 'non-negative integer');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'actual_size' }, op);
    assertErrorResponse(r, 'actual_size rejected', 'zoomMode');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'fit_document' }, op);
    assertErrorResponse(r, 'invalid zoomMode rejected', 'zoomMode');

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: 0 }, op);
    assert('valid InDesign args returns null', r === null);

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'fit_page' }, op);
    assert('valid InDesign args with zoom returns null', r === null);

    r = ScreenshotHandlers.validateInDesignArgs({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'none', delayMs: 0 }, op);
    assert('valid InDesign args with none zoom returns null', r === null);

    // ===== captureScreenPreview validation failures =====
    console.log('\n--- captureScreenPreview validation ---');

    r = await ScreenshotHandlers.captureScreenPreview(null);
    assertErrorResponse(r, 'null args rejected', 'Args must be an object');

    r = await ScreenshotHandlers.captureScreenPreview({});
    assertErrorResponse(r, 'empty args rejected', 'outputPath is required');

    r = await ScreenshotHandlers.captureScreenPreview({ outputPath: '/tmp/test.png', captureMode: 'window' });
    assertErrorResponse(r, 'bad captureMode rejected', 'captureMode');

    r = await ScreenshotHandlers.captureScreenPreview({ outputPath: '/tmp/test.png', delayMs: 9999 });
    assertErrorResponse(r, 'excessive delayMs rejected', 'delayMs');

    // ===== captureInDesignScreenPreview validation failures =====
    console.log('\n--- captureInDesignScreenPreview validation ---');

    r = await ScreenshotHandlers.captureInDesignScreenPreview(null);
    assertErrorResponse(r, 'null args rejected', 'Args must be an object');

    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test.png' });
    assertErrorResponse(r, 'missing pageIndex rejected', 'pageIndex is required');

    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test.png', pageIndex: -1 });
    assertErrorResponse(r, 'negative pageIndex rejected before UXP', 'non-negative integer');

    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'fit_spread' });
    assertErrorResponse(r, 'fit_spread returns unsupported error before UXP', 'not supported');

    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'actual_size' });
    assertErrorResponse(r, 'actual_size rejected before UXP', 'zoomMode');

    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'fit_document' });
    assertErrorResponse(r, 'fit_document rejected before UXP', 'zoomMode');

    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test.png', pageIndex: 0, zoomMode: 'none', delayMs: 10 });
    // Should fail at UXP (no bridge), not at validation — zoomMode none means skip zoom entirely
    assert('none zoomMode bypasses zoom (fails at UXP not validation)',
        r && r.success === false && typeof r.result === 'string' &&
        !r.result.includes('zoomMode'));

    // ===== OS capture in headless =====
    console.log('\n--- OS capture behavior ---');
    r = await ScreenshotHandlers.captureScreenPreview({ outputPath: '/tmp/screenshot-headless-test.png', delayMs: 10 });
    if (r && r.success === true) {
        assert('OS capture succeeded (display available)', true);
        assert('response has kind', r.result.kind === 'screen_capture');
        assert('response has note', r.result.note === 'OS-level screenshot; not an InDesign export');
        assert('response has platform', typeof r.result.platform === 'string');
        assert('response has capturedAt', typeof r.result.capturedAt === 'string');
        assert('response has filePath', typeof r.result.filePath === 'string');
        assert('response has sizeBytes', typeof r.result.sizeBytes === 'number');
    } else {
        assert('OS capture failed with clear error (headless)',
            r && r.success === false && typeof r.result === 'string' && r.result.length > 0);
        // Accept any of the expected headless/display error patterns
        const headlessMsg = r.result;
        assert('headless error is descriptive',
            headlessMsg.includes('failed') || headlessMsg.includes('No supported') ||
            headlessMsg.includes('not found') || headlessMsg.includes('cannot open display') ||
            headlessMsg.includes('Error'));
    }

    // ===== composite InDesign capture with no bridge =====
    console.log('\n--- composite capture behavior (no InDesign bridge) ---');
    r = await ScreenshotHandlers.captureInDesignScreenPreview({ outputPath: '/tmp/test-composite.png', pageIndex: 0, delayMs: 10 });
    // Either validation caught it, or UXP call failed — both acceptable
    assert('composite returns error when no InDesign bridge',
        r && r.success === false && typeof r.result === 'string');

    // ===== Response kind structure =====
    console.log('\n--- response structure ---');
    // Even failed responses should have operation name in the structure
    assert('error response has result string', typeof r.result === 'string' && r.result.length > 0);
    assert('error response has success false', r.success === false);

    if (r && r.success === false) {
        const errResult = r;
        assert('first-level success field present', 'success' in errResult);
        assert('first-level result field present', 'result' in errResult);
    }

    // ===== Summary =====
    const total = passed + failed + skipped;
    console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${total} total) ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
