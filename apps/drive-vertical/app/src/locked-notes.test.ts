import {afterEach,beforeEach,expect,it,vi} from 'vitest';
// @ts-expect-error — the plugin is plain JS, loaded as source by the sandbox in production.
import render from '../../../../examples/plugins/locked-notes/index.js';

/** Runs the plugin as the sandbox would, answering each save the way the host does. */
function mount(text:string,writable=true){
 const container=document.createElement('div');document.body.append(container);
 const saves:string[]=[];
 render({container,file:{name:'diary.locked',mime:'application/octet-stream',bytes:new TextEncoder().encode(text).buffer,writable},emit:(action:string,data:{content:string})=>{
  if(action!=='save')return;saves.push(data.content);
  queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'canopy:save-result',ok:true}})));
 }});
 const inputs=()=>[...container.querySelectorAll('input')] as HTMLInputElement[];
 const button=(label:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===label) as HTMLButtonElement;
 return {container,saves,inputs,button};
}
const until=(check:()=>unknown)=>vi.waitFor(()=>{if(!check())throw Error('not yet');},{timeout:10000});

beforeEach(()=>{vi.stubGlobal('matchMedia',()=>({matches:false}));});
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals();});

it('encrypts plain text, stores only ciphertext, and unlocks it again with the password',async()=>{
 const first=mount('my secret plans');
 const [pw,again]=first.inputs();pw!.value='correct horse';again!.value='correct horse';first.button('Encrypt').click();
 await until(()=>first.saves.length);
 const envelope=first.saves[0]!;
 expect(envelope).not.toContain('my secret plans');
 expect(JSON.parse(envelope)).toMatchObject({format:'canopy-locked',v:1,kdf:{name:'PBKDF2',iterations:600000},cipher:{name:'AES-GCM'}});
 await until(()=>first.container.querySelector('textarea'));

 const second=mount(envelope);
 second.inputs()[0]!.value='wrong password';second.button('Unlock').click();
 await until(()=>second.container.textContent?.includes('Wrong password'));
 second.inputs()[0]!.value='correct horse';second.button('Unlock').click();
 await until(()=>second.container.querySelector('textarea'));
 expect(second.container.querySelector('textarea')!.value).toBe('my secret plans');
},30000);

it('re-encrypts edits with a fresh IV and refuses a tampered envelope',async()=>{
 const first=mount('');
 const [pw,again]=first.inputs();pw!.value='passphrase';again!.value='passphrase';first.button('Encrypt').click();
 await until(()=>first.container.querySelector('textarea'));
 const area=first.container.querySelector('textarea')!;area.value='v2';area.dispatchEvent(new Event('input'));
 first.button('Save').click();
 await until(()=>first.saves.length===2);
 const [a,b]=first.saves.map(s=>JSON.parse(s));
 expect(b.cipher.iv).not.toBe(a.cipher.iv);expect(b.kdf.salt).toBe(a.kdf.salt);

 const tampered=mount(JSON.stringify({...b,kdf:{...b.kdf,iterations:100001}}));
 tampered.inputs()[0]!.value='passphrase';tampered.button('Unlock').click();
 await until(()=>tampered.container.textContent?.includes('Wrong password'));
},30000);

it('asks for a password before encrypting and enforces a minimum length',async()=>{
 const view=mount('notes');
 const [pw,again]=view.inputs();pw!.value='short';again!.value='short';view.button('Encrypt').click();
 await until(()=>view.container.textContent?.includes('at least 8'));
 expect(view.saves).toEqual([]);
 expect(view.container.textContent).toContain('Earlier versions');
});
