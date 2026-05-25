import { sanitizeProviderAuthMessage } from './session-store.js';

interface ProviderAuthCallbackPage {
  html: string;
  statusCode: number;
}

export function successPage(args?: {
  clearProviderAuthBootstrapState?: () => void;
}): ProviderAuthCallbackPage {
  args?.clearProviderAuthBootstrapState?.();
  return {
    statusCode: 200,
    html: renderCallbackHtml(
      'Provider connected',
      'Provider login completed. You can close this tab and return to Geulbat.',
    ),
  };
}

export function failurePage(
  statusCode: number,
  title: string,
  message: string,
): ProviderAuthCallbackPage {
  return {
    statusCode,
    html: renderCallbackHtml(title, sanitizeProviderAuthMessage(message)),
  };
}

function renderCallbackHtml(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 32px; color: #222; background: #fafafa; }
      main { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 24px; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { font-size: 14px; line-height: 1.6; margin: 0; color: #444; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
