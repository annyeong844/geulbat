type PtcLabBrowserRuntimeScriptEvidence =
  | { kind: 'none' }
  | {
      kind: 'page_load_title';
      outputKey: 'title';
      failureCode: 'evidence_output_invalid';
    }
  | {
      kind: 'visible_text';
      outputKey: 'visibleText';
      failureCode: 'evidence_unavailable';
    };

interface BuildPtcLabBrowserRuntimeScriptArgs {
  capability: string;
  evidence: PtcLabBrowserRuntimeScriptEvidence;
}

function buildPtcLabBrowserRuntimeScript(
  args: BuildPtcLabBrowserRuntimeScriptArgs,
): string {
  return String.raw`
(async () => {
  const fs = require('fs');
  const config = ${JSON.stringify(args)};
  const capability = config.capability;
  const hasEvidence = config.evidence.kind !== 'none';
  let crypto;
  const checks = hasEvidence
    ? {
        engineAvailable: false,
        contextCreated: false,
        navigationStarted: false,
        navigationSettled: false,
        redirectPolicyEnforced: false,
        downloadPolicyEnforced: false,
        popupPolicyEnforced: false,
        evidenceCaptured: false,
        cleanupCompleted: false
      }
    : {
        engineAvailable: false,
        contextCreated: false,
        navigationStarted: false,
        navigationSettled: false,
        redirectPolicyEnforced: false,
        downloadPolicyEnforced: false,
        cleanupCompleted: false
      };
  function finish(exitCode, payload) {
    process.stdout.write(JSON.stringify({ capability, checks, ...payload }) + '\n', () => {
      process.exit(exitCode);
    });
  }
  function readInput() {
    const inputPath = process.argv[1];
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
    crypto = crypto || require('crypto');
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
  function buildEvidenceTextValue(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const controls = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
    return value.normalize('NFC').replace(controls, ' ').replace(/\s+/gu, ' ').trim();
  }
  async function collectEvidence(page, input) {
    if (config.evidence.kind === 'none') {
      return { ok: true, payload: {} };
    }
    if (config.evidence.kind === 'page_load_title') {
      const title = buildEvidenceTextValue(await page.title());
      return {
        ok: Boolean(title),
        payload: { [config.evidence.outputKey]: title }
      };
    }
    try {
      const visibleText = buildEvidenceTextValue(
        await page.evaluate(() => (document.body ? document.body.innerText : ''))
      );
      return {
        ok: visibleText !== null,
        payload: { [config.evidence.outputKey]: visibleText }
      };
    } catch {
      return { ok: false, payload: { [config.evidence.outputKey]: null } };
    }
  }
  function successPayload(input, response, redirects, navigationDurationMs, finalUrlDigest, evidencePayload) {
    if (!hasEvidence) {
      return {};
    }
    const payload = {
      loadOutcome: 'loaded',
      loadState: input.loadWaitState,
      finalUrlDigest,
      ...evidencePayload,
      redirectCount: redirects.count,
      navigationDurationMs
    };
    if (config.evidence.kind === 'page_load_title') {
      payload.responseStatus = response
        ? { code: response.status(), source: 'final_main_resource_response' }
        : undefined;
    }
    return payload;
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
  async function closeObservedPopupPages(context, page) {
    if (!context || typeof context.pages !== 'function') {
      return true;
    }
    let ok = true;
    for (const candidate of context.pages()) {
      if (candidate !== page) {
        popupObserved = true;
        try { await candidate.close(); } catch { ok = false; }
      }
    }
    return ok;
  }
  function remainingNavigationTimeoutMs(input, startedAtMs) {
    return Math.max(0, input.timeoutMs - Math.max(0, Date.now() - startedAtMs));
  }
  async function waitForLoadStateOrPolicyEvent(page, state, input, startedAtMs, hasPolicyViolation) {
    if (hasPolicyViolation()) {
      return true;
    }
    const remainingMs = remainingNavigationTimeoutMs(input, startedAtMs);
    if (remainingMs <= 0) {
      return false;
    }
    try {
      await page.waitForLoadState(state, { timeout: remainingMs });
      return true;
    } catch {
      return false;
    }
  }
  async function waitForPolicyEventsToSettle(page, input, startedAtMs, hasPolicyViolation) {
    if (
      !(await waitForLoadStateOrPolicyEvent(
        page,
        'load',
        input,
        startedAtMs,
        hasPolicyViolation
      ))
    ) {
      return false;
    }
    if (hasPolicyViolation()) {
      return true;
    }
    return await waitForLoadStateOrPolicyEvent(
      page,
      'networkidle',
      input,
      startedAtMs,
      hasPolicyViolation
    );
  }

  const input = readInput();
  if (
    !input ||
    !isAdmittedUrl(input.targetUrl) ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
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
  const hasPolicyViolation = () => popupObserved || downloadObserved;
  let policyCleanupOk = true;
  try {
    browser = await chromium.launch({ headless: true });
    checks.engineAvailable = true;
    context = await browser.newContext({
      acceptDownloads: false,
      permissions: [],
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1280, height: 720 }
    });
    checks.contextCreated = true;
    page = await context.newPage();
    context.on('request', (request) => {
      if (
        !page ||
        typeof request.isNavigationRequest !== 'function' ||
        typeof request.resourceType !== 'function' ||
        !request.isNavigationRequest() ||
        request.resourceType() !== 'document'
      ) {
        return;
      }
      try {
        const frame = request.frame();
        if (
          frame !== page.mainFrame() &&
          context.pages().some((candidate) => candidate !== page)
        ) {
          popupObserved = true;
        }
      } catch {
        popupObserved = true;
      }
    });
    context.on('page', async (openedPage) => {
      if (page && openedPage !== page) {
        popupObserved = true;
        try { await openedPage.close(); } catch { policyCleanupOk = false; }
      }
    });
    page.on('popup', async (popup) => {
      popupObserved = true;
      try { await popup.close(); } catch { policyCleanupOk = false; }
    });
    page.on('download', async (download) => {
      downloadObserved = true;
      try { await download.cancel(); } catch { policyCleanupOk = false; }
    });
    checks.navigationStarted = true;
    const navigationStartMs = Date.now();
    const response = await page.goto(input.targetUrl, {
      waitUntil: input.loadWaitState,
      timeout: input.timeoutMs
    });
    const policyEventsSettled = await waitForPolicyEventsToSettle(
      page,
      input,
      navigationStartMs,
      hasPolicyViolation
    );
    policyCleanupOk =
      (await closeObservedPopupPages(context, page)) && policyCleanupOk;
    const navigationDurationMs = Math.max(0, Date.now() - navigationStartMs);
    const redirects = redirectInfo(response, page);
    const evidence = policyEventsSettled
      ? await collectEvidence(page, input)
      : { ok: false, payload: {} };
    policyCleanupOk =
      (await closeObservedPopupPages(context, page)) && policyCleanupOk;
    checks.navigationSettled = Boolean(response);
    checks.redirectPolicyEnforced = redirects.ok;
    checks.downloadPolicyEnforced = !downloadObserved;
    if (hasEvidence) {
      checks.popupPolicyEnforced = !popupObserved;
      checks.evidenceCaptured = evidence.ok;
    }
    const loaded =
      checks.navigationSettled &&
      policyEventsSettled &&
      checks.redirectPolicyEnforced &&
      checks.downloadPolicyEnforced &&
      (hasEvidence ? checks.popupPolicyEnforced : !popupObserved) &&
      (!hasEvidence || checks.evidenceCaptured);
    const finalUrlDigest =
      hasEvidence && isAdmittedUrl(page.url()) ? sha256(page.url()) : undefined;
    const cleaned = (await cleanup(page, context, browser)) && policyCleanupOk;
    finish(loaded && cleaned ? 0 : 2, {
      ok: loaded && cleaned,
      ...(loaded && cleaned
        ? successPayload(
            input,
            response,
            redirects,
            navigationDurationMs,
            finalUrlDigest,
            evidence.payload
          )
        : {
            errorCode: cleaned
              ? popupObserved
                ? 'popup_disallowed'
                : downloadObserved
                  ? 'download_disallowed'
                  : checks.navigationSettled && !checks.redirectPolicyEnforced
                    ? 'redirect_disallowed'
                    : hasEvidence && !checks.evidenceCaptured
                      ? config.evidence.failureCode
                      : 'navigation_failed'
              : 'cleanup_uncertain'
          })
    });
  } catch {
    const cleaned = (await cleanup(page, context, browser)) && policyCleanupOk;
    finish(2, {
      ok: false,
      errorCode: browser ? (cleaned ? 'navigation_failed' : 'cleanup_uncertain') : 'browser_runtime_unavailable'
    });
  }
})();
`;
}

export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT =
  buildPtcLabBrowserRuntimeScript({
    capability: 'ptc_lab_browser_user_url_navigation',
    evidence: { kind: 'none' },
  });

export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT =
  buildPtcLabBrowserRuntimeScript({
    capability: 'ptc_lab_browser_page_load_evidence',
    evidence: {
      kind: 'page_load_title',
      outputKey: 'title',
      failureCode: 'evidence_output_invalid',
    },
  });

export const PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT =
  buildPtcLabBrowserRuntimeScript({
    capability: 'ptc_lab_browser_dom_text_evidence',
    evidence: {
      kind: 'visible_text',
      outputKey: 'visibleText',
      failureCode: 'evidence_unavailable',
    },
  });
