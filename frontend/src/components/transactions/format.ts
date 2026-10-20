const LOCALE = 'en-ZA';

export const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
