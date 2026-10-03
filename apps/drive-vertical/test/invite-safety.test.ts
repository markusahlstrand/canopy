/// <reference types="node" />
import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {unknownRoleError} from '@substrat-run/kernel';
import {claimSafeInvite,mountInviteGuards,projectedInviteRoles,unbindProtectedPrincipal} from '../src/invite-safety';
import type {DirectorySql} from '../src/space-creation';
it('offers only roles present in an older scope and never hides infrastructure failures',async()=>{
 expect(await projectedInviteRoles(['viewer','editor','member'],async role=>{if(role!=='member')throw unknownRoleError(role);return {covered:true};})).toEqual(['member']);
 await expect(projectedInviteRoles(['member'],async()=>{throw new Error('offline');})).rejects.toThrow('offline');
});
it('filters the actual invite response and blocks an existing members accept request before claim',async()=>{
 const app=new Hono();mountInviteGuards(app,async()=>['member'],async()=>true);app.get('/api/invites',c=>c.json({roles:['viewer','member'],invites:[]}));app.post('/api/accept-invite',c=>c.json({claimed:true}));
 expect(await(await app.request('/api/invites')).json()).toEqual({roles:['member'],invites:[]});expect((await app.request('/api/accept-invite',{method:'POST'})).status).toBe(409);
});
it('does not replace existing bindings, accept owner links or unbind the protected owner',()=>{
 const db=new DatabaseSync(':memory:');const sql:DirectorySql={exec:(query,...values)=>{const stmt=db.prepare(query);return stmt.columns().length?stmt.all(...values):(stmt.run(...values),[]);}};
 db.exec('CREATE TABLE identity(scope_id TEXT,sub TEXT,principal TEXT,PRIMARY KEY(scope_id,sub)); CREATE TABLE invite(scope_id TEXT,principal TEXT,role_key TEXT,token_hash TEXT,claimed INTEGER); CREATE TABLE owner_of_record(scope_id TEXT PRIMARY KEY,principal TEXT);');
 sql.exec('INSERT INTO identity VALUES (?,?,?)','scope','alice','owner');sql.exec('INSERT INTO owner_of_record VALUES (?,?)','scope','owner');
 sql.exec('INSERT INTO invite VALUES (?,?,?,?,0)','scope','viewer','viewer','viewer-token');sql.exec('INSERT INTO invite VALUES (?,?,?,?,0)','scope','coowner','owner','owner-token');
 expect(claimSafeInvite(sql,'scope','alice','viewer-token')).toBeNull();expect(claimSafeInvite(sql,'scope','bob','owner-token')).toBeNull();expect(claimSafeInvite(sql,'scope','bob','viewer-token')).toBe('viewer');
 expect(()=>unbindProtectedPrincipal(sql,'scope','owner')).toThrow('owner of record');expect([...sql.exec('SELECT principal FROM identity WHERE sub = ?','alice')][0]?.principal).toBe('owner');expect(unbindProtectedPrincipal(sql,'scope','viewer')).toEqual(['bob']);db.close();
});
