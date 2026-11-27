/**
 * Saved metadata views: the space's documents as a virtual tree, one level per key, built from
 * what each file already carries. Nothing here moves a file or changes who may read it; the
 * folders stay where documents really are, and a view is only a way of looking at them. A new
 * document appears in its place as soon as it has the metadata the view groups on.
 */
import { FOLDERS_VIEW, type SpaceView, type ViewKey } from '../../src/space-settings';
import { kindOf, type FileKind } from './items';

/** What a view needs of a file: the all-files listing's row. */
export interface ViewFile {
  id: string;
  name: string;
  folder_path: string;
  labels: string[];
  category: string | null;
  category_source: 'ai' | 'person' | null;
  mime: string | null;
  created_at: string;
}

/** The space's views as any member reads them. */
export interface SpaceViews {
  views: SpaceView[];
  /** The view an owner set for everyone, or null for the folders. */
  defaultView: string | null;
  categories: { id: string; name: string }[];
  canManage: boolean;
}

/** The value a file has no value for. No real value is empty: labels, ids and years never are. */
export const MISSING = '';

export const VIEW_KEY_LABEL: Record<ViewKey, string> = {
  category: 'Category', label: 'Label', year: 'Year added', month: 'Month added', type: 'Type', folder: 'Top folder',
};
const MISSING_LABEL: Record<ViewKey, string> = {
  category: 'No category', label: 'No labels', year: 'No date', month: 'No date', type: 'Other', folder: 'Top of the space',
};
const KIND_LABEL: Record<FileKind, string> = {
  folder: 'Folders', pdf: 'PDFs', image: 'Images', note: 'Notes and text', doc: 'Documents', audio: 'Audio', video: 'Video',
};

export interface GroupValue { value: string; label: string; /** Document AI put it here and no person has confirmed it. */ ai: boolean }

const monthLabel = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  // Local midnight on the first: a UTC date would read as the previous month west of Greenwich.
  return new Date(year!, number! - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
};

/** Where a file sits under one key: one value, several (labels), or none. */
export function valuesOf(file: ViewFile, key: ViewKey, categoryNames: ReadonlyMap<string, string>): GroupValue[] {
  switch (key) {
    case 'category':
      // An id no category has any more still groups, under its id, rather than vanishing.
      return file.category ? [{ value: file.category, label: categoryNames.get(file.category) ?? file.category, ai: file.category_source === 'ai' }] : [];
    case 'label':
      return [...new Set(file.labels)].map(label => ({ value: label, label, ai: false }));
    case 'year': {
      const year = file.created_at.slice(0, 4);
      return /^\d{4}$/.test(year) ? [{ value: year, label: year, ai: false }] : [];
    }
    case 'month': {
      const month = file.created_at.slice(0, 7);
      return /^\d{4}-\d{2}$/.test(month) ? [{ value: month, label: monthLabel(month), ai: false }] : [];
    }
    case 'type': {
      const kind = kindOf(file.mime, file.name);
      return [{ value: kind, label: KIND_LABEL[kind], ai: false }];
    }
    case 'folder': {
      const top = file.folder_path.split('/')[0] ?? '';
      return top ? [{ value: top, label: top, ai: false }] : [];
    }
  }
}

/** The values a file sits under at one key, with the missing bucket when it has none. */
const placesOf = (file: ViewFile, key: ViewKey, names: ReadonlyMap<string, string>): GroupValue[] => {
  const values = valuesOf(file, key, names);
  return values.length ? values : [{ value: MISSING, label: MISSING_LABEL[key], ai: false }];
};

export interface ViewGroup {
  value: string;
  label: string;
  count: number;
  /** How many of them are here only because Document AI chose their category. */
  suggested: number;
  missing: boolean;
}

export type ViewLevel =
  | { kind: 'groups'; key: ViewKey; groups: ViewGroup[] }
  | { kind: 'files'; files: ViewFile[] };

