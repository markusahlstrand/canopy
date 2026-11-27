import { z } from 'zod';

/**
 * The space's categories: what Document AI sorts documents into and flows match on. The same
 * rules as the drive's `spaceCategory` (`@canopy/scope-drive/spec/flows`), in plain zod so the
 * app can share this file without bundling the drive's contracts.
 */
export const spaceCategorySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(60),
  hint: z.string().trim().max(200).optional(),
});
export type SpaceCategory = z.infer<typeof spaceCategorySchema>;
const spaceCategories = z.array(spaceCategorySchema).max(30)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'Each category needs its own id');
/**
 * What a metadata view groups documents by, one key per level. Each is read from what the file
 * already carries, so a document lands in its place the moment it has the metadata:
 * - `category`: the space category (a person's or Document AI's choice; the AI's is marked).
 * - `label`: each label (a file with two labels sits under both).
 * - `year` / `month`: when the file was added.
 * - `type`: the kind of file (PDF, image, spreadsheet…), from its current version.
 * - `folder`: the top folder it really sits in.
 */
export const VIEW_KEYS = ['category', 'label', 'year', 'month', 'type', 'folder'] as const;
export type ViewKey = typeof VIEW_KEYS[number];
/**
 * A saved view: the same documents as a virtual tree, one level per key. Nothing is moved or
 * copied, and nothing about who may read what changes: it is a way of looking, not a place.
 */
export const spaceViewSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(60),
  groupBy: z.array(z.enum(VIEW_KEYS)).min(1).max(4)
    .refine((keys) => new Set(keys).size === keys.length, 'Group by each thing once'),
});
export type SpaceView = z.infer<typeof spaceViewSchema>;
const spaceViews = z.array(spaceViewSchema).max(12)
  .refine((list) => new Set(list.map((v) => v.id)).size === list.length, 'Each view needs its own id');
/** The folder tree, which every space has and no view can replace. */
export const FOLDERS_VIEW = 'folders';
export const SPACE_ICONS =['folder', 'home', 'calendar', 'users', 'cloud', 'star'] as const;
export const SPACE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'] as const;
export const spaceSettingsSchema = z.object({ name: z.string().trim().min(1).max(100).refine(name => !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) && /[^\s\p{Cf}]/u.test(name), 'Use a visible name without control or direction-override characters'), icon: z.enum(SPACE_ICONS), color: z.enum(SPACE_COLORS),
 /** Document AI: label and describe uploads with a model. Off unless an administrator turns it on. */
 autoLabel: z.boolean().optional(),
 /**
  * Entity extraction: read who and what documents are about into suggestions for the space's
  * knowledge graph. Separate from `autoLabel` because it sends more text and costs more. Off
  * unless an administrator turns it on.
  */
 extractEntities: z.boolean().optional(),
 /** What Document AI sorts documents into, and flows match on. Empty: it only labels and describes. */
 categories: spaceCategories.optional(),
 /** Saved metadata views of the space's documents, beside its folders. */
 views: spaceViews.optional(),
 /**
  * The view members land on: a view's id, or absent for the folders. An owner sets it; each
  * member may pick another for themselves. An id no view has any more reads as the folders.
  */
 defaultView: z.string().max(40).optional() });
export type SpaceSettings = z.infer<typeof spaceSettingsSchema>;
export const defaultSpaceSettings = (name: string): SpaceSettings => ({name, icon:'folder', color:'#3b82f6'});

export function parseSpaceSettings(value?: string): SpaceSettings | null {
  if (!value) return null;
  try { const result = spaceSettingsSchema.safeParse(JSON.parse(value)); return result.success ? result.data : null; } catch { return null; }
}

export interface SettingsDirectory {
 readSpaceSettings(scope: string): Promise<SpaceSettings | null>;
 writeSpaceSettings(scope: string, settings: SpaceSettings): Promise<void>;
 deleteSpaceSettings(scope: string): Promise<void>;
 recordSite(scope:string,slug:string,name:string):Promise<void>;
 listSites():Promise<{scopeId:string;slug:string;name:string}[]>;
}
export async function provisionSpaceSettings(directory: SettingsDirectory, scope: string, owner: string): Promise<SpaceSettings | null> {
 let settings = await directory.readSpaceSettings(scope);
 if (!settings) { settings = await directory.readSpaceSettings(`creator:${owner}`); if (settings) await directory.writeSpaceSettings(scope, settings); }
 await directory.deleteSpaceSettings(`creator:${owner}`);
 return settings;
}
