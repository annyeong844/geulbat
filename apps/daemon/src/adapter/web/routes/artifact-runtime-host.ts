import { Router } from 'express';
import {
  ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  createArtifactRuntimeHostReadyMessage,
} from '@geulbat/protocol/artifact-runtime-host';
import { isAllowedBrowserOrigin } from '#web/origin-policy.js';

const ARTIFACT_RUNTIME_HOST_PATH = '/artifact-runtime/host';
const ARTIFACT_RUNTIME_CACHE_PROBE_PATH = '/artifact-runtime/probe-cache.txt';
const ARTIFACT_RUNTIME_SERVICE_WORKER_PROBE_PATH =
  '/artifact-runtime/probe-sw.js';
const ARTIFACT_RUNTIME_CACHE_PROBE_BODY =
  'geulbat-artifact-runtime-cache-probe';
const ARTIFACT_RUNTIME_HOST_BASE_CSP_DIRECTIVES = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data: http: https:",
  'connect-src blob: data: http: https: ws: wss:',
  'img-src blob: data: http: https:',
  "style-src 'unsafe-inline' blob: data: http: https:",
  'font-src blob: data: http: https:',
  'media-src blob: data: http: https:',
  "worker-src 'self' blob: data: http: https:",
  'frame-src blob: data: http: https:',
  'form-action http: https:',
] as const;
const ARTIFACT_RUNTIME_HOST_DOCUMENT_REPLACER = String.raw`async (html) => {
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
                        'artifact runtime host script failed to load or execute',
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
const ARTIFACT_RUNTIME_SERVICE_WORKER_PROBE_SOURCE = `self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') {
    return;
  }
  if (event.data.kind === 'geulbat.artifact_runtime_sw_probe') {
    event.source?.postMessage({
      kind: 'geulbat.artifact_runtime_sw_probe',
      ok: true,
      scope: self.registration.scope,
    });
  }
});
`;

export function createArtifactRuntimeHostRoutes(args?: {
  configuredAllowedOrigins?: ReadonlySet<string>;
}) {
  const router = Router();
  const configuredAllowedOrigins =
    args?.configuredAllowedOrigins ?? new Set<string>();
  const contentSecurityPolicy = buildArtifactRuntimeHostContentSecurityPolicy(
    configuredAllowedOrigins,
  );

  router.get(ARTIFACT_RUNTIME_HOST_PATH, (req, res) => {
    const parentOrigin = normalizeArtifactRuntimeParentOrigin(
      req.query['parentOrigin'],
      configuredAllowedOrigins,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    res.status(200).send(buildArtifactRuntimeHostHtml(parentOrigin));
  });

  router.get(ARTIFACT_RUNTIME_CACHE_PROBE_PATH, (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(ARTIFACT_RUNTIME_CACHE_PROBE_BODY);
  });

  router.get(ARTIFACT_RUNTIME_SERVICE_WORKER_PROBE_PATH, (_req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Service-Worker-Allowed', '/artifact-runtime/');
    res.status(200).send(ARTIFACT_RUNTIME_SERVICE_WORKER_PROBE_SOURCE);
  });

  return router;
}

function buildArtifactRuntimeHostHtml(parentOrigin: string | null): string {
  const readyMessageJson = JSON.stringify(
    createArtifactRuntimeHostReadyMessage(),
  );
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>geulbat artifact runtime host</title>
    <script>
      (() => {
        const MESSAGE_KIND = '${ARTIFACT_RUNTIME_HOST_MESSAGE_KIND}';
        const BOOT_ACTION = '${ARTIFACT_RUNTIME_HOST_BOOT_ACTION}';
        const READY_MESSAGE = ${readyMessageJson};
        const parentOrigin = ${JSON.stringify(parentOrigin)};
        const replaceDocumentWithHtml = ${ARTIFACT_RUNTIME_HOST_DOCUMENT_REPLACER};
        let booted = false;
        let readyIntervalId = null;

        const stopReadyLoop = () => {
          if (readyIntervalId === null) {
            return;
          }
          window.clearInterval(readyIntervalId);
          readyIntervalId = null;
        };

        const canPostToParent = () =>
          typeof parentOrigin === 'string' &&
          parentOrigin.length > 0 &&
          !!window.parent &&
          window.parent !== window;

        const postReady = () => {
          if (booted || !canPostToParent()) {
            return;
          }
          window.parent.postMessage(
            READY_MESSAGE,
            parentOrigin,
          );
        };

        window.addEventListener(
          'message',
          (event) => {
            if (booted) {
              return;
            }
            if (!canPostToParent() || event.origin !== parentOrigin) {
              return;
            }
            const data = event.data;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              return;
            }
            if (
              data.kind !== MESSAGE_KIND ||
              data.action !== BOOT_ACTION ||
              typeof data.documentHtml !== 'string'
            ) {
              return;
            }
            booted = true;
            stopReadyLoop();
            void replaceDocumentWithHtml(data.documentHtml).catch((error) => {
              console.error('geulbat artifact runtime host boot failed', error);
            });
          },
        );

        postReady();
        readyIntervalId = window.setInterval(postReady, 250);
        window.setTimeout(stopReadyLoop, 5000);
      })();
    </script>
  </head>
  <body></body>
</html>
`;
}

function buildArtifactRuntimeHostFrameAncestors(
  configuredAllowedOrigins: ReadonlySet<string>,
): string {
  const sources = new Set<string>([
    "'self'",
    'http://127.0.0.1:*',
    'http://localhost:*',
    'https://127.0.0.1:*',
    'https://localhost:*',
    ...configuredAllowedOrigins,
  ]);
  return `frame-ancestors ${Array.from(sources).join(' ')}`;
}

function buildArtifactRuntimeHostContentSecurityPolicy(
  configuredAllowedOrigins: ReadonlySet<string>,
): string {
  return [
    ...ARTIFACT_RUNTIME_HOST_BASE_CSP_DIRECTIVES,
    buildArtifactRuntimeHostFrameAncestors(configuredAllowedOrigins),
  ].join('; ');
}

function normalizeArtifactRuntimeParentOrigin(
  value: unknown,
  configuredAllowedOrigins: ReadonlySet<string>,
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return isAllowedBrowserOrigin(url.origin, configuredAllowedOrigins)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