/** The files under a path of values, one value per key from the top. */
export function filesUnder<T extends ViewFile>(files: readonly T[], groupBy: readonly ViewKey[], path: readonly string[], names: ReadonlyMap<string, string>): T[] {
  return files.filter(file => path.every((value, depth) => placesOf(file, groupBy[depth]!, names).some(place => place.value === value)));
}

/** Whether a file sits where it does in this view because Document AI chose its category, unconfirmed. */
export function suggestedPlacement(file: ViewFile, groupBy: readonly ViewKey[]): boolean {
  return groupBy.includes('category') && file.category !== null && file.category_source === 'ai';
}

const byNewest = (key: ViewKey) => key === 'year' || key === 'month';

/** One level of a view: the groups below a path, or the files once every key is used. */
export function viewLevel(files: readonly ViewFile[], groupBy: readonly ViewKey[], path: readonly string[], names: ReadonlyMap<string, string>): ViewLevel {
  const here = filesUnder(files, groupBy, path, names);
  if (path.length >= groupBy.length) return { kind: 'files', files: here };
  const key = groupBy[path.length]!;
  const groups = new Map<string, ViewGroup>();
  for (const file of here) {
    for (const place of placesOf(file, key, names)) {
      const group = groups.get(place.value) ?? { value: place.value, label: place.label, count: 0, suggested: 0, missing: place.value === MISSING };
      group.count++;
      if (place.ai) group.suggested++;
      groups.set(place.value, group);
    }
  }
  const sorted = [...groups.values()].sort((a, b) =>
    Number(a.missing) - Number(b.missing)
    || (byNewest(key) ? b.value.localeCompare(a.value) : a.label.localeCompare(b.label)));
  return { kind: 'groups', key, groups: sorted };
}

/** A path's labels, for breadcrumbs: each value as its group calls it. */
export function pathLabels(files: readonly ViewFile[], groupBy: readonly ViewKey[], path: readonly string[], names: ReadonlyMap<string, string>): string[] {
  return path.map((value, depth) => {
    const key = groupBy[depth]!;
    if (value === MISSING) return MISSING_LABEL[key];
    for (const file of files) {
      const found = valuesOf(file, key, names).find(place => place.value === value);
      if (found) return found.label;
    }
    return value;
  });
}

/**
 * Which view a person has open in a space: their own pick when it still exists, else the
 * default an owner set, else the folders (null).
 */
export function activeView(choice: string | null, spaceViews: Pick<SpaceViews, 'views' | 'defaultView'> | null): SpaceView | null {
  if (!spaceViews) return null;
  const find = (id: string | null) => id ? spaceViews.views.find(view => view.id === id) ?? null : null;
  if (choice === FOLDERS_VIEW) return null;
  return find(choice) ?? find(spaceViews.defaultView);
}

/** A view id from its name: stable once saved, like a category's. */
export function viewIdFor(name: string, taken: readonly string[]): string {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'view';
  let id = base;
  for (let n = 2; taken.includes(id) || id === FOLDERS_VIEW; n++) id = `${base}-${n}`;
  return id;
}

export const VIEW_CHOICE_KEY = 'canopy.drive.space-view';

/**
 * A person's own pick per space, on this device: a view id, `folders`, or null for "the
 * space's default". Presentation only, like the list/grid choice.
 */
export function readViewChoice(space: string | null): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_CHOICE_KEY) ?? 'null');
    if (stored?.version !== 1 || typeof stored.bySpace !== 'object' || !stored.bySpace) return null;
    const value = stored.bySpace[space ?? ''];
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

export function saveViewChoice(space: string | null, choice: string | null): void {
  try {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(VIEW_CHOICE_KEY) ?? 'null'); } catch { /* Replaced below. */ }
    if (stored?.version !== undefined && stored.version !== 1) return;
    const bySpace: Record<string, string> = { ...(stored?.bySpace ?? {}) };
    if (choice === null) delete bySpace[space ?? ''];
    else bySpace[space ?? ''] = choice;
    localStorage.setItem(VIEW_CHOICE_KEY, JSON.stringify({ version: 1, bySpace }));
  } catch { /* Browsing still works with blocked or full storage. */ }
}
