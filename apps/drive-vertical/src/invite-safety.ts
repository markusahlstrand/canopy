import { isUnknownRoleError } from '@substrat-run/kernel';
import { HTTPException } from 'hono/http-exception';
import type { Context, Env, Hono } from 'hono';
import type { DirectorySql } from './space-creation.js';
export async function projectedInviteRoles(roles:string[],canAssign:(role:string)=>Promise<{covered:boolean}>):Promise<string[]> {
 const offered:string[]=[];
 for(const role of roles){try{if((await canAssign(role)).covered)offered.push(role);}catch(error){if(!isUnknownRoleError(error,role))throw error;}}
 return offered;
}
export function claimSafeInvite(sql:DirectorySql,scope:string,subject:string,hash:string):string|null {
 const invite=[...sql.exec('SELECT principal, role_key FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0',scope,hash)][0];
 if(!invite || invite.role_key==='owner')return null;
 const existing=[...sql.exec('SELECT principal FROM identity WHERE scope_id = ? AND sub = ?',scope,subject)][0];
 if(existing && existing.principal!==invite.principal)return null;
 sql.exec('INSERT OR IGNORE INTO identity(scope_id, sub, principal) VALUES (?, ?, ?)',scope,subject,String(invite.principal));
 sql.exec('UPDATE invite SET claimed = 1 WHERE scope_id = ? AND token_hash = ?',scope,hash);
 return String(invite.principal);
}
export function mountInviteGuards<E extends Env>(app:Hono<E>,roles:(c:Context<E>)=>Promise<string[]>,alreadyMember:(c:Context<E>)=>Promise<boolean>){
 app.use('/api/invites',async(c,next)=>{await next();if(c.req.method==='GET' && c.res.ok){const payload=await c.res.json() as Record<string,unknown>;c.res=c.json({...payload,roles:await roles(c)});}});
 app.use('/api/accept-invite',async(c,next)=>{if(c.req.method==='POST' && await alreadyMember(c))throw new HTTPException(409,{message:'You already belong to this space. An invite cannot replace your membership.'});await next();});
}

export function unbindProtectedPrincipal(sql:DirectorySql,scope:string,principal:string):string[] {
 const owner=[...sql.exec('SELECT principal FROM owner_of_record WHERE scope_id = ?',scope)][0];
 if(owner?.principal===principal)throw new Error('The owner of record cannot be unbound.');
 const subjects=[...sql.exec('SELECT sub FROM identity WHERE scope_id = ? AND principal = ?',scope,principal)].map(row=>String(row.sub));
 sql.exec('DELETE FROM identity WHERE scope_id = ? AND principal = ?',scope,principal);
 return subjects;
}
