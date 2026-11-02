import { Button, errorCardClass } from '../ui';

export const LoadError = ({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) => (
  <div role="alert" className={errorCardClass}>
    <p>{message}</p>
    <Button variant="secondary" size="sm" onClick={onRetry}>
      Try again
    </Button>
  </div>
);
