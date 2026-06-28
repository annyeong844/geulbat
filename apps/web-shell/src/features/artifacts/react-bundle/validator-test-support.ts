import { PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH } from '@geulbat/protocol/public-web-fixtures';
import { PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX } from '@geulbat/protocol/react-bundle-inline-compile';

export const REACT_BUNDLE_ENTRY_URL = `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
export const LOCAL_FIXTURE_ENTRY_URL = `http://127.0.0.1:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
export const LOCAL_IPV6_MAPPED_FIXTURE_ENTRY_URL = `http://[::ffff:7f00:1]:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
export const LOCAL_GENERATED_ENTRY_URL = `http://127.0.0.1:3456${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX}cache-key/entry.js`;
export const CDN_ENTRY_URL = 'https://cdn.example.com/react-entry.js';
export const REMOTE_HTTP_FIXTURE_ENTRY_URL = `http://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
export const PRIVATE_ENTRY_URL = `https://192.168.0.1${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
