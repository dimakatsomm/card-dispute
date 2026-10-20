export const LoadError = ({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) => (
  <div role="alert">
    <p>{message}</p>
    <button type="button" onClick={onRetry}>
      Try again
    </button>
  </div>
);
