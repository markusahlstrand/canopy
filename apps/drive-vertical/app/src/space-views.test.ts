import { afterEach, expect, it } from 'vitest';
import { activeView, filesUnder, MISSING, pathLabels, readViewChoice, saveViewChoice, suggestedPlacement, viewIdFor, viewLevel, VIEW_CHOICE_KEY, type ViewFile } from './space-views';

afterEach(() => localStorage.clear());

const file = (id: string, patch: Partial<ViewFile> = {}): ViewFile => ({
  id, name: `${id}.pdf`, folder_path: 'Inbox', labels: [], category: null, category_source: null,
  mime: 'application/pdf', created_at: '2026-03-04T10:00:00.000Z', ...patch,
});
const names = new Map([['invoice', 'Invoices'], ['receipt', 'Receipts']]);
const files = [
  file('a', { category: 'invoice', category_source: 'person', created_at: '2025-01-02T00:00:00.000Z' }),
  file('b', { category: 'invoice', category_source: 'ai', labels: ['tax', 'q1'] }),
  file('c', { category: 'receipt', category_source: 'ai', mime: 'image/jpeg', folder_path: '' }),
  file('d', { labels: ['tax'] }),
];

it('groups the top level by category, AI choices counted apart, the missing bucket last', () => {
  expect(viewLevel(files, ['category', 'year'], [], names)).toEqual({ kind: 'groups', key: 'category', groups: [
    { value: 'invoice', label: 'Invoices', count: 2, suggested: 1, missing: false },
    { value: 'receipt', label: 'Receipts', count: 1, suggested: 1, missing: false },
    { value: MISSING, label: 'No category', count: 1, suggested: 0, missing: true },
  ] });
});

it('walks down a path, newest year first, and lists files once every key is used', () => {
  const years = viewLevel(files, ['category', 'year'], ['invoice'], names);
  expect(years.kind === 'groups' && years.groups.map(g => [g.label, g.count])).toEqual([['2026', 1], ['2025', 1]]);
  const leaf = viewLevel(files, ['category', 'year'], ['invoice', '2026'], names);
  expect(leaf.kind === 'files' && leaf.files.map(f => f.id)).toEqual(['b']);
  expect(filesUnder(files, ['category'], [MISSING], names).map(f => f.id)).toEqual(['d']);
});

it('puts a file with two labels under both, and one with none under "No labels"', () => {
  const level = viewLevel(files, ['label'], [], names);
  expect(level.kind === 'groups' && level.groups.map(g => [g.label, g.count])).toEqual([['q1', 1], ['tax', 2], ['No labels', 2]]);
});

it('groups by type and top folder, and names each step of a path', () => {
  const types = viewLevel(files, ['type'], [], names);
  expect(types.kind === 'groups' && types.groups.map(g => g.label)).toEqual(['Images', 'PDFs']);
  const folders = viewLevel(files, ['folder'], [], names);
  expect(folders.kind === 'groups' && folders.groups.map(g => [g.label, g.count])).toEqual([['Inbox', 3], ['Top of the space', 1]]);
  expect(pathLabels(files, ['category', 'month'], ['invoice', '2026-03'], names)).toEqual(['Invoices', new Date(2026, 2, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })]);
  expect(pathLabels(files, ['category'], [MISSING], names)).toEqual(['No category']);
});

it('marks a file placed by an unconfirmed AI category only in views that group on category', () => {
  expect(suggestedPlacement(files[1]!, ['category', 'year'])).toBe(true);
  expect(suggestedPlacement(files[0]!, ['category'])).toBe(false);
  expect(suggestedPlacement(files[1]!, ['year'])).toBe(false);
});

it('opens a person\'s own pick, else the space default, else the folders', () => {
  const views = [{ id: 'by-category', name: 'By category', groupBy: ['category' as const] }, { id: 'by-year', name: 'By year', groupBy: ['year' as const] }];
  expect(activeView(null, { views, defaultView: 'by-year' })?.id).toBe('by-year');
  expect(activeView('by-category', { views, defaultView: 'by-year' })?.id).toBe('by-category');
  expect(activeView('folders', { views, defaultView: 'by-year' })).toBeNull();
  expect(activeView('removed', { views, defaultView: null })).toBeNull();
  expect(activeView(null, null)).toBeNull();
});

it('keeps each space\'s pick apart, and clears one back to the default', () => {
  saveViewChoice('family', 'by-year');
  saveViewChoice(null, 'folders');
  expect([readViewChoice('family'), readViewChoice(null), readViewChoice('work')]).toEqual(['by-year', 'folders', null]);
  saveViewChoice('family', null);
  expect(readViewChoice('family')).toBeNull();
  localStorage.setItem(VIEW_CHOICE_KEY, '{broken');
  expect(readViewChoice(null)).toBeNull();
});

it('makes a view id from its name that is never "folders" or taken', () => {
  expect(viewIdFor('Per år', [])).toBe('per-ar');
  expect(viewIdFor('Folders', [])).toBe('folders-2');
  expect(viewIdFor('By year', ['by-year'])).toBe('by-year-2');
});
