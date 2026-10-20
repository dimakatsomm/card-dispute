import { useId, useRef, useState, type ChangeEvent } from 'react';
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
    <div>
      <label htmlFor={ids.input}>{label}</label>
      <input
        id={ids.input}
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        onChange={onChange}
        disabled={disabled}
        aria-describedby={describedBy(ids.hint, messages.length > 0 ? ids.errors : null)}
      />
      <p id={ids.hint}>Up to {MAX_FILES} files: PDF, JPEG or PNG, each up to 10 MB.</p>
      {messages.length > 0 ? (
        <ul id={ids.errors} role="alert">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul aria-label="Selected files">
          {files.map((selected) => (
            <li key={selected.key}>
              {selected.file.name}{' '}
              <button type="button" disabled={disabled} onClick={() => selection.remove(selected.key)}>
                Remove {selected.file.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
