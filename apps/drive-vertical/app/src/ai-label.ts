/** The "Label with AI" menu items, and whether a space offers them. */
import { createContext } from 'react';

/** On a file: label it now. On a folder: label the files under it that have no labels yet. */
export const LABEL_WITH_AI = 'Label with AI';
/** On a folder: label every file under it again, labelled or not. */
export const RELABEL_WITH_AI = 'Re-label all with AI';

/** Whether this space runs Document AI — what decides if the menus offer the AI items. */
export const AiLabelContext = createContext(false);

/** On a folder: read the files under it that have not been read yet for people and companies. */
export const FIND_ENTITIES = 'Find people and companies';
/** Whether this space reads people and companies from documents — what offers the items for it. */
export const EntityExtractionContext = createContext(false);

/**
 * The submenu the AI items sit under in a row's menus: running Document AI or entity reading
 * again on a file, or on the files under a folder, is one kind of thing and reads as one.
 */
export const REPROCESS = 'Reprocess';
const REPROCESS_ITEMS: ReadonlySet<string> = new Set([LABEL_WITH_AI, RELABEL_WITH_AI, FIND_ENTITIES]);
/** Whether a menu action goes under `REPROCESS` rather than beside Open and Rename. */
export const isReprocess = (action: string) => REPROCESS_ITEMS.has(action);
