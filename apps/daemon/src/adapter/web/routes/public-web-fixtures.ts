import { Router, type Response } from 'express';
import {
  PUBLIC_WEB_DOM_COUNTER_PATH,
  PUBLIC_WEB_EVENTSOURCE_ECHO_PATH,
  PUBLIC_WEB_JSON_ECHO_PATH,
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH,
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
  PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
} from '@geulbat/protocol/public-web-fixtures';

const PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_SOURCE = `import { mountCounterApp } from './counter-app.js';

export default {
  mount(args) {
    return mountCounterApp(args);
  },
};
`;

const PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_SOURCE = `export function mountCounterApp({ root, runtime, storage }) {
  const { React, createRoot } = runtime;

  function App() {
    const [count, setCount] = React.useState(0);
    React.useEffect(() => {
      try {
        storage?.set?.('publicWebFixture.reactBundleCounter', {
          booted: true,
        });
      } catch (error) {
        console.warn('react bundle fixture storage probe failed', error);
      }
    }, []);

    return React.createElement(
      'button',
      {
        id: 'count',
        onClick() {
          setCount((value) => value + 1);
        },
      },
      \`count:\${count}\`,
    );
  }

  const reactRoot = createRoot(root);
  reactRoot.render(React.createElement(App));
  return () => reactRoot.unmount();
}
`;

const PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_SOURCE = `import { mountHelloCardApp } from './hello-card-app.js';

export default {
  mount(args) {
    return mountHelloCardApp(args);
  },
};
`;

const PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_SOURCE = `export function mountHelloCardApp({ root, runtime, storage }) {
  const { React, createRoot } = runtime;

  const shellStyle = {
    fontFamily: 'sans-serif',
    padding: 24,
    maxWidth: 520,
    margin: '40px auto',
    border: '1px solid #e5e7eb',
    borderRadius: 16,
    background: '#ffffff',
    boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
  };

  const buttonStyle = {
    padding: '10px 14px',
    borderRadius: 10,
    border: 'none',
    background: '#2563eb',
    color: 'white',
    cursor: 'pointer',
  };

  function App() {
    const [count, setCount] = React.useState(0);

    React.useEffect(() => {
      try {
        storage?.set?.('publicWebFixture.reactHelloCard', {
          booted: true,
        });
      } catch (error) {
        console.warn('react hello-card fixture storage probe failed', error);
      }
    }, []);

    return React.createElement(
      'div',
      { style: shellStyle },
      React.createElement(
        'h1',
        { id: 'title', style: { marginTop: 0 } },
        '안녕하세요 ;ㅅ;',
      ),
      React.createElement('p', null, '요청하신 React 아티팩트 예시예요.'),
      React.createElement(
        'button',
        {
          id: 'count-button',
          onClick() {
            setCount((value) => value + 1);
          },
          style: buttonStyle,
        },
        '눌러보세요',
      ),
      React.createElement(
        'p',
        { id: 'count-output', style: { marginTop: 16 } },
        \`클릭 수: \${count}\`,
      ),
    );
  }

  const reactRoot = createRoot(root);
  reactRoot.render(React.createElement(App));
  return () => reactRoot.unmount();
}
`;

const PUBLIC_WEB_DOM_COUNTER_SOURCE = `const button = document.getElementById('btn');
const value = document.getElementById('value');
let count = Number(value?.textContent ?? '0');

button?.addEventListener('click', () => {
  count += 1;
  if (value) {
    value.textContent = String(count);
  }
});
`;

export function createPublicWebFixtureRoutes() {
  const router = Router();

  router.get(PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH, (_req, res) => {
    sendJavascriptFixture(res, PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_SOURCE);
  });

  router.get(PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH, (_req, res) => {
    sendJavascriptFixture(res, PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_SOURCE);
  });

  router.get(PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH, (_req, res) => {
    sendJavascriptFixture(res, PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_SOURCE);
  });

  router.get(PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH, (_req, res) => {
    sendJavascriptFixture(res, PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_SOURCE);
  });

  router.get(PUBLIC_WEB_DOM_COUNTER_PATH, (_req, res) => {
    sendJavascriptFixture(res, PUBLIC_WEB_DOM_COUNTER_SOURCE);
  });

  router.get(PUBLIC_WEB_JSON_ECHO_PATH, (req, res) => {
    sendJsonFixture(res, {
      message: readStringQueryValue(req.query['message']) ?? '',
      method: req.method,
      path: PUBLIC_WEB_JSON_ECHO_PATH,
    });
  });

  router.get(PUBLIC_WEB_EVENTSOURCE_ECHO_PATH, (req, res) => {
    sendEventStreamFixture(
      res,
      readStringQueryValue(req.query['message']) ?? '',
    );
  });

  router.get(PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH, (req, res) => {
    sendJsonFixture(res, {
      method: req.method,
      path: PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
      cookie: readHeaderValue(req.headers['cookie']),
      authorization: readHeaderValue(req.headers['authorization']),
      devToken: readHeaderValue(req.headers['x-geulbat-dev-token']),
      referrer: readHeaderValue(
        req.headers['referer'] ?? req.headers['referrer'],
      ),
    });
  });

  return router;
}

function sendJavascriptFixture(res: Response, source: string): void {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.status(200).send(source);
}

function sendJsonFixture(res: Response, body: Record<string, string>): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.status(200).send(JSON.stringify(body));
}

function sendEventStreamFixture(res: Response, message: string): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.status(200).send(formatServerSentEventData(message));
}

function formatServerSentEventData(value: string): string {
  return `${value
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`;
}

function readStringQueryValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function readHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return '';
}
