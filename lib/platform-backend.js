/**
 * Cross-platform local backend for DSH: Windows, macOS, Linux on x64/arm64.
 * It downloads a pinned chatgpt2api source snapshot and a SHA256-verified uv
 * executable, then provisions its own Python 3.13 and isolated dependencies.
 * No Docker and no system Python needed. First run does require internet.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {extractZipSafe,extractUvTarGz} from './archive.js';

export const SOURCE_COMMIT='92dd80e91543157d36a4ddad60e765c5293760e9';
export const UV_VERSION='0.9.13';
export const SOURCE_URL=`https://codeload.github.com/basketikun/chatgpt2api/zip/${SOURCE_COMMIT}`;
export const DEFAULT_PORT=38650;

// Official GitHub release API asset digests for uv v0.9.13.
const UV_BUILDS = Object.freeze({
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip','cdfb04512c9184939f16eea02644a7133b4e41233ead69122d49847d29a45538'],
  'win32-arm64':['uv-aarch64-pc-windows-msvc.zip','761e29d5a67ca61f1d19c20ce935a9fd1f0011efb0e00f1efb20b0801e06b3c4'],
  'darwin-x64':['uv-x86_64-apple-darwin.tar.gz','571cb1623681c439af892335c729c272266e836a9ebcb627f34f8012c6459d9d'],
  'darwin-arm64':['uv-aarch64-apple-darwin.tar.gz','9c594dce1c237e11680be2b6d1331448eeb6f8a1453fb851a66a40291bb624de'],
  'linux-x64-gnu':['uv-x86_64-unknown-linux-gnu.tar.gz','c45a44144bf23a2182e143227b4ad0bbe41a2bb7161a637c02e968906af53fd1'],
  'linux-arm64-gnu':['uv-aarch64-unknown-linux-gnu.tar.gz','c221d04810f873a7aa8bae9aa6ed721e600e56534980df1363952386a4fcdcc5'],
  'linux-x64-musl':['uv-x86_64-unknown-linux-musl.tar.gz','04cf326d2d742ce5c8890fdc0b9f71bd707be8640979bf6e53ddd52da74dfb41'],
  'linux-arm64-musl':['uv-aarch64-unknown-linux-musl.tar.gz','5a81540af68e28df324d01d79900e7b86c659e8167cb236528b8e6050d74f94e']
});

export function detectLinuxLibc(){
  if(process.platform!=='linux')return 'gnu';
  try{return process.report.getReport().header.glibcVersionRuntime?'gnu':'musl';}catch{return 'gnu';}
}
export function resolvePlatform(platform=process.platform,arch=process.arch,libc=detectLinuxLibc()){
  const tag=platform==='linux'?`${platform}-${arch}-${libc}`:`${platform}-${arch}`;
  const data=UV_BUILDS[tag];
  if(!data)throw Error(`暂不支持 ${platform}/${arch}${platform==='linux'?'/'+libc:''}；当前支持 Windows/macOS/Linux 的 x64/arm64（Linux GNU/musl）`);
  const [filename,sha256]=data;
  return {platform,arch,libc:platform==='linux'?libc:null,tag,filename,sha256,
    url:`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${filename}`,
    executable:platform==='win32'?'uv.exe':'uv',
    pythonRelative:platform==='win32'?path.join('Scripts','python.exe'):path.join('bin','python')};
}

export function managedPaths(options={}){
  const root=path.resolve(options.root||process.env.DSH_CHATGPT2API_HOME||path.join(os.homedir(),'.dsh','chatgpt2api-native'));
  const platform=options.platform||process.platform;
  const arch=options.arch||process.arch;
  const libc=options.libc||detectLinuxLibc();
  const tag=platform==='linux'?`${platform}-${arch}-${libc}`:`${platform}-${arch}`;
  return {root,source:path.join(root,'source'),data:path.join(root,'source','data'),
    marker:path.join(root,'source','.dsh-source-commit'),uv:path.join(root,'runtime',platform==='win32'?(arch==='x64'?'uv.exe':'uv-arm64.exe'):`uv-${tag}`),
    key:path.join(root,'admin-key'),downloads:path.join(root,'downloads'),runtime:path.join(root,'runtime'),
    uvCache:path.join(root,'uv-cache'),python:path.join(root,'python'),logs:path.join(root,'backend.log')};
}
export function ensureManagedFiles(paths,keyOverride=''){
  fs.mkdirSync(paths.root,{recursive:true,mode:0o700});
  const valid=/^[\x21-\x7e]{12,256}$/;
  if(keyOverride&&!valid.test(keyOverride))throw Error('Host 内部认证密钥无效：需至少 12 位 ASCII 字符');
  if(!fs.existsSync(paths.key))fs.writeFileSync(paths.key,(keyOverride||crypto.randomBytes(32).toString('hex'))+'\n',{flag:'wx',mode:0o600});
  const key=String(keyOverride||fs.readFileSync(paths.key,'utf8')).trim();
  if(!valid.test(key))throw Error('内部认证密钥损坏，请检查用户数据目录');
  return key;
}
export async function downloadAsset(url,filename,{maxBytes=50000000,sha256='',fetcher=globalThis.fetch}={}){
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const part=filename+'.part';
  // A previous interrupted initialization may leave a stale partial file.
  // Never resume or trust such files; download and verify afresh.
  try{fs.rmSync(part,{force:true})}catch{}
  try{
    const response=await fetcher(url,{redirect:'follow',signal:AbortSignal.timeout(180000)});
    if(!response.ok||!response.body)throw Error(`下载失败 HTTP ${response.status}: ${url}`);
    const final=new URL(response.url||url);
    if(final.protocol!=='https:'||!['github.com','codeload.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(final.hostname))throw Error('下载跳转至未知主机 '+final.hostname);
    const len=Number(response.headers?.get?.('content-length')||0);
    if(len>maxBytes)throw Error('下载文件超过限制');
    let n=0;async function* bytes(){for await(const chunk of Readable.fromWeb(response.body)){n+=chunk.length;if(n>maxBytes)throw Error('下载文件过大');yield chunk;}}
    await pipeline(Readable.from(bytes()),fs.createWriteStream(part,{flags:'wx'}));
    if(n<1000)throw Error('下载内容异常');
    if(sha256){const digest=crypto.createHash('sha256').update(fs.readFileSync(part)).digest('hex');if(digest!==sha256)throw Error('下载 SHA256 不匹配，拒绝执行');}
    fs.renameSync(part,filename);return filename;
  }catch(e){try{fs.rmSync(part,{force:true})}catch{}throw e;}
}
export function runCommand(bin,args,{cwd,env=process.env,timeoutMs=900000,runner=spawn,onLine}={}){
  return new Promise((resolve,reject)=>{
    const p=runner(bin,args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='',done=false;
    const recv=data=>{output=(output+String(data)).slice(-11000);onLine?.(String(data).slice(-350))};
    p.stdout?.on('data',recv);p.stderr?.on('data',recv);
    const timer=setTimeout(()=>{if(done)return;done=true;try{p.kill()}catch{}reject(Error('命令执行超时：'+path.basename(bin)))},timeoutMs);
    p.on('error',e=>{if(done)return;done=true;clearTimeout(timer);reject(Error(`无法执行 ${path.basename(bin)}：${e.message}`))});
    p.on('close',code=>{if(done)return;done=true;clearTimeout(timer);if(code===0)resolve(output.trim());else reject(Error(`命令失败 ${path.basename(bin)}（退出码 ${code}）：${output.slice(-900)}`))});
  });
}
export function validatePort(p){const value=Number(p);if(!Number.isInteger(value)||value<1024||value>65535)throw Error('端口应为 1024–65535');return value;}
export function checkPortFree(port){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',e=>reject(Error(`端口 ${port} 不可用：${e.code||e.message}`)));s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(resolve));});}

export class PlatformBackend{
  constructor(config={},deps={}){
    this.os=deps.platform||process.platform;this.arch=deps.arch||process.arch;
    this.spec=resolvePlatform(this.os,this.arch,deps.libc||detectLinuxLibc());
    this.paths=managedPaths({root:config.dataDir,platform:this.os,arch:this.arch,libc:this.spec.libc||'gnu'});
    this.port=validatePort(config.port??DEFAULT_PORT);
    this.autoStart=config.autoStart!==false;
    this.downloader=deps.downloader||downloadAsset;
    this.extractZip=deps.extractZip||extractZipSafe;
    this.extractTar=deps.extractTar||extractUvTarGz;
    this.executor=deps.executor||runCommand;
    this.fetcher=deps.fetcher||globalThis.fetch;
    this.spawner=deps.spawner||spawn;
    this.sleeper=deps.sleeper||((ms)=>new Promise(r=>setTimeout(r,ms)));
    this.portProbe=deps.portProbe||checkPortFree;
    this.groupKiller=deps.groupKiller||((pid,signal)=>process.kill(-pid,signal));
    this.phase='idle';this.message='尚未启动';this.error='';this.startPromise=null;this.stopping=false;this.child=null;
  }
  get baseUrl(){return `http://127.0.0.1:${this.port}`}
  status(){return {managed:true,runtime:'private-python-3.13',platform:this.spec.tag,phase:this.phase,message:this.message,error:this.error,baseUrl:this.baseUrl,dataDir:this.paths.root,sourceCommit:SOURCE_COMMIT}}
  get uvEnv(){return {...process.env,UV_PYTHON_INSTALL_DIR:this.paths.python,UV_CACHE_DIR:this.paths.uvCache,UV_PYTHON_DOWNLOADS:'automatic',UV_NO_PROGRESS:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}}
  async start(){
    if(this.stopping)throw Error('插件正在停止');
    if(this.startPromise)return this.startPromise;
    this.startPromise=this._start().catch(e=>{this.error=String(e?.message||e).slice(0,750);this.phase='error';this.message='启动失败，请检查网络或平台运行环境';throw e}).finally(()=>{this.startPromise=null});
    return this.startPromise;
  }
  async _setupUv(){
    if(fs.existsSync(this.paths.uv))return;
    this.phase='downloading';this.message=`下载已校验的 uv ${UV_VERSION}（${this.spec.tag}）`;
    const archive=path.join(this.paths.downloads,this.spec.filename);
    if(!fs.existsSync(archive))await this.downloader(this.spec.url,archive,{maxBytes:45000000,sha256:this.spec.sha256});
    // Cached archives are revalidated before extraction.
    const digest=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if(digest!==this.spec.sha256){fs.rmSync(archive,{force:true});throw Error('缓存的 uv SHA256 不匹配');}
    if(this.spec.filename.endsWith('.tar.gz'))this.extractTar(archive,this.paths.uv);
    else{
      const temp=path.join(this.paths.root,'unpack-uv');fs.rmSync(temp,{recursive:true,force:true});
      try{
        this.extractZip(archive,temp);
        const stack=[temp];let found=null;
        while(stack.length){const folder=stack.pop();for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
          const full=path.join(folder,entry.name);if(entry.isDirectory())stack.push(full);else if(entry.name.toLowerCase()==='uv.exe')found=full;
        }}
        if(!found)throw Error('uv 归档缺少可执行文件');
        fs.mkdirSync(this.paths.runtime,{recursive:true});fs.copyFileSync(found,this.paths.uv);
      }finally{fs.rmSync(temp,{recursive:true,force:true});}
    }
    if(this.os!=='win32')fs.chmodSync(this.paths.uv,0o700);
  }
  async _setupSource(){
    if(fs.existsSync(this.paths.marker)&&fs.readFileSync(this.paths.marker,'utf8').trim()===SOURCE_COMMIT&&fs.existsSync(path.join(this.paths.source,'uv.lock')))return;
    if(fs.existsSync(this.paths.source)&&fs.readdirSync(this.paths.source).some(x=>x!=='data'))throw Error('发现不完整或不同版本源码，请备份后手动检查 source 目录（插件不会覆盖）');
    this.phase='downloading';this.message='下载固定提交的 chatgpt2api 后端源码';
    const zip=path.join(this.paths.downloads,`chatgpt2api-${SOURCE_COMMIT}.zip`);
    if(!fs.existsSync(zip))await this.downloader(SOURCE_URL,zip,{maxBytes:35000000});
    const temp=path.join(this.paths.root,'unpack-source');fs.rmSync(temp,{recursive:true,force:true});
    try{
      this.extractZip(zip,temp);
      const folder=path.join(temp,`chatgpt2api-${SOURCE_COMMIT}`);
      if(!fs.existsSync(folder))throw Error('固定版本源码目录不匹配');
      for(const file of ['pyproject.toml','uv.lock','main.py','api','services','utils'])if(!fs.existsSync(path.join(folder,file)))throw Error('源码归档缺少 '+file);
      fs.mkdirSync(this.paths.source,{recursive:true});fs.cpSync(folder,this.paths.source,{recursive:true,force:true});
      fs.mkdirSync(this.paths.data,{recursive:true,mode:0o700});
      fs.writeFileSync(this.paths.marker,SOURCE_COMMIT+'\n');
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }
  async _installPython(){
    const marker=path.join(this.paths.source,'.dsh-runtime-ready');
    const python=path.join(this.paths.source,'.venv',this.spec.pythonRelative);
    if(fs.existsSync(marker)&&fs.existsSync(python))return;
    this.phase='installing';this.message='安装隔离 Python 3.13 与依赖（首次运行需联网）';
    await this.executor(this.paths.uv,['python','install','3.13'],{env:this.uvEnv,timeoutMs:1200000});
    await this.executor(this.paths.uv,['sync','--frozen','--no-dev','--no-install-project','--python','3.13'],{cwd:this.paths.source,env:this.uvEnv,timeoutMs:1500000});
    if(!fs.existsSync(python))throw Error('未找到隔离 Python 虚拟环境：'+python);
    fs.writeFileSync(marker,`${new Date().toISOString()} ${this.spec.tag}\n`);
  }
  async _start(){
    if(!this.autoStart){this.phase='disabled';this.message='自动启动已关闭';return this.status()}
    this.key=ensureManagedFiles(this.paths,process.env.DSH_CHATGPT2API_KEY||'');
    await this._setupUv();if(this.stopping)throw Error('取消启动');
    await this._setupSource();if(this.stopping)throw Error('取消启动');
    await this._installPython();if(this.stopping)throw Error('取消启动');
    this.phase='starting';this.message='启动本机号池 API';
    await this.portProbe(this.port);
    const env={...this.uvEnv,CHATGPT2API_AUTH_KEY:this.key,STORAGE_BACKEND:'sqlite'};
    const args=['run','--no-sync','uvicorn','main:app','--host','127.0.0.1','--port',String(this.port),'--no-access-log'];
    const child=this.spawner(this.paths.uv,args,{cwd:this.paths.source,env,windowsHide:true,shell:false,detached:this.os!=='win32',stdio:['ignore','pipe','pipe']});
    this.child=child;
    const receive=b=>{const txt=String(b).replaceAll(this.key,'[REDACTED]');try{fs.appendFileSync(this.paths.logs,txt,{mode:0o600})}catch{}};
    child.stdout?.on('data',receive);child.stderr?.on('data',receive);
    child.on('error',e=>{if(!this.stopping){this.phase='error';this.error='服务启动失败：'+e.message}});
    child.on('close',code=>{if(!this.stopping){this.phase='error';this.error='后端进程退出：'+code}});
    for(let i=0;i<100;i++){
      if(this.stopping)throw Error('取消启动');
      if(this.phase==='error')throw Error(this.error);
      try{
        const r=await this.fetcher(this.baseUrl+'/health?format=json',{signal:AbortSignal.timeout(1500)});
        if(r.ok){const value=await r.json();if(typeof value.status==='string'){
          this.phase='ready';this.message='服务已就绪，可被 DSH 插件和本机第三方使用';return this.status();
        }}
      }catch{}
      await this.sleeper(800);
    }
    throw Error('后端启动超时，请检查 '+this.paths.logs);
  }
  async stop(){
    this.stopping=true;
    if(this.child){
      const pid=this.child.pid;
      if(this.os==='win32'&&Number.isInteger(pid)){
        try{await this.executor('taskkill.exe',['/PID',String(pid),'/T','/F'],{timeoutMs:16000})}catch{try{this.child.kill()}catch{}}
      }else if(Number.isInteger(pid)){
        try{this.groupKiller(pid,'SIGTERM')}catch{try{this.child.kill('SIGTERM')}catch{}}
      }else try{this.child.kill('SIGTERM')}catch{}
    }
    this.phase='stopped';this.message='已停止，号池账号和 API Key 保留';
  }
}
