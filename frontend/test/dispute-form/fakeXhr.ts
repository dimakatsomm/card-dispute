import { vi } from 'vitest';

export type FakeXhr = {
  readonly method: () => string | null;
  readonly url: () => string | null;
  readonly headers: () => Readonly<Record<string, string>>;
  readonly body: () => unknown;
  readonly progress: (loaded: number, total: number) => void;
  readonly respond: (status: number) => void;
  readonly failNetwork: () => void;
  readonly xhr: XMLHttpRequest;
};

type Handler = ((event: ProgressEvent) => void) | null;

export const createFakeXhr = (): FakeXhr => {
  const state = {
    method: null as string | null,
    url: null as string | null,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const fake = {
    status: 0,
    upload: { onprogress: null as Handler },
    onload: null as Handler,
    onerror: null as Handler,
    onabort: null as Handler,
    ontimeout: null as Handler,
    open: (method: string, url: string) => {
      state.method = method;
      state.url = url;
    },
    setRequestHeader: (name: string, value: string) => {
      state.headers[name] = value;
    },
    send: (body: unknown) => {
      state.body = body;
    },
  };
  const event = (loaded = 0, total = 0) => ({ lengthComputable: total > 0, loaded, total }) as ProgressEvent;
  return {
    method: () => state.method,
    url: () => state.url,
    headers: () => ({ ...state.headers }),
    body: () => state.body,
    progress: (loaded, total) => fake.upload.onprogress?.(event(loaded, total)),
    respond: (status) => {
      fake.status = status;
      fake.onload?.(event());
    },
    failNetwork: () => fake.onerror?.(event()),
    xhr: fake as unknown as XMLHttpRequest,
  };
};

// A plain function used with `new` returns the object it builds, so no class is needed for the stub.
export const installFakeXhr = (): { readonly instances: ReadonlyArray<FakeXhr> } => {
  const instances: FakeXhr[] = [];
  vi.stubGlobal(
    'XMLHttpRequest',
    vi.fn(function FakeXMLHttpRequest() {
      const created = createFakeXhr();
      instances.push(created);
      return created.xhr;
    }),
  );
  return { instances };
};
