/**
 * The apps the drive ships with, opened in the same place as a plugin's app.
 *
 * They take the plugin-app slot (`activePluginId`) on purpose: leaving one is leaving any app —
 * the rail, the palette and the drafts guard already know how — so a built-in view cannot grow
 * its own idea of navigation. The ids cannot collide with a plugin's, whose ids have no colon.
 */
export const TASKS_APP = 'canopy:tasks';
export const CALENDAR_APP = 'canopy:calendar';

export const BUILTIN_APPS = [
  { id: TASKS_APP, icon: 'check-square', label: 'Tasks' },
  { id: CALENDAR_APP, icon: 'calendar', label: 'Calendar' },
] as const;

export type BuiltinApp = (typeof BUILTIN_APPS)[number];
export const builtinApp = (id: string | null): BuiltinApp | undefined => BUILTIN_APPS.find(app => app.id === id);
