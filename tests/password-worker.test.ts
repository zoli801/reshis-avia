import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";

test("password KDF and pepper verification run inside real Workers without Node crypto or network",()=>{
  const project=fileURLToPath(new URL("../",import.meta.url)),directory=mkdtempSync(join(tmpdir(),"avia-password-worker-"));
  try{
    for(const name of ["passwords","security"]){
      writeFileSync(join(directory,`${name}.mjs`),stripTypeScriptTypes(readFileSync(resolve(project,`lib/server/${name}.ts`),"utf8"),{mode:"strip"}));
    }
    writeFileSync(join(directory,"main.mjs"),`
import {hashPassword,verifyPassword} from './passwords.ts';
export default {async test(){
  const env={PASSWORD_PEPPER:'offline-worker-fixture-'+ 'x'.repeat(40)},password='Correct horse battery 2026';
  const hash=await hashPassword(password,env);
  if(!await verifyPassword(password,hash,env))throw new Error('Workers cannot verify its own KDF');
  if(await verifyPassword('incorrect password',hash,env))throw new Error('Wrong password accepted');
  if(await verifyPassword(password,hash,{PASSWORD_PEPPER:'different-offline-fixture-'+ 'x'.repeat(40)}))throw new Error('Pepper separation failed');
  if(hash.includes(password)||hash.includes(env.PASSWORD_PEPPER))throw new Error('Secret included in stored hash');
}};`);
    writeFileSync(join(directory,"worker.capnp"),`
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services=[(name="password-regression",worker=(compatibilityDate="2026-05-15",modules=[
   (name="main.mjs",esModule=embed "main.mjs"),
   (name="passwords.ts",esModule=embed "passwords.mjs"),
   (name="security.ts",esModule=embed "security.mjs")
 ]))]
);`);
    const result=spawnSync(resolve(project,"node_modules/.bin/workerd"),["test","--no-verbose",`-I${resolve(project,"node_modules")}`,join(directory,"worker.capnp")],{encoding:"utf8",timeout:20000});
    assert.equal(result.error,undefined);assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
