/** Read-only status/debug CLI and explicit foreground start, Windows/macOS/Linux. */
import fs from 'node:fs';
import path from 'node:path';
import {PlatformBackend,managedPaths,resolvePlatform,DEFAULT_PORT,pythonEnvIssue,detectSystemPython} from '../lib/platform-backend.js';
const cmd=process.argv[2]||'status';
const paths=managedPaths();
const port=Number(process.env.DSH_CHATGPT2API_PORT||DEFAULT_PORT);
const url=`http://127.0.0.1:${port}`;
const spec=resolvePlatform();
if(cmd==='status'){
  console.info('API 本机地址：',url+'/v1');
  console.info('持久化数据目录：',paths.root);
  console.info('已下载 uv：',fs.existsSync(paths.uv));
  console.info('已下载源码：',fs.existsSync(paths.marker));
  const readyMarker=path.join(paths.source,'.dsh-runtime-ready');
  const readyInfo=fs.existsSync(readyMarker)?fs.readFileSync(readyMarker,'utf8').trim():'';
  const issue=pythonEnvIssue(paths,spec);
  console.info('Python 运行环境：',issue?`不可用（${issue.message}）`:(readyInfo.includes('system:')?'系统已有 Python ('+readyInfo.split('system:')[1]?.trim()+')':(readyInfo.includes('managed')?'轻量隔离 Python 3.13':'已就绪')));
  const system=detectSystemPython({uvBin:paths.uv});
  console.info('系统可用 Python：',system?`${system.version}（${system.path}，来源 ${system.source}）`:'未找到 3.13 系统解释器，将使用托管 Python');
  try{const r=await fetch(url+'/health?format=json',{signal:AbortSignal.timeout(3000)});const j=await r.json();console.log('后端健康状态：',JSON.stringify({status:j.status,healthy:j.healthy,version:j.version,accounts:j.accounts&&{total:j.accounts.total,active:j.accounts.active}},null,2))}catch(e){console.error('后端未就绪：',e.message);process.exitCode=1}
}else if(cmd==='log'){
  if(fs.existsSync(paths.logs))console.log(fs.readFileSync(paths.logs,'utf8').slice(-8000));else console.info('尚未生成日志：'+paths.logs);
}else if(cmd==='repair'){
  // Reuses the same readiness contract as the Host: verify the interpreter,
  // site-packages and required packages, then `uv sync` only what is missing.
  const manager=new PlatformBackend({port,autoStart:false});
  try{const stat=await manager.repair();console.log('Python 运行环境已修复：',stat.runtime)}catch(e){console.error('修复失败：'+e.message);process.exitCode=1}
}else if(cmd==='check'){
  const issue=pythonEnvIssue(paths,spec);
  if(issue){console.error('运行环境不可用：'+issue.message);process.exitCode=1}
  else console.log('运行环境检查通过：解释器、site-packages 与关键依赖齐全');
}else if(cmd==='start'){
  const manager=new PlatformBackend({port});
  try{const stat=await manager.start();console.log('后端已启动，按 Ctrl+C 停止：',stat.baseUrl+'/v1');
    const stop=async()=>{await manager.stop();process.exit(0)};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(e){console.error('启动失败：'+e.message);process.exitCode=1}
}else{
  console.error('用法：node scripts/manage-backend.mjs status | check | repair | log | start');process.exitCode=2;
}
