import { z } from 'zod';
export const SPACE_ICONS = ['folder', 'home', 'calendar', 'users', 'cloud', 'star'] as const;
export const SPACE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'] as const;
export const spaceSettingsSchema = z.object({ name: z.string().trim().min(1).max(100), icon: z.enum(SPACE_ICONS), color: z.enum(SPACE_COLORS) });
export type SpaceSettings = z.infer<typeof spaceSettingsSchema>;
export const defaultSpaceSettings = (name: string): SpaceSettings => ({name, icon:'folder', color:'#3b82f6'});
