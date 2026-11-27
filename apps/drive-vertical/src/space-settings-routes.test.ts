import {expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {mountSpaceSettings} from './space-settings-routes';
import {defaultSpaceSettings} from './space-settings';
it('requires the management gate before mutating and records the validated renamed site',async()=>{
 const write=vi.fn(async()=>{}),record=vi.fn(async()=>{});let allowed=false;
 const app=new Hono();mountSpaceSettings(app,async()=>{if(!allowed)throw new HTTPException(403);return {scope:'scope',directory:{readSpaceSettings:async()=>null,writeSpaceSettings:write,recordSite:record,deleteSpaceSettings:async()=>{},listSites:async()=>[{scopeId:'scope',slug:'family',name:'Family'}]}};});
 const request=()=>app.request('/api/space-settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(defaultSpaceSettings('Renamed'))});
 expect((await request()).status).toBe(403);expect(write).not.toHaveBeenCalled();allowed=true;expect((await request()).status).toBe(200);expect(record).toHaveBeenCalledWith('scope','family','Renamed');
});

it('shows any member the views, a default that still exists and category names, but no other settings', async () => {
 const {mountSpaceViews} = await import('./space-settings-routes');
 let member = true;
 const settings = {...defaultSpaceSettings('Family'), autoLabel: true,
  categories: [{id: 'invoice', name: 'Invoices', hint: 'bills to pay'}],
  views: [{id: 'by-category', name: 'By category', groupBy: ['category', 'year'] as ('category' | 'year')[]}],
  defaultView: 'by-category'};
 const app = new Hono();
 mountSpaceViews(app, async () => {
  if (!member) throw new HTTPException(403);
  return {scope: 'scope', canManage: false, directory: {readSpaceSettings: async () => settings, writeSpaceSettings: async () => {}, recordSite: async () => {}, deleteSpaceSettings: async () => {}, listSites: async () => []}};
 });
 const read = async () => app.request('/api/space-views');
 expect(await (await read()).json()).toEqual({views: settings.views, defaultView: 'by-category', canManage: false, categories: [{id: 'invoice', name: 'Invoices'}]});
 settings.defaultView = 'gone';
 expect(((await (await read()).json()) as {defaultView: string | null}).defaultView).toBeNull();
 member = false;
 expect((await read()).status).toBe(403);
});
