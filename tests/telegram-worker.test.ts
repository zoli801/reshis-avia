import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";

test("real Workers runtime accepts Telegram manual redirects and rejects redirect leakage without sockets or network",()=>{
  const project=fileURLToPath(new URL("../",import.meta.url));
  const directory=mkdtempSync(join(tmpdir(),"avia-telegram-worker-"));
  try{
    for(const name of ["telegram","security","auth","auth-rate-limit","telegram-login"]){
      const source=readFileSync(resolve(project,`lib/server/${name}.ts`),"utf8");
      writeFileSync(join(directory,`${name}.mjs`),stripTypeScriptTypes(source,{mode:"strip"}));
    }
    writeFileSync(join(directory,"main.mjs"),`
import { sendTelegram, telegramRuntimeDiagnostic, TelegramDeliveryError } from './telegram.ts';
export default {async test() {
  let unsupported=false;
  try {new Request('https://example.invalid/',{redirect:'error'});} catch(error) {unsupported=error instanceof TypeError;}
  if(!unsupported)throw new Error('Expected the Workers redirect:error runtime restriction');
  const env={BOT_TOKEN:'123456:'+'offline_synthetic_token_for_worker_test'};
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=async(input,init)=>{
      // Constructing a real Workers Request reproduces the production failure
      // even though no native fetch, listener or external network is used.
      const request=new Request(input,init);calls++;
      if(request.redirect!=='manual')throw new Error('Expected manual redirect mode');
      return Response.json({ok:true,result:request.url.endsWith('/getMe')?{is_bot:true,username:'CU_AviGo_app'}:{message_id:1}});
    };
    const healthy=await telegramRuntimeDiagnostic(env);
    if(healthy.classification!=='ok')throw new Error('Workers getMe request construction failed');
    await sendTelegram(env,'sendMessage',{chat_id:42,text:'Offline fixture'});
    globalThis.fetch=async(input,init)=>{
      const request=new Request(input,init);calls++;
      if(request.redirect!=='manual')throw new Error('Redirect following is forbidden');
      return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/never-follow'}});
    };
    const redirected=await telegramRuntimeDiagnostic(env);
    if(redirected.classification!=='redirect_rejected'||redirected.username!==null)throw new Error('Diagnostic redirect was not rejected');
    let rejected=false;
    try {await sendTelegram(env,'sendMessage',{chat_id:42,text:'Offline fixture'});}
    catch(error) {rejected=error instanceof TelegramDeliveryError&&error.classification==='redirect_rejected'&&!error.message.includes(env.BOT_TOKEN);}
    if(!rejected||calls!==4)throw new Error('Unsafe redirect behavior');
  } finally {globalThis.fetch=original;}
}};
`);
    writeFileSync(join(directory,"worker.capnp"),`
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "telegram-regression", worker = (
    compatibilityDate = "2026-05-15",
    modules = [
      (name = "main.mjs", esModule = embed "main.mjs"),
      (name = "telegram.ts", esModule = embed "telegram.mjs"),
      (name = "security.ts", esModule = embed "security.mjs"),
      (name = "auth.ts", esModule = embed "auth.mjs"),
      (name = "auth-rate-limit.ts", esModule = embed "auth-rate-limit.mjs"),
      (name = "telegram-login.ts", esModule = embed "telegram-login.mjs")
    ]
  ))]
);
`);
    const result=spawnSync(resolve(project,"node_modules/.bin/workerd"),["test","--no-verbose",`-I${resolve(project,"node_modules")}`,join(directory,"worker.capnp")],{encoding:"utf8",timeout:20000});
    assert.equal(result.error,undefined);
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
