/** Optional Host-side smoke test. No account data, key, or tokens are printed. */
import fs from 'node:fs';
import {createProvider} from '../lib/provider.js';
import {managedPaths} from '../lib/platform-backend.js';
const p=managedPaths();
const key=process.env.DSH_CHATGPT2API_KEY || (fs.existsSync(p.key)?fs.readFileSync(p.key,'utf8').trim():'');
const api=createProvider({baseUrl:process.env.DSH_CHATGPT2API_URL||'http://127.0.0.1:38650',apiKey:key,timeoutMs:12000});
try{
  const status=await api.health();
  console.log(`后端连通：${api.baseUrl}; version=${status.version||'未知'}; healthy=${status.healthy}; 账号=${status.accounts.total}; 可用=${status.accounts.active}`);
  try{console.log('可用模型：',(await api.models()).join(', ')||'(空)')}
  catch(e){console.error('模型认证失败：',e.message);process.exitCode=2}
}catch(e){console.error('后端未连接：',e.message);process.exitCode=1}
