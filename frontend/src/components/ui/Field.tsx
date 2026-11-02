import type { ComponentPropsWithRef, ReactNode } from 'react';
import { controlClass, cx, errorClass, hintClass, labelClass } from './styles';

export const Field = ({ children }: { readonly children: ReactNode }) => <div className="space-y-1.5">{children}</div>;

export const Label = ({ className, ...rest }: Readonly<ComponentPropsWithRef<'label'>>) => (
  <label className={cx(labelClass, className)} {...rest} />
);

export const Select = ({ className, ...rest }: Readonly<ComponentPropsWithRef<'select'>>) => (
  <select className={cx(controlClass, 'pr-8', className)} {...rest} />
);

export const TextArea = ({ className, ...rest }: Readonly<ComponentPropsWithRef<'textarea'>>) => (
  <textarea className={cx(controlClass, 'min-h-32 resize-y', className)} {...rest} />
);

export const Hint = ({ className, ...rest }: Readonly<ComponentPropsWithRef<'p'>>) => (
  <p className={cx(hintClass, className)} {...rest} />
);

export const FieldError = ({ className, ...rest }: Readonly<ComponentPropsWithRef<'p'>>) => (
  <p className={cx(errorClass, className)} {...rest} />
);
