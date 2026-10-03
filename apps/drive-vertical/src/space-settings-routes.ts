import type { Hono, Context, Env } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { spaceSettingsSchema, defaultSpaceSettings, type SettingsDirectory } from './space-settings.js';
export function mountSpaceSettings<E extends Env>(app:Hono<E>, resolve:(c:Context<E>)=>Promise<{scope:string;directory:SettingsDirectory}>) {
 app.get('/api/space-settings', async c => {
  const {scope,directory}=await resolve(c);
  const site=(await directory.listSites()).find(site=>site.scopeId===scope);
  return c.json(await directory.readSpaceSettings(scope) ?? defaultSpaceSettings(site?.name ?? 'Space'));
 });
 app.patch('/api/space-settings',async c=>{
  const {scope,directory}=await resolve(c);
  const settings=spaceSettingsSchema.safeParse(await c.req.json());
  if(!settings.success)throw new HTTPException(400,{message:'Enter a space name and choose a supported icon and color.'});
  const site=(await directory.listSites()).find(site=>site.scopeId===scope);
  if(!site)throw new HTTPException(404,{message:'Space not found.'});
  await directory.writeSpaceSettings(scope,settings.data);
  await directory.recordSite(scope,site.slug,settings.data.name);
  return c.json(settings.data);
 });
}
