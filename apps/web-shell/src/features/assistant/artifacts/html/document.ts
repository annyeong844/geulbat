const ARTIFACT_RUNTIME_HTML_RESIZE_HELPER = String.raw`(() => {
  const MESSAGE_KIND = 'geulbat.artifact_runtime_host';
  const targetOrigin = window.__GEULBAT_PARENT_ORIGIN__;
  const sendResize = () => {
    const docEl = document.documentElement;
    const body = document.body;
    const height = Math.max(
      Math.ceil(docEl?.getBoundingClientRect?.().height ?? 0),
      Math.ceil(body?.getBoundingClientRect?.().height ?? 0),
      docEl?.scrollHeight ?? 0,
      docEl?.offsetHeight ?? 0,
      docEl?.clientHeight ?? 0,
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      body?.clientHeight ?? 0,
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
  const instrumentedPayload = injectHtmlResizeHelper(payload);
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

function injectHtmlResizeHelper(payload: string): string {
  const helperTag = `<script>${ARTIFACT_RUNTIME_HTML_RESIZE_HELPER}</script>`;
  if (/<\/body\s*>/i.test(payload)) {
    return payload.replace(/<\/body\s*>/i, `${helperTag}</body>`);
  }
  if (/<\/html\s*>/i.test(payload)) {
    return payload.replace(/<\/html\s*>/i, `${helperTag}</html>`);
  }
  return `${payload}${helperTag}`;
}
