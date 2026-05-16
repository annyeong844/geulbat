export const PUBLIC_WEB_FIXTURE_PATH_PREFIX = '/public-web/';
export const PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-counter/entry.js`;
export const PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-counter/counter-app.js`;
export const PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-hello-card/entry.js`;
export const PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-hello-card/hello-card-app.js`;
export const PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-runtime-dependencies/entry.js`;
export const PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-runtime-dependencies/dependency.js`;
export const PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}react-bundle-runtime-dependencies/theme.css`;
export const PUBLIC_WEB_DOM_COUNTER_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}dom-counter.js`;
export const PUBLIC_WEB_JSON_ECHO_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}echo.json`;
export const PUBLIC_WEB_WEBSOCKET_ECHO_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}echo.ws`;
export const PUBLIC_WEB_EVENTSOURCE_ECHO_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}echo.sse`;
export const PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH = `${PUBLIC_WEB_FIXTURE_PATH_PREFIX}request-identity.json`;

export function isPublicWebFixturePath(pathname: string): boolean {
  return pathname.startsWith(PUBLIC_WEB_FIXTURE_PATH_PREFIX);
}
