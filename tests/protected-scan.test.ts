import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scanner=path.join(project,'scripts/check-secrets.mjs');
const providerFixture=()=>['gh','p_'].join('')+'A'.repeat(36);
function fixture(){
 const base=mkdtempSync(path.join(tmpdir(),'avia-public-scan-')),root=path.join(base,'repo');mkdirSync(root);
 const git=(...args:string[])=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','--initial-branch=main');git('config','user.name','Security fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
 const scan=(...args:string[])=>spawnSync(process.execPath,[scanner,'--root',root,...args],{encoding:'utf8'});
 return {base,root,git,scan,write:(name:string,value:string|Buffer)=>writeFileSync(path.join(root,name),value),close:()=>rmSync(base,{recursive:true,force:true})};
}

test('provider matches block publication while reporting no credential value',()=>{
 const f=fixture();try{const value=providerFixture();f.write('client.txt',value);const r=f.scan('--mode','working');assert.equal(r.status,1);const output=r.stdout+r.stderr;assert.ok(output.includes('github-token'));assert.ok(output.includes('client.txt'));assert.ok(!output.includes(value));}finally{f.close();}
});

test('staged scan inspects the index even when the working copy has already been sanitized',()=>{
 const f=fixture();try{f.write('config.txt',providerFixture());f.git('add','config.txt');f.write('config.txt','Safe working copy\n');assert.equal(f.scan('--mode','working').status,0);const staged=f.scan('--mode','staged');assert.equal(staged.status,1);assert.ok(staged.stderr.includes('github-token'));}finally{f.close();}
});

test('history scan rejects a deleted credential that the current tree no longer contains',()=>{
 const f=fixture();try{f.write('config.txt',providerFixture());f.git('add','.');f.git('commit','-m','Synthetic historical fixture');f.write('config.txt','Safe latest content\n');f.git('add','.');f.git('commit','-m','Sanitize fixture');assert.equal(f.scan('--mode','tree').status,0);const r=f.scan('--mode','history');assert.equal(r.status,1);assert.ok(r.stderr.includes('config.txt'));}finally{f.close();}
});

test('reviewed manifests bind the staged content and detect changes after review',()=>{
 const f=fixture();try{const manifest=path.join(f.base,'review.json');f.write('README.md','Reviewed content\n');assert.equal(f.scan('--mode','working','--manifest',manifest).status,0);f.git('add','.');assert.equal(f.scan('--mode','staged','--verify-manifest',manifest).status,0);f.write('README.md','Changed after review\n');f.git('add','.');const r=f.scan('--mode','staged','--verify-manifest',manifest);assert.equal(r.status,1);assert.ok(r.stderr.includes('reviewed-manifest-mismatch'));assert.ok(readFileSync(manifest,'utf8').includes('sha256'));}finally{f.close();}
});

test('private runtime files and nonempty secret examples are rejected without revealing their contents',()=>{
 const f=fixture();try{f.write('.dev.vars.example','BOT_TOKEN=\nPASSWORD_PEPPER=\n');assert.equal(f.scan('--mode','working').status,0);f.write('.dev.vars.example','BOT_TOKEN=nonempty-placeholder\n');assert.equal(f.scan('--mode','working').status,1);f.write('.dev.vars.example','BOT_TOKEN=\n');f.write('.env','BOT_TOKEN=\n');const r=f.scan('--mode','working');assert.equal(r.status,1);assert.ok(r.stderr.includes('forbidden-publication-path'));assert.ok(!r.stderr.includes('nonempty-placeholder'));}finally{f.close();}
});

test('known-secret comparison covers URL and Base64 encodings and binary assets',()=>{
 const f=fixture();try{const value=['offline','opaque','fixture',':','x'.repeat(28)].join('_'),known=path.join(f.base,'private.env');writeFileSync(known,'BOT_INTERNAL_SECRET='+value+'\n');for(const encoded of [value,encodeURIComponent(value),Buffer.from(value).toString('base64')]){f.write('asset.bin',Buffer.concat([Buffer.from([0,0,0]),Buffer.from(encoded)]));const r=f.scan('--mode','working','--known-env',known);assert.equal(r.status,1);assert.ok(r.stderr.includes('known-secret-value'));assert.ok(!(r.stdout+r.stderr).includes(value));assert.ok(!(r.stdout+r.stderr).includes(encoded));}}finally{f.close();}
});

test('symbolic links cannot smuggle outside files into the publication set',()=>{
 const f=fixture();try{const outside=path.join(f.base,'private.txt');writeFileSync(outside,'Outside fixture');symlinkSync(outside,path.join(f.root,'linked.txt'));const r=f.scan('--mode','working');assert.equal(r.status,1);assert.ok(r.stderr.includes('symlink-or-submodule'));assert.ok(!r.stderr.includes(outside));}finally{f.close();}
});

test('pre-push checks the pushed branch even when HEAD is clean',()=>{
 const f=fixture();try{
  mkdirSync(path.join(f.root,'scripts'));copyFileSync(scanner,path.join(f.root,'scripts/check-secrets.mjs'));f.git('add','.');f.git('commit','-m','Safe scanner fixture');
  f.git('checkout','-b','unsafe-fixture');f.write('leak.txt',providerFixture());f.git('add','.');f.git('commit','-m','Synthetic branch fixture');const unsafe=f.git('rev-parse','HEAD');f.git('checkout','main');
  assert.equal(f.scan('--mode','tree').status,0);
  const hook=spawnSync('sh',[path.join(project,'.githooks/pre-push')],{cwd:f.root,encoding:'utf8',input:`refs/heads/unsafe-fixture ${unsafe} refs/heads/unsafe-fixture ${'0'.repeat(40)}\n`});
  assert.equal(hook.status,1);assert.ok(hook.stderr.includes('github-token'));
 }finally{f.close();}
});
