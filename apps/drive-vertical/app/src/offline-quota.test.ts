import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { cacheOfflineVersion, clearOfflineContent, resumeOfflineContent, setOfflinePin } from './offline-content';

it('handles an asynchronous quota rejection without an unhandled transaction rejection', async () => {
  await clearOfflineContent(); await resumeOfflineContent();
  await setOfflinePin({ principal:'alice',space:'family',folderId:'root',name:'Root',status:'syncing',updatedAt:1 });
  const put=IDBObjectStore.prototype.put;
  const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args) {
    const request=put.apply(this,args);
    if(this.name==='versions') {
      const tx=this.transaction as unknown as { _requests: {operation:()=>unknown}[] };
      tx._requests.at(-1)!.operation=()=>{throw new DOMException('Quota exceeded','QuotaExceededError');};
    }
    return request;
  });
  try {
    await expect(cacheOfflineVersion({principal:'alice',space:'family',folderId:'root',fileId:'file',versionId:'v1',name:'a.txt',mime:'text/plain',url:'/content'},async()=>new Response('hello'))).rejects.toThrow('browser is out of storage space');
    await new Promise(resolve=>setTimeout(resolve,20));
  } finally { spy.mockRestore(); }
});
