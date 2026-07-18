import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type FetchResponder = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

export function installShellAuthDocument(token = 'test-dev-token') {
  void token;

  return () => {
    return;
  };
}

export function installFetchSequence(...responders: FetchResponder[]) {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  let index = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    const responder = responders[index];
    index += 1;
    if (!responder) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }
    return await responder(url, init);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

interface HookHarness<T, P> {
  readonly result: { readonly current: T };
  run<R>(callback: (current: T) => R | Promise<R>): Promise<R>;
  rerender(nextProps: P): Promise<void>;
  flush(): Promise<void>;
  unmount(): void;
}

export async function renderHook<T, P>(
  useHook: (props: P) => T,
  initialProps: P,
): Promise<HookHarness<T, P>> {
  let current!: T;
  let renderer!: ReactTestRenderer;

  function HookComponent(props: { hookProps: P }) {
    current = useHook(props.hookProps);
    return null;
  }

  await act(async () => {
    renderer = TestRenderer.create(
      createElement(HookComponent, { hookProps: initialProps }),
    );
    await Promise.resolve();
  });

  return {
    result: {
      get current() {
        return current;
      },
    },
    async run<R>(callback: (current: T) => R | Promise<R>) {
      let value!: R;
      await act(async () => {
        value = await callback(current);
      });
      return value;
    },
    async rerender(nextProps: P) {
      await act(async () => {
        renderer.update(createElement(HookComponent, { hookProps: nextProps }));
        await Promise.resolve();
      });
    },
    async flush() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    },
  };
}
