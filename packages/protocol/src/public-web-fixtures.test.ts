import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_WEB_DOM_COUNTER_PATH,
  PUBLIC_WEB_EVENTSOURCE_ECHO_PATH,
  PUBLIC_WEB_FIXTURE_PATH_PREFIX,
  PUBLIC_WEB_JSON_ECHO_PATH,
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH,
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH,
  PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
  PUBLIC_WEB_WEBSOCKET_ECHO_PATH,
  isPublicWebFixturePath,
} from './public-web-fixtures.js';

void test('public web fixture paths stay canonical and drift-resistant', () => {
  assert.equal(PUBLIC_WEB_FIXTURE_PATH_PREFIX, '/public-web/');
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
    '/public-web/react-bundle-counter/entry.js',
  );
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH,
    '/public-web/react-bundle-counter/counter-app.js',
  );
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
    '/public-web/react-bundle-hello-card/entry.js',
  );
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH,
    '/public-web/react-bundle-hello-card/hello-card-app.js',
  );
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
    '/public-web/react-bundle-runtime-dependencies/entry.js',
  );
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH,
    '/public-web/react-bundle-runtime-dependencies/dependency.js',
  );
  assert.equal(
    PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH,
    '/public-web/react-bundle-runtime-dependencies/theme.css',
  );
  assert.equal(PUBLIC_WEB_DOM_COUNTER_PATH, '/public-web/dom-counter.js');
  assert.equal(PUBLIC_WEB_JSON_ECHO_PATH, '/public-web/echo.json');
  assert.equal(PUBLIC_WEB_WEBSOCKET_ECHO_PATH, '/public-web/echo.ws');
  assert.equal(PUBLIC_WEB_EVENTSOURCE_ECHO_PATH, '/public-web/echo.sse');
  assert.equal(
    PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
    '/public-web/request-identity.json',
  );
});

void test('isPublicWebFixturePath only allows the dedicated public fixture namespace', () => {
  assert.equal(
    isPublicWebFixturePath('/public-web/react-bundle-counter/entry.js'),
    true,
  );
  assert.equal(
    isPublicWebFixturePath('/public-web/react-bundle-hello-card/entry.js'),
    true,
  );
  assert.equal(isPublicWebFixturePath('/artifact-runtime/host'), false);
  assert.equal(isPublicWebFixturePath('/api/files/read'), false);
});
