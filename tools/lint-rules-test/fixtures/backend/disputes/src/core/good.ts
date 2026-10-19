export const add = (a: number, b: number): number => a + b;

export const total = (xs: readonly number[]): number => xs.reduce(add, 0);
