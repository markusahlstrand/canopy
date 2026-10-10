import { unknownRoleError } from '@substrat-run/kernel';
import { errorCodeOf } from '@substrat-run/contracts';

/** The kernel's "role not defined" refusal. Its own predicate left the public index in 0.143. */
const isUnknownRoleError = (error: unknown, role: string) =>
  error instanceof Error && errorCodeOf(error) === 'not_found' && error.message === unknownRoleError(role).message;
import { HTTPException } from 'hono/http-exception';
import type { Context, Env, Hono } from 'hono';
import type { DirectorySql } from './space-creation.js';
export async function projectedInviteRoles(roles:string[],canAssign:(role:string)=>Promise<{covered:boolean}>):Promise<string[]> {
 const offered:string[]=[];
 for(const role of roles){try{if((await canAssign(role)).covered)offered.push(role);}catch(error){if(!isUnknownRoleError(error,role))throw error;}}
 return offered;
}
/**
 * Accept an invite without ever rebinding a login. The platform's own accept writes the binding
 * with `INSERT OR REPLACE`, so an owner opening an invite to their own space would lose the seat;
 * here a subject already bound to another principal is refused, as is an owner-role invite.
 */
function bindSafeInvite(sql:DirectorySql,scope:string,subject:string,invite:Record<string,unknown>):string|null {
 if(invite.role_key==='owner')return null;
 const existing=[...sql.exec('SELECT principal FROM identity WHERE scope_id = ? AND sub = ?',scope,subject)][0];
 if(existing && existing.principal!==invite.principal)return null;
 sql.exec('INSERT OR IGNORE INTO identity(scope_id, sub, principal) VALUES (?, ?, ?)',scope,subject,String(invite.principal));
 sql.exec('UPDATE invite SET claimed = 1 WHERE scope_id = ? AND token_hash = ?',scope,String(invite.token_hash));
 return String(invite.principal);
}
/** Legacy invites, minted before #1686, accept by token hash; capability-era rows never do. */
export function claimSafeInvite(sql:DirectorySql,scope:string,subject:string,hash:string):string|null {
 const invite=[...sql.exec('SELECT principal, role_key, token_hash FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0 AND capability_id IS NULL',scope,hash)][0];
 return invite ? bindSafeInvite(sql,scope,subject,invite) : null;
}
/** A capability-era invite, after the scope exchanged its secret for this capability and principal. */
export function claimSafeInviteByCapability(sql:DirectorySql,scope:string,subject:string,capabilityId:string,principal:string):string|null {
 const invite=[...sql.exec('SELECT principal, role_key, token_hash FROM invite WHERE scope_id = ? AND capability_id = ? AND principal = ? AND claimed = 0',scope,capabilityId,principal)][0];
 return invite ? bindSafeInvite(sql,scope,subject,invite) : null;
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
