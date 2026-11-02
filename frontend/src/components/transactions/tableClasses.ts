import { cx } from '../ui';

export type Column = 'date' | 'merchant' | 'type' | 'amount' | 'status' | 'dispute';

const wideOnly = 'hidden sm:table-cell';

const columnClass: Readonly<Record<Column, string>> = {
  date: cx(wideOnly, 'text-left whitespace-nowrap'),
  merchant: 'text-left max-sm:pl-4',
  type: cx(wideOnly, 'text-left whitespace-nowrap'),
  amount: 'text-right whitespace-nowrap',
  status: cx(wideOnly, 'text-left'),
  dispute: 'text-right',
};

const cellBase = 'px-2.5 align-middle last:pr-4 sm:px-4';

export const headCellClass = (column: Column): string =>
  cx(cellBase, 'py-2.5 text-xs font-medium text-muted', columnClass[column]);

export const bodyCellClass = (column: Column): string => cx(cellBase, 'py-3', columnClass[column]);
