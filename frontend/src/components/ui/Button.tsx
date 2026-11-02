import type { ComponentPropsWithRef } from 'react';
import { Link, type LinkProps } from 'react-router';
import { buttonClass, cx, type ButtonSize, type ButtonVariant } from './styles';

type Look = { readonly variant?: ButtonVariant; readonly size?: ButtonSize; readonly wrap?: boolean };

export type ButtonProps = Readonly<ComponentPropsWithRef<'button'>> & Look;

export const Button = ({ variant, size, wrap, className, type = 'button', ...rest }: ButtonProps) => (
  <button type={type} className={cx(buttonClass(variant, size, wrap), className)} {...rest} />
);

export type ButtonLinkProps = Readonly<Omit<LinkProps, 'className'>> & Look & { readonly className?: string };

export const ButtonLink = ({ variant, size, wrap, className, ...rest }: ButtonLinkProps) => (
  <Link className={cx(buttonClass(variant, size, wrap), className)} {...rest} />
);
