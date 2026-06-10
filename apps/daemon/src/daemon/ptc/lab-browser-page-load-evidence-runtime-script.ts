export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT = String.raw`
(async () => {
  const crypto = require('crypto');
  const fs = require('fs');
  const capability = 'ptc_lab_browser_page_load_evidence';
  const checks = {
    engineAvailable: false,
    contextCreated: false,
    navigationStarted: false,
    navigationSettled: false,
    redirectPolicyEnforced: false,
    downloadPolicyEnforced: false,
    popupPolicyEnforced: false,
    permissionPolicyEnforced: true,
    evidenceSanitized: false,
    cleanupCompleted: false
  };
  function finish(exitCode, payload) {
    process.stdout.write(JSON.stringify({ capability, checks, ...payload }) + '\n', () => {
      process.exit(exitCode);
    });
  }
  function readInput() {
    const inputPath = process.argv[2];
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    } catch {
      return null;
    }
  }
  function sha256(value) {
    return 'sha256:' + crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }
  function isAdmittedUrl(value) {
    if (typeof value !== 'string') {
      return false;
    }
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      );
    } catch {
      return false;
    }
  }
  function redirectInfo(response, page) {
    if (!response || !isAdmittedUrl(page.url())) {
      return { ok: false, count: 0 };
    }
    let count = 0;
    let request = response.request();
    while (request) {
      if (!isAdmittedUrl(request.url())) {
        return { ok: false, count };
      }
      request = request.redirectedFrom();
      if (request) {
        count += 1;
      }
    }
    return { ok: true, count };
  }
  function sanitizeTitle(value, maxChars) {
    if (typeof value !== 'string') {
      return null;
    }
    const controls = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
    const normalized = value.normalize('NFC').replace(controls, ' ').replace(/\s+/gu, ' ').trim();
    const truncated = normalized.length > maxChars;
    return {
      text: truncated ? normalized.slice(0, maxChars) : normalized,
      charCount: normalized.length,
      truncated,
      maxChars,
      redacted: false
    };
  }
  async function cleanup(page, context, browser) {
    let ok = true;
    if (page) {
      try { await page.close(); } catch { ok = false; }
    }
    if (context) {
      try { await context.close(); } catch { ok = false; }
    }
    if (browser) {
      try { await browser.close(); } catch { ok = false; }
    }
    checks.cleanupCompleted = ok;
    return ok;
  }

  const input = readInput();
  if (
    !input ||
    !isAdmittedUrl(input.targetUrl) ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isInteger(input.maxTitleChars) ||
    input.maxTitleChars <= 0 ||
    input.loadWaitState !== 'domcontentloaded'
  ) {
    checks.cleanupCompleted = true;
    finish(2, { ok: false, errorCode: 'navigation_failed' });
    return;
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    checks.cleanupCompleted = true;
    finish(3, { ok: false, errorCode: 'browser_runtime_unavailable' });
    return;
  }

  let browser;
  let context;
  let page;
  let popupObserved = false;
  let downloadObserved = false;
  const navigationStartMs = Date.now();
  try {
    browser = await chromium.launch({ headless: true });
    checks.engineAvailable = true;
    context = await browser.newContext({
      acceptDownloads: false,
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1280, height: 720 }
    });
    checks.contextCreated = true;
    context.on('page', async (openedPage) => {
      if (page && openedPage !== page) {
        popupObserved = true;
        try { await openedPage.close(); } catch {}
      }
    });
    page = await context.newPage();
    page.on('popup', async (popup) => {
      popupObserved = true;
      try { await popup.close(); } catch {}
    });
    page.on('download', async (download) => {
      downloadObserved = true;
      try { await download.cancel(); } catch {}
    });
    checks.navigationStarted = true;
    const response = await page.goto(input.targetUrl, {
      waitUntil: input.loadWaitState,
      timeout: input.timeoutMs
    });
    const navigationDurationMs = Math.max(0, Date.now() - navigationStartMs);
    const redirects = redirectInfo(response, page);
    const title = sanitizeTitle(await page.title(), input.maxTitleChars);
    checks.navigationSettled = Boolean(response);
    checks.redirectPolicyEnforced = redirects.ok;
    checks.downloadPolicyEnforced = !downloadObserved;
    checks.popupPolicyEnforced = !popupObserved;
    checks.evidenceSanitized = Boolean(title);
    const loaded =
      checks.navigationSettled &&
      checks.redirectPolicyEnforced &&
      checks.downloadPolicyEnforced &&
      checks.popupPolicyEnforced &&
      checks.permissionPolicyEnforced &&
      checks.evidenceSanitized;
    const finalUrlDigest = isAdmittedUrl(page.url()) ? sha256(page.url()) : undefined;
    const cleaned = await cleanup(page, context, browser);
    finish(loaded && cleaned ? 0 : 2, {
      ok: loaded && cleaned,
      ...(loaded && cleaned
        ? {
            loadOutcome: 'loaded',
            loadState: input.loadWaitState,
            finalUrlDigest,
            responseStatus: response
              ? { code: response.status(), source: 'final_main_resource_response' }
              : undefined,
            title,
            redirectCount: redirects.count,
            navigationDurationMs
          }
        : {
            errorCode: cleaned
              ? popupObserved
                ? 'popup_disallowed'
                : downloadObserved
                  ? 'download_disallowed'
                  : checks.navigationSettled && !checks.redirectPolicyEnforced
                    ? 'redirect_disallowed'
                    : checks.evidenceSanitized
                      ? 'navigation_failed'
                      : 'evidence_output_invalid'
              : 'cleanup_uncertain'
          })
    });
  } catch {
    const cleaned = await cleanup(page, context, browser);
    finish(2, {
      ok: false,
      errorCode: browser ? (cleaned ? 'navigation_failed' : 'cleanup_uncertain') : 'browser_runtime_unavailable'
    });
  }
})();
`;
