import type { ReactNode } from 'react';

export type PageHeaderProps = {
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly children?: ReactNode;
};

export const PageHeader = ({ title, titleId, children }: PageHeaderProps) => (
  <header className="mb-8 space-y-2">
    <h1 id={titleId} className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
      {title}
    </h1>
    {children ? <div className="text-sm text-muted">{children}</div> : null}
  </header>
);
