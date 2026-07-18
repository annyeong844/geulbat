const ARTIFACT_RUNTIME_HTML_RESIZE_HELPER = String.raw`(() => {
  const MESSAGE_KIND = 'geulbat.artifact_runtime_host';
  const targetOrigin = window.__GEULBAT_PARENT_ORIGIN__;
  const sendResize = () => {
    const docEl = document.documentElement;
    const body = document.body;
    // docEl/body의 client·scrollHeight는 뷰포트(현재 프레임 높이)와 결합돼
    // 한 번 커진 프레임이 다시 줄지 않는 래칫을 만든다 — 실제 콘텐츠
    // 높이(rect, body 스크롤 범위)만 보고한다.
    const height = Math.max(
      Math.ceil(docEl?.getBoundingClientRect?.().height ?? 0),
      Math.ceil(body?.getBoundingClientRect?.().height ?? 0),
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
    );
    if (
      window.parent &&
      window.parent !== window &&
      typeof targetOrigin === 'string' &&
      targetOrigin.length > 0
    ) {
      window.parent.postMessage(
        {
          kind: MESSAGE_KIND,
          action: 'resize',
          height,
        },
        targetOrigin,
      );
    }
  };

  let rafId = 0;
  const scheduleResize = () => {
    if (rafId !== 0) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      sendResize();
    });
  };

  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(document.documentElement);
    if (document.body) {
      resizeObserver.observe(document.body);
    }
  }

  window.addEventListener('load', scheduleResize);
  window.addEventListener('resize', scheduleResize);
  window.setTimeout(scheduleResize, 0);
  window.setTimeout(scheduleResize, 120);
  scheduleResize();
})();`;

// 프레임 → 부모 back-channel helper. scopeHandle과 parentOrigin은 호스트
// 런타임 문서가 window 전역으로 심어 두므로 아티팩트 코드가 위조할 수 없는
// 자기 프레임 값만 쓸 수 있다. sendPrompt는 위젯 마크업의 onclick에서 바로
// 부를 수 있는 편의 전역이다 (이미 정의돼 있으면 건드리지 않는다).
const ARTIFACT_RUNTIME_AGENT_HELPER = String.raw`(() => {
  const MESSAGE_KIND = 'geulbat.artifact_runtime_agent';
  const TOOL_RESULT_KIND = 'geulbat.shell.agent_tool_result';
  const targetOrigin = window.__GEULBAT_PARENT_ORIGIN__;
  const scopeHandle = window.__GEULBAT_SCOPE_HANDLE__;
  const canPost = () =>
    window.parent &&
    window.parent !== window &&
    typeof targetOrigin === 'string' &&
    targetOrigin.length > 0 &&
    typeof scopeHandle === 'string' &&
    scopeHandle.length > 0;
  const post = (action, payload) => {
    if (!canPost()) {
      return;
    }
    window.parent.postMessage(
      { kind: MESSAGE_KIND, action, scopeHandle, ...payload },
      targetOrigin,
    );
  };
  const requestPrompt = (text, options) => {
    const payload = { text: String(text) };
    const displayText = options && options.displayText;
    if (typeof displayText === 'string' && displayText.length > 0) {
      payload.displayText = displayText;
    }
    post('request_prompt', payload);
  };
  const requestInterject = (text) => {
    post('request_interject', { text: String(text) });
  };
  // 도구 호출 — requestId 상관 pending Map으로 Promise를 돌려준다. 결과는
  // 부모가 TOOL_RESULT_KIND postMessage로 회신하며, 부모 origin/source가
  // 아닌 메시지는 무시한다.
  let toolRequestSeq = 0;
  const pendingToolRequests = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== targetOrigin) {
      return;
    }
    const data = event.data;
    if (
      !data ||
      data.kind !== TOOL_RESULT_KIND ||
      typeof data.requestId !== 'string'
    ) {
      return;
    }
    const resolvePending = pendingToolRequests.get(data.requestId);
    if (!resolvePending) {
      return;
    }
    pendingToolRequests.delete(data.requestId);
    resolvePending(data.result);
  });
  const requestTool = (toolName, args) => {
    if (!canPost()) {
      return Promise.resolve({
        ok: false,
        errorCode: 'unavailable',
        error: 'agent channel unavailable',
      });
    }
    toolRequestSeq += 1;
    const requestId = 'af-' + String(toolRequestSeq);
    return new Promise((resolve) => {
      pendingToolRequests.set(requestId, resolve);
      post('request_tool', {
        requestId,
        toolName: String(toolName),
        args: args && typeof args === 'object' ? args : {},
      });
    });
  };
  window.geulbat = Object.freeze({
    requestPrompt,
    requestInterject,
    requestTool,
  });
  if (typeof window.sendPrompt !== 'function') {
    window.sendPrompt = requestPrompt;
  }
})();`;

