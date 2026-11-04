import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createLocalEnvironment} from "../scripts/setup-local.mjs";

test("local setup creates a private random pepper without printing it or configuring production credentials",()=>{
  const directory=mkdtempSync(join(tmpdir(),"avia-local-setup-"));
  try{
    const messages:string[]=[];
    assert.equal(createLocalEnvironment(directory,(message:string)=>messages.push(message)),true);
    const file=join(directory,".dev.vars"),content=readFileSync(file,"utf8"),match=content.match(/^PASSWORD_PEPPER=([a-f0-9]{64})$/m);
    assert.ok(match);assert.ok(!messages.join("\n").includes(match[1]));
    assert.ok(content.includes("SITE_OWNER_EMAIL=seedy@sites.test"));
    assert.ok(!content.includes("BOT_TOKEN"));assert.ok(!content.includes("TELEGRAM_WEBHOOK_SECRET"));
    if(process.platform!=="win32")assert.equal(statSync(file).mode&0o777,0o600);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("repeated local setup leaves an existing environment and its key unchanged",()=>{
  const directory=mkdtempSync(join(tmpdir(),"avia-local-preserve-"));
  try{
    const file=join(directory,".dev.vars"),existing="EXISTING_LOCAL_SETTING=preserve-this\n";
    writeFileSync(file,existing,{mode:0o600});
    assert.equal(createLocalEnvironment(directory,()=>{}),false);
    assert.equal(readFileSync(file,"utf8"),existing);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("local setup never follows an existing environment symlink",{skip:process.platform==="win32"},()=>{
  const directory=mkdtempSync(join(tmpdir(),"avia-local-symlink-"));
  try{
    const target=join(directory,"preserved.txt");writeFileSync(target,"unchanged\n");symlinkSync(target,join(directory,".dev.vars"));
    assert.equal(createLocalEnvironment(directory,()=>{}),false);
    assert.equal(readFileSync(target,"utf8"),"unchanged\n");
  }finally{rmSync(directory,{recursive:true,force:true});}
});
