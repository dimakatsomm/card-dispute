import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Button, Hint, Label, cx, errorClass, focusRing, listClass } from '../ui';
import { ACCEPT_ATTRIBUTE, MAX_FILES, rejectedFileMessage, selectFiles, type SelectedFile } from './core';

export const useFileSelection = () => {
  const [files, setFiles] = useState<ReadonlyArray<SelectedFile>>([]);
  const [messages, setMessages] = useState<ReadonlyArray<string>>([]);
  const nextKey = useRef(0);

  const choose = (incoming: ReadonlyArray<File>) => {
    const selection = selectFiles(files, incoming, () => {
      nextKey.current += 1;
      return `file-${nextKey.current}`;
    });
    setFiles(selection.files);
    setMessages([
      ...(selection.overLimit ? [`You can attach up to ${MAX_FILES} files.`] : []),
      ...selection.rejected.map(rejectedFileMessage),
    ]);
  };

  const remove = (key: string) => setFiles(files.filter((f) => f.key !== key));

  return { files, messages, choose, remove };
};

export type FileSelectionState = ReturnType<typeof useFileSelection>;

const describedBy = (...ids: ReadonlyArray<string | null>): string => ids.filter((id) => id !== null).join(' ');

export type FilePickerProps = {
  readonly label: string;
  readonly selection: FileSelectionState;
  readonly disabled: boolean;
};

export const FilePicker = ({ label, selection, disabled }: FilePickerProps) => {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = { input: `${id}-files`, hint: `${id}-files-hint`, errors: `${id}-files-errors` };
  const { files, messages } = selection;

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    selection.choose(Array.from(event.currentTarget.files ?? []));
    // Clearing lets the same file be chosen again after it is removed.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={ids.input}>{label}</Label>
      <input
        id={ids.input}
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        onChange={onChange}
        disabled={disabled}
        aria-describedby={describedBy(ids.hint, messages.length > 0 ? ids.errors : null)}
        className={cx(
          'block w-full cursor-pointer rounded-lg border border-dashed border-zinc-300 bg-surface p-2 text-sm text-muted',
          'file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-strong',
          'hover:border-zinc-400 hover:file:bg-accent-line/50 disabled:cursor-not-allowed disabled:opacity-60',
          focusRing,
        )}
      />
      <Hint id={ids.hint}>Up to {MAX_FILES} files: PDF, JPEG or PNG, each up to 10 MB.</Hint>
      {messages.length > 0 ? (
        <ul id={ids.errors} role="alert" className={cx(errorClass, 'list-disc space-y-1 pl-5')}>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul aria-label="Selected files" className={listClass}>
          {files.map((selected) => (
            <li key={selected.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{selected.file.name}</span>{' '}
              <Button
                variant="ghost"
                size="sm"
                wrap
                disabled={disabled}
                onClick={() => selection.remove(selected.key)}
              >
                Remove {selected.file.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
