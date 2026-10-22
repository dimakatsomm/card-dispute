import { randomInt } from 'node:crypto';

const CLASSES = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%*+-.=?@^_~'] as const;
const ALL = CLASSES.join('');
export const PASSWORD_LENGTH = 24;

export type RandomInt = (maxExclusive: number) => number;

const charAt = (alphabet: string, random: RandomInt): string => alphabet.charAt(random(alphabet.length));

// One of each class first so the Cognito policy (upper, lower, digit, symbol) always holds, then a Fisher-Yates shuffle.
export const generatePassword = (random: RandomInt = randomInt): string => {
  const chars = [
    ...CLASSES.map((c) => charAt(c, random)),
    ...Array.from({ length: PASSWORD_LENGTH - CLASSES.length }, () => charAt(ALL, random)),
  ];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j] ?? '', chars[i] ?? ''];
  }
  return chars.join('');
};
