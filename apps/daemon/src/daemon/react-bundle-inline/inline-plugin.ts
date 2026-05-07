import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Plugin, PluginBuild } from 'esbuild';

const ENTRY_WRAPPER_SPECIFIER = '__geulbat_inline_entry_wrapper__';
const INLINE_SPECIFIER_PREFIX = 'geulbat:inline/';
const INLINE_FILE_NAMESPACE = 'geulbat-inline-file';
const INLINE_ENTRY_WRAPPER_NAMESPACE = 'geulbat-inline-entry-wrapper';
const REACT_SHIM_NAMESPACE = 'geulbat-react-runtime-shim';
const REACT_INLINE_ROOT_REGISTRY_GLOBAL =
  '__GEULBAT_INLINE_REACT_ROOT_REGISTRY__';

const REACT_BARE_SPECIFIER_SET = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'scheduler',
]);

const RESOLVABLE_EXTENSIONS = [
  '',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.json',
];

export function createReactBundleInlinePlugin(args: {
  files: Record<string, string>;
  entry: string;
}): Plugin {
  const { files, entry } = args;

  return {
    name: 'geulbat-react-bundle-inline',
    setup(buildApi: PluginBuild) {
      buildApi.onResolve(
        { filter: new RegExp(`^${ENTRY_WRAPPER_SPECIFIER}$`) },
        () => ({
          path: ENTRY_WRAPPER_SPECIFIER,
          namespace: INLINE_ENTRY_WRAPPER_NAMESPACE,
        }),
      );

      buildApi.onLoad(
        { filter: /.*/, namespace: INLINE_ENTRY_WRAPPER_NAMESPACE },
        () => ({
          contents: createEntryWrapperModuleSource(entry),
          loader: 'js',
        }),
      );

      buildApi.onResolve(
        { filter: /^geulbat:inline\// },
        (resolveArgs: { path: string }) => ({
          path: resolveArgs.path.slice(INLINE_SPECIFIER_PREFIX.length),
          namespace: INLINE_FILE_NAMESPACE,
        }),
      );

      buildApi.onResolve(
        { filter: /^\.\.?\//, namespace: INLINE_FILE_NAMESPACE },
        (resolveArgs: { path: string; importer: string }) => {
          const resolvedPath = resolveRelativeInlineSpecifier(
            resolveArgs.path,
            resolveArgs.importer,
            files,
          );
          if (!resolvedPath.ok) {
            return toEsbuildResolveFailure(
              resolvedPath.code,
              resolvedPath.detail,
            );
          }
          return {
            path: resolvedPath.value,
            namespace: INLINE_FILE_NAMESPACE,
          };
        },
      );

      buildApi.onResolve(
        { filter: /^[^./].*/, namespace: INLINE_FILE_NAMESPACE },
        (resolveArgs: { path: string }) => {
          if (!REACT_BARE_SPECIFIER_SET.has(resolveArgs.path)) {
            return toEsbuildResolveFailure(
              'sanitize_rejected',
              `react bundle inline source import ${JSON.stringify(resolveArgs.path)} is unsupported; only relative imports and pinned react runtime shims are allowed`,
            );
          }
          return {
            path: resolveArgs.path,
            namespace: REACT_SHIM_NAMESPACE,
          };
        },
      );

      buildApi.onLoad(
        { filter: /.*/, namespace: INLINE_FILE_NAMESPACE },
        (loadArgs: { path: string }) => loadInlineModule(loadArgs.path, files),
      );

      buildApi.onLoad(
        { filter: /.*/, namespace: REACT_SHIM_NAMESPACE },
        (loadArgs: { path: string }) => ({
          contents: createReactRuntimeShimSource(loadArgs.path),
          loader: 'js',
        }),
      );
    },
  };
}

function createEntryWrapperModuleSource(entry: string): string {
  return [
    `import * as entryModule from ${JSON.stringify(`${INLINE_SPECIFIER_PREFIX}${entry}`)};`,
    '',
    'function createComponentRegistration(candidate) {',
    '  return {',
    '    mount({ root, runtime }) {',
    '      const reactRoot = runtime.createRoot(root);',
    '      reactRoot.render(runtime.createElement(candidate));',
    '      return () => reactRoot.unmount();',
    '    },',
    '  };',
    '}',
    '',
    'function createSelfBootstrappedCleanupRegistration() {',
    '  return {',
    '    mount({ root }) {',
    `      const registry = globalThis[${JSON.stringify(REACT_INLINE_ROOT_REGISTRY_GLOBAL)}];`,
    '      return () => {',
    '        const trackedRoot = registry?.get?.(root);',
    '        if (trackedRoot && typeof trackedRoot.unmount === "function") {',
    '          trackedRoot.unmount();',
    '          registry.delete(root);',
    '        }',
    '      };',
    '    },',
    '  };',
    '}',
    '',
    'function resolveEntryRegistration(moduleRecord) {',
    '  const defaultExport =',
    '    moduleRecord && typeof moduleRecord === "object" ? moduleRecord.default : undefined;',
    '  if (defaultExport && typeof defaultExport === "object" && typeof defaultExport.mount === "function") {',
    '    return defaultExport;',
    '  }',
    '  if (moduleRecord && typeof moduleRecord.mount === "function") {',
    '    return {',
    '      mount: moduleRecord.mount,',
    '      ...(typeof moduleRecord.unmount === "function" ? { unmount: moduleRecord.unmount } : {}),',
    '    };',
    '  }',
    '  if (typeof defaultExport === "function" || (defaultExport && typeof defaultExport === "object")) {',
    '    return createComponentRegistration(defaultExport);',
    '  }',
    '  return createSelfBootstrappedCleanupRegistration();',
    '}',
    '',
    'const bundleRegistration = resolveEntryRegistration(entryModule);',
    'export default bundleRegistration;',
    '',
  ].join('\n');
}

function resolveRelativeInlineSpecifier(
  specifier: string,
  importer: string,
  files: Record<string, string>,
):
  | { ok: true; value: string }
  | { ok: false; code: 'sanitize_rejected'; detail: string } {
  if (specifier.includes('?') || specifier.includes('#')) {
    return {
      ok: false,
      code: 'sanitize_rejected',
      detail: `react bundle inline source import ${JSON.stringify(specifier)} must not contain query or hash segments`,
    };
  }

  const importerDir = path.posix.dirname(importer);
  const basePath = path.posix.normalize(
    path.posix.join(importerDir, specifier),
  );
  if (basePath.startsWith('../') || basePath === '..') {
    return {
      ok: false,
      code: 'sanitize_rejected',
      detail: `react bundle inline source import ${JSON.stringify(specifier)} must not escape its root`,
    };
  }

  const candidates = buildInlineResolveCandidates(basePath);
  const resolvedPath = candidates.find((candidate) => candidate in files);
  if (!resolvedPath) {
    return {
      ok: false,
      code: 'sanitize_rejected',
      detail: `react bundle inline source import ${JSON.stringify(specifier)} from ${JSON.stringify(importer)} could not be resolved`,
    };
  }

  return {
    ok: true,
    value: resolvedPath,
  };
}

function buildInlineResolveCandidates(basePath: string): string[] {
  if (path.posix.extname(basePath)) {
    return [basePath];
  }

  return [
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.filter((extension) => extension !== '').map(
      (extension) => `${basePath}/index${extension}`,
    ),
  ];
}

function loadInlineModule(
  normalizedPath: string,
  files: Record<string, string>,
): { contents: string; loader: 'js' | 'jsx' | 'ts' | 'tsx' | 'json' } {
  const source = files[normalizedPath];
  if (typeof source !== 'string') {
    throw new Error(
      `react bundle inline source file ${normalizedPath} disappeared during compile`,
    );
  }

  const extension = path.posix.extname(normalizedPath);
  if (extension === '.css') {
    return {
      contents: createCssInjectionModuleSource(normalizedPath, source),
      loader: 'js',
    };
  }
  if (extension === '.jsx') {
    return { contents: source, loader: 'jsx' };
  }
  if (extension === '.ts') {
    return { contents: source, loader: 'ts' };
  }
  if (extension === '.tsx') {
    return { contents: source, loader: 'tsx' };
  }
  if (extension === '.json') {
    return { contents: source, loader: 'json' };
  }

  return { contents: source, loader: 'js' };
}

function createCssInjectionModuleSource(
  normalizedPath: string,
  cssSource: string,
): string {
  const styleId = `geulbat-inline-style-${createHash('sha256')
    .update(normalizedPath)
    .update('\0')
    .update(cssSource)
    .digest('hex')
    .slice(0, 16)}`;
  return [
    `const cssText = ${JSON.stringify(cssSource)};`,
    `const styleId = ${JSON.stringify(styleId)};`,
    'if (typeof document !== "undefined") {',
    '  let styleNode = document.getElementById(styleId);',
    '  if (!styleNode) {',
    '    styleNode = document.createElement("style");',
    '    styleNode.id = styleId;',
    '    styleNode.textContent = cssText;',
    '    document.head.append(styleNode);',
    '  }',
    '}',
    'export default cssText;',
    '',
  ].join('\n');
}

function createReactRuntimeShimSource(specifier: string): string {
  switch (specifier) {
    case 'react':
      return [
        'const runtime = globalThis.__GEULBAT_REACT_RUNTIME__;',
        'if (!runtime?.React) throw new Error("geulbat react runtime is unavailable");',
        'const React = runtime.React;',
        'export default React;',
        'export const Children = React.Children;',
        'export const Component = React.Component;',
        'export const Fragment = React.Fragment;',
        'export const Profiler = React.Profiler;',
        'export const PureComponent = React.PureComponent;',
        'export const StrictMode = React.StrictMode;',
        'export const Suspense = React.Suspense;',
        'export const cloneElement = React.cloneElement;',
        'export const createContext = React.createContext;',
        'export const createElement = React.createElement;',
        'export const createRef = React.createRef;',
        'export const forwardRef = React.forwardRef;',
        'export const isValidElement = React.isValidElement;',
        'export const lazy = React.lazy;',
        'export const memo = React.memo;',
        'export const startTransition = React.startTransition;',
        'export const use = React.use;',
        'export const useActionState = React.useActionState;',
        'export const useCallback = React.useCallback;',
        'export const useContext = React.useContext;',
        'export const useDebugValue = React.useDebugValue;',
        'export const useDeferredValue = React.useDeferredValue;',
        'export const useEffect = React.useEffect;',
        'export const useEffectEvent = React.useEffectEvent;',
        'export const useId = React.useId;',
        'export const useImperativeHandle = React.useImperativeHandle;',
        'export const useInsertionEffect = React.useInsertionEffect;',
        'export const useLayoutEffect = React.useLayoutEffect;',
        'export const useMemo = React.useMemo;',
        'export const useOptimistic = React.useOptimistic;',
        'export const useReducer = React.useReducer;',
        'export const useRef = React.useRef;',
        'export const useState = React.useState;',
        'export const useSyncExternalStore = React.useSyncExternalStore;',
        'export const useTransition = React.useTransition;',
        'export const version = React.version;',
        '',
      ].join('\n');
    case 'react/jsx-runtime':
      return [
        'const runtime = globalThis.__GEULBAT_REACT_RUNTIME__;',
        'if (!runtime?.React) throw new Error("geulbat react runtime is unavailable");',
        'const React = runtime.React;',
        'export const Fragment = React.Fragment;',
        'export function jsx(type, props, key) {',
        '  return key === undefined',
        '    ? React.createElement(type, props)',
        '    : React.createElement(type, { ...props, key });',
        '}',
        'export const jsxs = jsx;',
        'export const jsxDEV = jsx;',
        '',
      ].join('\n');
    case 'react-dom':
      return [
        'const runtime = globalThis.__GEULBAT_REACT_RUNTIME__;',
        'if (!runtime?.ReactDOM) throw new Error("geulbat react-dom runtime is unavailable");',
        'const ReactDOM = runtime.ReactDOM;',
        'export default ReactDOM;',
        'export const createPortal = ReactDOM.createPortal;',
        'export const flushSync = ReactDOM.flushSync;',
        'export const version = ReactDOM.version;',
        '',
      ].join('\n');
    case 'react-dom/client':
      return [
        'const runtime = globalThis.__GEULBAT_REACT_RUNTIME__;',
        'if (!runtime?.ReactDOMClient) throw new Error("geulbat react-dom/client runtime is unavailable");',
        'const ReactDOMClient = runtime.ReactDOMClient;',
        `const ROOT_REGISTRY_KEY = ${JSON.stringify(REACT_INLINE_ROOT_REGISTRY_GLOBAL)};`,
        'function getRootRegistry() {',
        '  if (!(globalThis[ROOT_REGISTRY_KEY] instanceof WeakMap)) {',
        '    globalThis[ROOT_REGISTRY_KEY] = new WeakMap();',
        '  }',
        '  return globalThis[ROOT_REGISTRY_KEY];',
        '}',
        'function trackRoot(container, root) {',
        '  if (container && (typeof container === "object" || typeof container === "function")) {',
        '    getRootRegistry().set(container, root);',
        '  }',
        '  return root;',
        '}',
        'export default ReactDOMClient;',
        'export function createRoot(container, options) {',
        '  return trackRoot(container, ReactDOMClient.createRoot(container, options));',
        '}',
        'export function hydrateRoot(container, children, options) {',
        '  return trackRoot(container, ReactDOMClient.hydrateRoot(container, children, options));',
        '}',
        'export const version = ReactDOMClient.version;',
        '',
      ].join('\n');
    case 'scheduler':
      return [
        'const runtime = globalThis.__GEULBAT_REACT_RUNTIME__;',
        'if (!runtime?.Scheduler) throw new Error("geulbat scheduler runtime is unavailable");',
        'const Scheduler = runtime.Scheduler;',
        'export default Scheduler;',
        'export const unstable_IdlePriority = Scheduler.unstable_IdlePriority;',
        'export const unstable_ImmediatePriority = Scheduler.unstable_ImmediatePriority;',
        'export const unstable_LowPriority = Scheduler.unstable_LowPriority;',
        'export const unstable_NormalPriority = Scheduler.unstable_NormalPriority;',
        'export const unstable_UserBlockingPriority = Scheduler.unstable_UserBlockingPriority;',
        'export const unstable_cancelCallback = Scheduler.unstable_cancelCallback;',
        'export const unstable_forceFrameRate = Scheduler.unstable_forceFrameRate;',
        'export const unstable_getCurrentPriorityLevel = Scheduler.unstable_getCurrentPriorityLevel;',
        'export const unstable_next = Scheduler.unstable_next;',
        'export const unstable_now = Scheduler.unstable_now;',
        'export const unstable_requestPaint = Scheduler.unstable_requestPaint;',
        'export const unstable_runWithPriority = Scheduler.unstable_runWithPriority;',
        'export const unstable_scheduleCallback = Scheduler.unstable_scheduleCallback;',
        'export const unstable_shouldYield = Scheduler.unstable_shouldYield;',
        'export const unstable_wrapCallback = Scheduler.unstable_wrapCallback;',
        '',
      ].join('\n');
    default:
      throw new Error(`unsupported react runtime shim specifier: ${specifier}`);
  }
}

function toEsbuildResolveFailure(
  code: 'sanitize_rejected' | 'policy_blocked',
  detail: string,
) {
  return {
    errors: [{ text: `[${code}] ${detail}` }],
  };
}
