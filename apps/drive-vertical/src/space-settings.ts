import { z } from 'zod';
export const SPACE_ICONS = ['folder', 'home', 'calendar', 'users', 'cloud', 'star'] as const;
export const SPACE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'] as const;
export const spaceSettingsSchema = z.object({ name: z.string().trim().min(1).max(100).refine(name => !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) && /[^\s\p{Cf}]/u.test(name), 'Use a visible name without control or direction-override characters'), icon: z.enum(SPACE_ICONS), color: z.enum(SPACE_COLORS) });
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
