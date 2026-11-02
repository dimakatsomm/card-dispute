export const cx = (...parts: ReadonlyArray<string | false | null | undefined>): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');

export const focusRing =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerOutline' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const buttonVariants: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-accent text-white shadow-sm hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'border border-line bg-surface text-ink shadow-sm hover:bg-zinc-50 disabled:hover:bg-surface',
  danger: 'bg-danger text-white shadow-sm hover:bg-danger-strong disabled:hover:bg-danger',
  dangerOutline:
    'border border-danger-line bg-surface text-danger-strong shadow-sm hover:bg-danger-soft disabled:hover:bg-surface',
  ghost: 'text-zinc-700 hover:bg-zinc-100 hover:text-ink',
};

const buttonSizes: Readonly<Record<ButtonSize, string>> = {
  sm: 'min-h-8 px-3 py-1 text-sm',
  md: 'min-h-10 px-4 py-2 text-sm',
};

export const buttonClass = (variant: ButtonVariant = 'primary', size: ButtonSize = 'md', wrap = false): string =>
  cx(
    buttonBase,
    buttonVariants[variant],
    buttonSizes[size],
    wrap ? 'text-left [overflow-wrap:anywhere]' : 'whitespace-nowrap',
    focusRing,
  );

export const linkClass = cx(
  'rounded-sm font-medium text-accent underline-offset-4 hover:text-accent-hover hover:underline',
  focusRing,
);

export const cardClass = 'rounded-card border border-line bg-surface shadow-sm';

export const panelClass = cx(cardClass, 'space-y-4 p-5 sm:p-6');

export const listClass = 'divide-y divide-zinc-100 rounded-lg border border-line';

export const labelClass = 'block text-sm font-medium text-ink';

export const controlClass = cx(
  'block w-full rounded-lg border border-zinc-300 bg-surface px-3 py-2 text-sm text-ink shadow-xs',
  'placeholder:text-zinc-400 focus:border-focus focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus/40',
  'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-muted',
  'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/30',
);

export const hintClass = 'text-xs text-muted';

export const errorClass = 'text-sm font-medium text-danger';

export const mutedClass = 'text-sm text-muted';

export const errorCardClass =
  'flex flex-col items-start gap-3 rounded-card border border-danger-line bg-danger-soft/60 p-4 text-sm font-medium text-danger-ink sm:flex-row sm:items-center sm:justify-between';

export const errorBannerClass =
  'rounded-lg border border-danger-line bg-danger-soft/60 px-4 py-3 text-sm font-medium text-danger-ink';

export const successBannerClass =
  'rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm font-medium text-emerald-800';

export const sectionTitleClass = 'text-base font-semibold text-ink';

export const definitionListClass =
  'grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr] sm:gap-y-3 [&>dd]:mb-2 sm:[&>dd]:mb-0';

export const termClass = 'font-medium text-muted';

export const pageGutterClass = 'mx-auto w-full max-w-5xl px-4 sm:px-6';
