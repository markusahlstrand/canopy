import type {Context,Env,Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {principalId} from '@substrat-run/contracts';
import {removeMember,type RemovalSteps} from './remove-member.js';
export function mountMemberRemoval<E extends Env>(app:Hono<E>,resolve:(c:Context<E>,target:string)=>Promise<{asking:string;owner:string|null;targetManages:boolean;steps:RemovalSteps}>){
 app.delete('/api/people/:principal',async c=>{
  const target=c.req.param('principal');if(!principalId.safeParse(target).success)throw new HTTPException(400,{message:'Invalid principal.'});
  const {asking,owner,targetManages,steps}=await resolve(c,target);
  if(target===asking)throw new HTTPException(400,{message:'You cannot remove yourself.'});
  if(target===owner)throw new HTTPException(403,{message:'The owner of record cannot be removed. Use the platform ownership transfer flow.'});
  if(targetManages && asking!==owner)throw new HTTPException(403,{message:'Only the owner of record can remove another space administrator.'});
  return c.json({principal:target,...await removeMember(steps)});
 });
}
