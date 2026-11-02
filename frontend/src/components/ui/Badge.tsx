import type { ComponentPropsWithRef } from 'react';
import { cx } from './styles';
import { toneClass, type Tone } from './tones';

export const badgeClass = (tone: Tone): string =>
  cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', toneClass[tone]);

export type BadgeProps = Readonly<ComponentPropsWithRef<'span'>> & { readonly tone: Tone };

export const Badge = ({ tone, className, ...rest }: BadgeProps) => (
  <span className={cx(badgeClass(tone), className)} {...rest} />
);
