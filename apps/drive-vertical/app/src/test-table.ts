/**
 * Reaching into `<sub-entity-table>` from a test. Its rows live in its shadow root, and the
 * cells we draw are light-DOM elements slotted into them, so `closest('tr')` from a name
 * finds nothing and `getByRole('row')` sees no rows.
 */
import { act, waitFor } from '@testing-library/react';

/** Every row element of the file list, in order. */
export function fileRows(): HTMLTableRowElement[] {
  const table = document.querySelector('sub-entity-table');
  return [...(table?.shadowRoot?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])];
}

/** The row a light-DOM node is drawn in. */
export function rowOf(node: Element): HTMLTableRowElement {
  let cell: Element | null = node;
  while (cell && !cell.hasAttribute('data-sub-cell')) cell = cell.parentElement;
  const row = cell?.assignedSlot?.closest('tr');
  if (!row) throw new Error('Not inside a file list row');
  return row;
}

/** The first row whose text contains `name` (or matches it). Search highlights split a
 *  name across `<mark>`s, which `getByText` cannot match, so this reads the row's text. */
export function fileRow(name: string | RegExp): HTMLTableRowElement {
  const row = fileRows().find((r) => (typeof name === 'string' ? rowText(r).includes(name) : name.test(rowText(r))));
  if (!row) throw new Error(`No file list row for ${String(name)}; rows: ${fileRows().map(rowText).join(' | ')}`);
  return row;
}

/** A sortable column's header button. */
export function columnHeader(label: string): HTMLButtonElement {
  const table = document.querySelector('sub-entity-table');
  const button = [...(table?.shadowRoot?.querySelectorAll<HTMLButtonElement>('th button') ?? [])].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`No column header ${label}`);
  return button;
}

/** The "select all shown" checkbox in the header. */
export function toggleAll(): void {
  const box = document.querySelector('sub-entity-table')?.shadowRoot?.querySelector<HTMLElement & { checked: boolean }>('thead wa-checkbox');
  if (!box) throw new Error('No select-all checkbox');
  act(() => {
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  });
}

/** What a row says: the text of the cells slotted into it. */
export function rowText(row: HTMLTableRowElement): string {
  return [...row.querySelectorAll('slot')].flatMap((slot) => slot.assignedElements()).map((el) => el.textContent ?? '').join(' ');
}

/** A row's own selection checkbox. */
export function rowCheckbox(row: HTMLTableRowElement): HTMLElement & { checked: boolean } {
  const box = row.querySelector<HTMLElement & { checked: boolean }>('wa-checkbox');
  if (!box) throw new Error('Row has no checkbox');
  return box;
}

/** Tick or untick a row's checkbox as a person would: the element listens for `change`. */
export function toggleRow(row: HTMLTableRowElement): void {
  const box = rowCheckbox(row);
  act(() => {
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  });
}

/** The rows' names, in order, once the table has drawn `count` of them. */
export async function rowNames(): Promise<string[]> {
  await waitFor(() => { if (!fileRows().length) throw new Error('no rows yet'); });
  return fileRows().map(rowText);
}
