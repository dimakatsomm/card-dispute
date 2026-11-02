import type { ReactNode } from 'react';

export const Loading = ({ children }: { readonly children: ReactNode }) => (
  <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
    <span aria-hidden="true" className="size-2 rounded-full bg-accent-light motion-safe:animate-pulse" />
    {children}
  </p>
);

export const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</p>
);