const ARTIFACT_RUNTIME_DOCUMENT_REPLACER = String.raw`async (html) => {
  const parser = new DOMParser();
  const parsedDocument = parser.parseFromString(html, 'text/html');

  const syncAttributes = (target, source) => {
    for (const attr of Array.from(target.attributes)) {
      if (!source.hasAttribute(attr.name)) {
        target.removeAttribute(attr.name);
      }
    }
    for (const attr of Array.from(source.attributes)) {
      if (attr.namespaceURI) {
        target.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      } else {
        target.setAttribute(attr.name, attr.value);
      }
    }
  };

  const appendParsedNode = async (parent, parsedNode) => {
    if (parsedNode.nodeType === Node.ELEMENT_NODE) {
      const parsedElement = parsedNode;
      if (parsedElement.tagName.toLowerCase() === 'script') {
        const script = document.createElement('script');
        const scriptType = parsedElement.getAttribute('type')?.trim().toLowerCase() ?? '';
        for (const attr of Array.from(parsedElement.attributes)) {
          if (attr.namespaceURI) {
            script.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
          } else {
            script.setAttribute(attr.name, attr.value);
          }
        }
        if (
          parsedElement.hasAttribute('src') &&
          scriptType !== 'module' &&
          !parsedElement.hasAttribute('async') &&
          !parsedElement.hasAttribute('defer')
        ) {
          script.async = false;
        }
        if (!parsedElement.hasAttribute('src')) {
          script.textContent = parsedElement.textContent;
        }
        const waitForScript =
          parsedElement.hasAttribute('src') || scriptType === 'module'
            ? new Promise((resolve, reject) => {
                script.addEventListener('load', () => resolve(undefined), {
                  once: true,
                });
                script.addEventListener(
                  'error',
                  () =>
                    reject(
                      new Error(
                        'html artifact script failed to load or execute',
                      ),
                    ),
                  { once: true },
                );
              })
            : null;
        parent.appendChild(script);
        if (waitForScript !== null) {
          await waitForScript;
        }
        return;
      }

      const clone = document.importNode(parsedElement, false);
      parent.appendChild(clone);
      for (const childNode of Array.from(parsedElement.childNodes)) {
        await appendParsedNode(clone, childNode);
      }
      return;
    }

    if (
      parsedNode.nodeType === Node.TEXT_NODE ||
      parsedNode.nodeType === Node.CDATA_SECTION_NODE ||
      parsedNode.nodeType === Node.COMMENT_NODE
    ) {
      parent.appendChild(document.importNode(parsedNode, false));
    }
  };

  const replaceContainer = async (target, source) => {
    syncAttributes(target, source);
    while (target.firstChild) {
      target.removeChild(target.firstChild);
    }
    for (const childNode of Array.from(source.childNodes)) {
      await appendParsedNode(target, childNode);
    }
  };

  syncAttributes(document.documentElement, parsedDocument.documentElement);
  await replaceContainer(document.head, parsedDocument.head);
  await replaceContainer(document.body, parsedDocument.body);
}`;

export function buildHtmlArtifactRuntimePayload(payload: string): string {
  const instrumentedPayload = injectHtmlRuntimeHelpers(payload);
  const escapedPayload = JSON.stringify(instrumentedPayload).replace(
    /</g,
    '\\u003C',
  );
  return [
    `const __geulbatHtmlPayload__ = ${escapedPayload};`,
    `const __geulbatReplaceDocumentWithHtml__ = ${ARTIFACT_RUNTIME_DOCUMENT_REPLACER};`,
    '__geulbatReplaceDocumentWithHtml__(__geulbatHtmlPayload__);',
  ].join('\n');
}

function injectHtmlRuntimeHelpers(payload: string): string {
  const helperTag = [
    `<script>${ARTIFACT_RUNTIME_AGENT_HELPER}</script>`,
    `<script>${ARTIFACT_RUNTIME_HTML_RESIZE_HELPER}</script>`,
  ].join('');
  if (/<\/body\s*>/i.test(payload)) {
    return payload.replace(/<\/body\s*>/i, `${helperTag}</body>`);
  }
  if (/<\/html\s*>/i.test(payload)) {
    return payload.replace(/<\/html\s*>/i, `${helperTag}</html>`);
  }
  return `${payload}${helperTag}`;
}
