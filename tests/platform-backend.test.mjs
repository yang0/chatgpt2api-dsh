import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PlatformBackend,managedPaths,resolvePlatform,ensureManagedFiles,validatePort,DEFAULT_PORT,SOURCE_COMMIT,UV_VERSION,detectSystemPython,probePythonExecutable} from '../lib/platform-backend.js';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dsh-c2a-v06-'));
const cases=[
  ['win32','x64','gnu'],['win32','arm64','gnu'],
  ['darwin','x64','gnu'],['darwin','arm64','gnu'],
  ['linux','x64','gnu'],['linux','arm64','gnu'],
  ['linux','x64','musl'],['linux','arm64','musl']
];

test('all 8 Windows/macOS/Linux runtime targets have pinned SHA256',()=>{
  for(const [platform,arch,libc] of cases){
    const spec=resolvePlatform(platform,arch,libc);
    assert.match(spec.sha256,/^[a-f0-9]{64}$/);
    assert.match(spec.url,/^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/0\.9\.13\/uv-/);
    assert.equal(spec.filename.endsWith('.zip'),platform==='win32');
    assert.equal(spec.pythonRelative.includes('Scripts'),platform==='win32');
  }
  assert.equal(DEFAULT_PORT,38650);
  assert.match(SOURCE_COMMIT,/^[0-9a-f]{40}$/);
  assert.equal(UV_VERSION,'0.9.13');
  assert.throws(()=>resolvePlatform('freebsd','x64'),/暂不支持/);
  assert.throws(()=>resolvePlatform('linux','ia32'),/暂不支持/);
  assert.throws(()=>validatePort(80),/端口/);
});

test('windows v0.5 existing credential and account paths are preserved',t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const p=managedPaths({root,platform:'win32',arch:'x64'});
  const k=ensureManagedFiles(p);
  assert.equal(k,ensureManagedFiles(p));
  assert.equal(p.uv,path.join(root,'runtime','uv.exe'));
  const wArm=managedPaths({root,platform:'win32',arch:'arm64'});
  assert.equal(wArm.uv,path.join(root,'runtime','uv-arm64.exe'));
  assert.equal(p.key,path.join(root,'admin-key'));
  assert.equal(p.data,path.join(root,'source','data'));
  assert.throws(()=>ensureManagedFiles(p,'short'),/密钥/);
  const lx=managedPaths({root,platform:'linux',arch:'x64',libc:'gnu'});
  const la=managedPaths({root,platform:'linux',arch:'arm64',libc:'musl'});
  assert.notEqual(lx.uv,la.uv);
});

for(const [platform,arch,libc] of cases){
  test(`simulate first boot, health and clean stop: ${platform}/${arch}/${libc}`,async t=>{
    const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
    const dummy=Buffer.from('pretend archive version 0.9.13');
    const downloads=[],commands=[],launches=[],termination=[];
    const downloader=async(url,file,opts)=>{downloads.push({url,file,opts});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,dummy)};
    const extractor=(archive,dest)=>{
      if(archive.endsWith('.tar.gz')){
        fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'fake-uv');
      }else if(archive.includes('uv-')){
        fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'uv.exe'),'fake-uv');
      }else{
        const dir=path.join(dest,`chatgpt2api-${SOURCE_COMMIT}`);
        fs.mkdirSync(dir,{recursive:true});
        for(const file of ['pyproject.toml','uv.lock','main.py'])fs.writeFileSync(path.join(dir,file),'stub');
        for(const folder of ['api','services','utils'])fs.mkdirSync(path.join(dir,folder));
      }
    };
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=123456;child.kill=()=>{};
    const executor=async(bin,args)=>{commands.push({bin,args});if(args[0]==='sync'){
      const spec=resolvePlatform(platform,arch,libc);
      const py=path.join(root,'source','.venv',spec.pythonRelative);
      fs.mkdirSync(path.dirname(py),{recursive:true});fs.writeFileSync(py,'python-stub');
    }return ''};
    const backend=new PlatformBackend({dataDir:root},{platform,arch,libc,downloader,extractZip:extractor,extractTar:extractor,executor,
      spawner:(bin,args,opts)=>{launches.push({bin,args,opts});return child},
      portProbe:async()=>{},fetcher:async()=>({ok:true,json:async()=>({status:'degraded'})}),sleeper:async()=>{},
      groupKiller:(pid,sig)=>termination.push([pid,sig])});
    backend.spec.sha256=crypto.createHash('sha256').update(dummy).digest('hex');
    const result=await backend.start();
    assert.equal(result.phase,'ready');assert.equal(result.platform,resolvePlatform(platform,arch,libc).tag);
    assert.equal(downloads.length,2);
    assert.equal(downloads[0].opts.sha256,backend.spec.sha256);
    assert.equal(commands.filter(c=>c.args[0]==='python').length,1);
    assert.equal(commands.filter(c=>c.args[0]==='sync').length,1);
    assert.equal(launches.length,1);
    assert.equal(launches[0].opts.detached,platform!=='win32');
    assert.deepEqual(launches[0].args.slice(-4),['127.0.0.1','--port','38650','--no-access-log']);
    assert.equal(launches[0].opts.env.STORAGE_BACKEND,'sqlite');
    assert.equal(launches[0].opts.env.CHATGPT2API_AUTH_KEY,ensureManagedFiles(backend.paths));
    assert.equal(fs.readFileSync(backend.paths.marker,'utf8').trim(),SOURCE_COMMIT);
    await backend.stop();
    if(platform==='win32')assert.ok(commands.some(c=>c.bin==='taskkill.exe'));
    else assert.deepEqual(termination,[[123456,'SIGTERM']]);
    // A restart is not attempted after DSH unload, but installed source and
    // user data remain in the same stable path.
    assert.ok(fs.existsSync(path.join(backend.paths.source,'uv.lock')));
  });
}

