/** The "Label with AI" menu items, and whether a space offers them. */
import { createContext } from 'react';

/** On a file: label it now. On a folder: label the files under it that have no labels yet. */
export const LABEL_WITH_AI = 'Label with AI';
/** On a folder: label every file under it again, labelled or not. */
export const RELABEL_WITH_AI = 'Re-label all with AI';

/** Whether this space runs Document AI — what decides if the menus offer the AI items. */
export const AiLabelContext = createContext(false);
