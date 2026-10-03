import {expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {mountMemberRemoval} from './member-removal-route';
const alice='01J00000000000000000000001',bob='01J00000000000000000000002',carol='01J00000000000000000000003';
it('protects the original owner and blocks co-owner eviction before all removal side effects',async()=>{
 const unbind=vi.fn(async()=>1),forgetGrants=vi.fn(async()=>({revoked:0,forgotten:false})),revokeRoles=vi.fn(async()=>1);let asking=bob;const app=new Hono();mountMemberRemoval(app,async()=>({asking,owner:alice,targetManages:true,steps:{unbind,forgetGrants,revokeRoles}}));
 expect((await app.request('/api/people/'+alice,{method:'DELETE'})).status).toBe(403);expect((await app.request('/api/people/'+carol,{method:'DELETE'})).status).toBe(403);expect(unbind).not.toHaveBeenCalled();expect(revokeRoles).not.toHaveBeenCalled();asking=alice;expect((await app.request('/api/people/'+bob,{method:'DELETE'})).status).toBe(200);expect(unbind).toHaveBeenCalledOnce();
});