test('checksum failures refuse extraction and execution',async t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const b=new PlatformBackend({dataDir:root},{platform:'linux',arch:'x64',libc:'gnu',
    downloader:async(_,file)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'wrong archive')},
    extractTar:()=>{throw Error('should not extract')}});
  await assert.rejects(()=>b.start(),/SHA256/);
  assert.equal(b.phase,'error');
});

test('disabled startup does not download or request credentials',async t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const b=new PlatformBackend({dataDir:root,autoStart:false},{platform:'darwin',arch:'arm64'});
  assert.equal((await b.start()).phase,'disabled');
  assert.equal(fs.readdirSync(root).length,0);
});


test('probePythonExecutable safely returns null for invalid executables', () => {
  assert.equal(probePythonExecutable(''), null);
  assert.equal(probePythonExecutable('definitely-not-a-real-python-binary-12345'), null);
});

test('PlatformBackend reuses detected system Python and skips uv python download', async t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const dummy = Buffer.from('pretend archive version 0.9.13');
  const commands = [];
  const downloader = async (url, file, opts) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, dummy); };
  const extractor = (archive, dest) => {
    if (archive.endsWith('.tar.gz') || archive.includes('uv-')) {
      fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, 'fake-uv');
    } else {
      const dir = path.join(dest, `chatgpt2api-${SOURCE_COMMIT}`);
      fs.mkdirSync(dir, {recursive: true});
      for (const file of ['pyproject.toml', 'uv.lock', 'main.py']) fs.writeFileSync(path.join(dir, file), 'stub');
      for (const folder of ['api', 'services', 'utils']) fs.mkdirSync(path.join(dir, folder));
    }
  };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999; child.kill = () => {};
  const executor = async (bin, args) => {
    commands.push({bin, args});
    if (args[0] === 'sync') {
      const py = path.join(root, 'source', '.venv', 'bin', 'python');
      fs.mkdirSync(path.dirname(py), {recursive: true}); fs.writeFileSync(py, 'python-stub');
    }
    return '';
  };

  const fakeSysPy = '/usr/local/bin/python3.13';
  const backend = new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu',
    downloader, extractZip: extractor, extractTar: extractor, executor,
    systemPythonFinder: () => ({path: fakeSysPy, version: '3.13', major: 3, minor: 13, source: 'system'}),
    spawner: (bin, args, opts) => child,
    portProbe: async () => {},
    fetcher: async () => ({ok: true, json: async () => ({status: 'ok'})}),
    sleeper: async () => {},
    groupKiller: () => {}
  });
  backend.spec.sha256 = crypto.createHash('sha256').update(dummy).digest('hex');
  const result = await backend.start();

  assert.equal(result.phase, 'ready');
  // Must skip uv python install (0 calls)
  assert.equal(commands.filter(c => c.args[0] === 'python' && c.args[1] === 'install').length, 0);
  // Must create venv with system site packages
  assert.ok(commands.some(c => c.args[0] === 'venv' && c.args.includes('--system-site-packages') && c.args.includes(fakeSysPy)));
  // Must sync with detected system python
  assert.ok(commands.some(c => c.args[0] === 'sync' && c.args.includes(fakeSysPy)));
  // Runtime reflects system Python
  assert.match(backend.status().runtime, /system-python/);

  await backend.stop();
});
