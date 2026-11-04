/** Read-only status/debug CLI and explicit foreground start, Windows/macOS/Linux. */
import fs from 'node:fs';
import {PlatformBackend,managedPaths,resolvePlatform,DEFAULT_PORT} from '../lib/platform-backend.js';
const cmd=process.argv[2]||'status';
const paths=managedPaths();
const port=Number(process.env.DSH_CHATGPT2API_PORT||DEFAULT_PORT);
const url=`http://127.0.0.1:${port}`;
if(cmd==='status'){
  console.info('API 本机地址：',url+'/v1');
  console.info('持久化数据目录：',paths.root);
  console.info('已下载 uv：',fs.existsSync(paths.uv));
  console.info('已下载源码：',fs.existsSync(paths.marker));
  console.info('已安装 Python：',fs.existsSync(paths.source+'/.venv/'+resolvePlatform().pythonRelative));
  try{const r=await fetch(url+'/health?format=json',{signal:AbortSignal.timeout(3000)});const j=await r.json();console.log('后端健康状态：',JSON.stringify({status:j.status,healthy:j.healthy,version:j.version,accounts:j.accounts&&{total:j.accounts.total,active:j.accounts.active}},null,2))}catch(e){console.error('后端未就绪：',e.message);process.exitCode=1}
}else if(cmd==='log'){
  if(fs.existsSync(paths.logs))console.log(fs.readFileSync(paths.logs,'utf8').slice(-8000));else console.info('尚未生成日志：'+paths.logs);
}else if(cmd==='start'){
  const manager=new PlatformBackend({port});
  try{const stat=await manager.start();console.log('后端已启动，按 Ctrl+C 停止：',stat.baseUrl+'/v1');
    const stop=async()=>{await manager.stop();process.exit(0)};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(e){console.error('启动失败：'+e.message);process.exitCode=1}
}else{
  console.error('用法：node scripts/manage-backend.mjs status | log | start');process.exitCode=2;
}
