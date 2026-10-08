import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { cacheOfflineVersion, clearOfflineContent, getOfflineVersion, resumeOfflineContent, retainOfflineVersion, setOfflinePin, updateOfflinePinStatus } from './offline-content';
afterEach(()=>vi.restoreAllMocks());
const pin={principal:'alice',space:'test',folderId:'root',name:'Root',status:'ready' as const,updatedAt:1};
const key={principal:'alice',space:'test',fileId:'file',versionId:'v1'};
it.each(['pin','status','rename'])('consumes the transaction rejection after a quota error during %s',async operation=>{
 await clearOfflineContent();await resumeOfflineContent('alice');await setOfflinePin(pin);
 await cacheOfflineVersion({...key,folderId:'root',name:'old.txt',mime:'text/plain',url:'/content'},async()=>new Response('hello'));
 const original=IDBObjectStore.prototype.put;
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args){
  const request=original.apply(this,args);
  if(this.name===(operation==='rename'?'versions':'pins')){
   const tx=this.transaction as unknown as {_requests:{operation:()=>unknown}[]};
   tx._requests.at(-1)!.operation=()=>{throw new DOMException('Quota exceeded','QuotaExceededError');};
  }
  return request;
 });
 const run=operation==='pin'?setOfflinePin({...pin,name:'New pin'}):operation==='status'?updateOfflinePinStatus(pin,'syncing'):retainOfflineVersion(key,'root',undefined,{name:'new.txt'});
 await expect(run).rejects.toThrow('Quota exceeded');
 await new Promise(resolve=>setTimeout(resolve,20));
 expect((await getOfflineVersion(key))?.name).toBe('old.txt');
});
