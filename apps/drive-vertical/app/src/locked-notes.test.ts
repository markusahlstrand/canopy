import {afterEach,beforeEach,expect,it,vi} from 'vitest';
// @ts-expect-error — the plugin is plain JS, loaded as source by the sandbox in production.
import render from '../../../../examples/plugins/locked-notes/index.js';

/** Runs the plugin as the sandbox would, answering each save the way the host does. */
type Reply={ok:boolean;error?:string};
/** `reply` answers every save automatically; `'manual'` leaves answering to the test via `respond`. */
function mount(text:string|Uint8Array,writable=true,reply:Reply|'manual'={ok:true}){
 const container=document.createElement('div');document.body.append(container);
 const saves:string[]=[],emitted:string[]=[];
 const bytes=typeof text==='string'?new TextEncoder().encode(text):text;
 render({container,file:{name:'diary.locked',mime:'application/octet-stream',bytes:bytes.buffer,writable},emit:(action:string,data:{content:string})=>{
  emitted.push(action);
  if(action!=='save')return;saves.push(data.content);
  // In jsdom the frame is its own parent, which is where the host's reply comes from.
  if(reply!=='manual')queueMicrotask(()=>respond(reply));
 }});
 const respond=(result:Reply,source:Window|null=window)=>window.dispatchEvent(new MessageEvent('message',{source,data:{type:'canopy:save-result',...result}}));
 const inputs=()=>[...container.querySelectorAll('input')] as HTMLInputElement[];
 const button=(label:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===label) as HTMLButtonElement;
 return {container,saves,emitted,inputs,button,respond};
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

/** Encrypts `text` under `password` and returns the unlocked view. */
async function unlocked(text:string,password='passphrase',reply?:Reply|'manual'){
 const view=mount(text,true,reply);
 const [pw,again]=view.inputs();pw!.value=password;again!.value=password;view.button('Encrypt').click();
 if(reply==='manual'){await until(()=>view.saves.length);view.respond({ok:true});}
 await until(()=>view.container.querySelector('textarea'));
 return view;
}

it('marks its password forms as transient so typing a password is not an unsaved edit',()=>{
 const view=mount('notes');
 expect(view.inputs()[0]!.closest('[data-canopy-transient]')).not.toBeNull();
});

it('ignores save results that do not come from the host',async()=>{
 const view=mount('notes',true,'manual');
 const [pw,again]=view.inputs();pw!.value='passphrase';again!.value='passphrase';view.button('Encrypt').click();
 await until(()=>view.saves.length);
 view.respond({ok:true},null);
 await new Promise(resolve=>setTimeout(resolve,20));
 expect(view.container.querySelector('textarea')).toBeNull();
 view.respond({ok:true});
 await until(()=>view.container.querySelector('textarea'));
},30000);

it('tells the host the edits are gone when Lock discards them',async()=>{
 const view=await unlocked('notes');
 const area=view.container.querySelector('textarea')!;area.value='changed';area.dispatchEvent(new Event('input'));
 view.button('Lock').click();
 expect(view.container.querySelector('textarea')).not.toBeNull();
 expect(view.container.textContent).toContain('click Lock again');
 view.button('Lock').click();
 expect(view.emitted).toContain('clean');
 expect(view.button('Unlock')).toBeDefined();
},30000);

it('shows why a save failed, and refuses a note too large for the save limit before sending it',async()=>{
 const view=await unlocked('notes');
 const area=view.container.querySelector('textarea')!;area.value='x'.repeat(160000);area.dispatchEvent(new Event('input'));
 view.button('Save').click();
 await until(()=>view.container.textContent?.includes('limit is 200 KB'));
 expect(view.saves).toHaveLength(1);

 const refused=mount('notes',true,{ok:false,error:'file changed — reload before saving'});
 const [pw,again]=refused.inputs();pw!.value='passphrase';again!.value='passphrase';refused.button('Encrypt').click();
 await until(()=>refused.container.textContent?.includes('file changed — reload before saving'));
 expect(refused.container.querySelector('textarea')).toBeNull();
},30000);

it('keeps the old password when re-encrypting fails, and blocks Cancel while it runs',async()=>{
 const view=await unlocked('notes','old password','manual');
 view.button('Change password').click();
 const [pw,again]=view.inputs();pw!.value='new password';again!.value='new password';
 view.button('Change password').click();
 expect(view.button('Cancel').disabled).toBe(true);
 await until(()=>view.saves.length===2);
 view.respond({ok:false,error:'file changed — reload before saving'});
 await until(()=>view.container.textContent?.includes('the old password still applies'));
 // Back in the editor, a save still uses the old password.
 view.button('Cancel').click();
 const area=view.container.querySelector('textarea')!;area.value='edited';area.dispatchEvent(new Event('input'));
 view.button('Save').click();
 await until(()=>view.saves.length===3);
 view.respond({ok:true});
 const reopened=mount(view.saves[2]!);
 reopened.inputs()[0]!.value='old password';reopened.button('Unlock').click();
 await until(()=>reopened.container.querySelector('textarea'));
 expect(reopened.container.querySelector('textarea')!.value).toBe('edited');
},30000);

it('refuses to encrypt bytes that are not UTF-8 instead of corrupting them',()=>{
 const view=mount(new Uint8Array([0x66,0xff,0xfe,0x00]));
 expect(view.container.textContent).toContain("isn't UTF-8 text");
 expect(view.inputs()).toHaveLength(0);
});
