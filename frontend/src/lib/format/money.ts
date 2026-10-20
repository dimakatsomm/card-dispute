const LOCALE = 'en-ZA';
const DECIMAL = /^-?\d+(\.\d+)?$/;

const fallback = (amount: string, currency: string): string => `${currency} ${amount}`;

// Intl formats the decimal string exactly (never via a float); it throws RangeError on a malformed currency code.
export const formatMoney = (amount: string, currency: string): string => {
  if (!DECIMAL.test(amount)) return fallback(amount, currency);
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(amount as Intl.StringNumericLiteral);
  } catch {
    return fallback(amount, currency);
  }
};
