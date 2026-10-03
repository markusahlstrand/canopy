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
