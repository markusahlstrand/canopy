/// <reference types="node" />
import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {bindSpaceCreator,reserveSpaceCreation,type DirectorySql} from './space-creation';
function database(){const db=new DatabaseSync(':memory:');const sql:DirectorySql={exec:(query,...values)=>{const stmt=db.prepare(query);return stmt.columns().length ? stmt.all(...values) : (stmt.run(...values),[]);}};for(const statement of ['CREATE TABLE identity(scope_id TEXT,sub TEXT,principal TEXT,PRIMARY KEY(scope_id,sub))','CREATE TABLE owner_of_record(scope_id TEXT PRIMARY KEY,principal TEXT)','CREATE TABLE pending_owner(scope_id TEXT PRIMARY KEY,principal TEXT,claim_until INTEGER)','CREATE TABLE owner_claim(scope_id TEXT PRIMARY KEY,token_hash TEXT)','CREATE TABLE site(scope_id TEXT PRIMARY KEY,slug TEXT,name TEXT)'])sql.exec(statement);return {db,sql};}
it('binds only the verified creator without a sign-in window, consumes the seat and does not rebind on retry',()=>{
 const {sql,db}=database();sql.exec('INSERT INTO owner_of_record VALUES (?,?)','scope','owner');sql.exec('INSERT INTO pending_owner VALUES (?,?,?)','scope','owner',0);
 bindSpaceCreator(sql,'scope','owner','creator');expect([...sql.exec('SELECT * FROM identity')]).toEqual([{scope_id:'scope',sub:'creator',principal:'owner'}]);expect([...sql.exec('SELECT * FROM pending_owner')]).toEqual([]);
 sql.exec('DELETE FROM identity');bindSpaceCreator(sql,'scope','owner','creator');expect([...sql.exec('SELECT * FROM identity')]).toEqual([]);db.close();
});
it('bounds tenant creations and login rate across scopes while reusing the reserved owner on retry',()=>{
 const {sql,db}=database();expect(reserveSpaceCreation(sql,'first','login','owner',0)).toEqual({owner:'owner'});expect(reserveSpaceCreation(sql,'first','login','other',1)).toEqual({owner:'owner'});expect(reserveSpaceCreation(sql,'first','stranger','x',1).error).toBe('conflict');
 for(let i=1;i<10;i++)reserveSpaceCreation(sql,'space'+i,'login','owner'+i,1);expect(reserveSpaceCreation(sql,'rate','login','o',2).error).toBe('rate');
 for(let i=10;i<100;i++)sql.exec('INSERT INTO site VALUES (?,?,?)','s'+i,'space'+i,'Space');expect(reserveSpaceCreation(sql,'capped','someone','o',2).error).toBe('cap');db.close();
});
