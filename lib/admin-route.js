/**
 * Authenticated, passwordless DSH owner UI -> local upstream bridge.
 * The route is registered via ctx.connection.fetch.register, which applies
 * DSH browser-session cookie + same-origin/Host trust checks. NEVER mount
 * it directly on the public upstream HTTP listener.
 *
 * The Python backend continues to require an internal machine-generated
 * secret. No user needs to see, copy, or enter it, and the browser never
 * receives it. Third-party /v1 clients still use independently revocable
 * user API keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto, {createHmac} from 'node:crypto';
import {CredentialVault, parseCredentialLines} from './credential-vault.js';
import {managedPaths, resolvePlatform, detectLinuxLibc} from './platform-backend.js';

export const ADMIN_ROUTE='/api/chatgpt2api-native/manage';

export class UserKeyStore {
  constructor({root, filePath} = {}) {
    this.filePath = filePath || (root ? path.join(path.resolve(root), 'user-api-keys.json') : null);
    this.keys = new Map();
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') this.keys.set(k, v);
          }
        }
      } catch {}
    }
  }
  get(id) {
    if (!id) return '';
    return this.keys.get(String(id)) || '';
  }
  set(id, key) {
    if (!id || !key) return;
    this.keys.set(String(id), String(key));
    this._save();
  }
  delete(id) {
    if (!id) return;
    if (this.keys.delete(String(id))) {
      this._save();
    }
  }
  _save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), {recursive: true, mode: 0o700});
      const data = Object.fromEntries(this.keys.entries());
      const tmp = this.filePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {mode: 0o600});
      fs.renameSync(tmp, this.filePath);
    } catch {}
  }
}

const MAX_BODY_BYTES=70*1024*1024;
const MAX_REPLY_BYTES=42*1024*1024;
const safeText=x=>typeof x==='string'?x:'';
const safeId=x=>{const value=safeText(x);if(!/^[\w-]{1,100}$/.test(value))throw new Error('无效的管理对象 ID');return value};
const asArray=x=>Array.isArray(x)?x:[];
function fail(message,status=400){const err=new Error(message);err.status=status;return err;}
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
const IMAGE_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.webp']);
function countImages(dir){
  let count=0;
  try{
    for(const entry of fs.readdirSync(dir,{recursive:true,withFileTypes:true})){
      if(entry.isFile()&&IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))count++;
    }
  }catch{}
  return count;
}
/** Reveal one Host-owned directory in the OS file manager; never takes a path from the browser. */
export async function openLocalFolder(dir){
  // Inside the DSH desktop app the Host runs in Electron's main process:
  // shell.openPath is the supported opener and reports a real error string.
  if(process.versions.electron){
    try{
      const {shell}=await import('electron');
      if(shell&&typeof shell.openPath==='function'){
        const error=await shell.openPath(dir);
        if(!error)return;
        throw new Error(error);
      }
    }catch{}
  }
  const [command,args]=process.platform==='win32'?['explorer.exe',[dir]]
    :process.platform==='darwin'?['open',[dir]]:['xdg-open',[dir]];
  await new Promise((resolve,reject)=>{
    let child;
    try{child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true})}catch(e){reject(e);return}
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve()});
  });
}
function cleanAccount(item,key){
  const token=safeText(item?.access_token||item?.accessToken);
  if(!token)return null;
  const ref=createHmac('sha256',key).update(token).digest('hex');
  return {
    ref,email:safeText(item.email),name:safeText(item.name),type:safeText(item.type||item.plan),
    status:safeText(item.status),quota:Number(item.quota??item.image_quota??0)||0,
    image_inflight:Number(item.image_inflight||0)||0
  };
}
function cleanUserKeys(value, keyStore=null){
  return asArray(value).map(x=>{
    const id=safeText(x.id);
    const plain=keyStore?.get(id)||safeText(x.key);
    return {
      id,
      name:safeText(x.name),
      enabled:x.enabled!==false,
      created_at:safeText(x.created_at),
      key:plain
    };
  });
}
function cleanPools(value,fields){return asArray(value).map(x=>Object.fromEntries(fields.map(k=>[k,safeText(x?.[k])])));}
function cleanRemoteAccounts(value){return asArray(value).map(x=>({id:String(x?.id||x?.account_id||''),account_id:String(x?.account_id||''),name:safeText(x?.name),email:safeText(x?.email)}));}
function acceptedImagePayload(input,edit){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('生图参数无效');
  const prompt=safeText(input.prompt).trim();if(!prompt||prompt.length>12000)throw fail('提示词长度不符合要求');
  const model=safeText(input.model||'gpt-image-2');if(!/^[\w.-]{1,80}$/.test(model))throw fail('模型名称不合法');
  const out={model,prompt,n:1,response_format:'b64_json'};
  if(edit){
    const list=asArray(input.images);
    if(!list.length||list.length>4)throw fail('需上传 1–4 张参考图片');
    out.images=list.map((ref,i)=>{
      const b64=safeText(ref?.b64_json),mime=safeText(ref?.mime_type||'image/png');
      if(!/^image\/(png|jpeg|webp)$/.test(mime)||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)||b64.length%4!==0||!b64||b64.length>16*1024*1024)throw fail(`第 ${i+1} 张参考图无效或超过12MB`);
      return {b64_json:b64,mime_type:mime,filename:`reference-${i+1}.${mime.split('/')[1]==='jpeg'?'jpg':mime.split('/')[1]}`};
    });
  }
  return out;
}
export function createAdminHandler({baseUrl,secret,fetcher=globalThis.fetch,vault=null,authenticator=null,keyStore=null,imagesDir=null,openFolder=openLocalFolder}={}){
  const resolvedKeyStore=keyStore||new UserKeyStore();
  const resolvedImagesDir=imagesDir?path.resolve(String(imagesDir)):null;
  if(!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(String(baseUrl)))throw Error('管理接口只允许回环地址的上游服务');
  if(!secret||secret.length<12)throw Error('未配置仅 Host 可访问的后端内部凭据');
  async function call(path,method='GET',body=undefined,timeoutMs=15000){
    const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const r=await fetcher(baseUrl+path,{method,headers:{'Authorization':`Bearer ${secret}`,'Accept':'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:ac.signal,redirect:'error'});
      if(Number(r.headers?.get?.('content-length')||0)>MAX_REPLY_BYTES)throw fail('上游响应过大',502);
      const raw=await r.text();if(Buffer.byteLength(raw)>MAX_REPLY_BYTES)throw fail('上游响应过大',502);
      let data;try{data=JSON.parse(raw)}catch{
        // Field reports of this message are undiagnosable without the upstream
        // status and body: an ASGI crash answers with plain-text "Internal Server
        // Error" while the real cause (e.g. a missing site-packages) stays in the
        // backend log. Surface a redacted snippet instead.
        const contentType=String(r.headers?.get?.('content-type')||'unknown');
        const snippet=String(raw).replace(/\s+/g,' ').trim().slice(0,140)
          .replaceAll(String(secret),'[REDACTED]')
          .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g,'sk-[REDACTED]');
        throw fail(`号池后端返回了非 JSON 响应（HTTP ${r.status}，Content-Type: ${contentType}）${snippet?`：${snippet}`:''}`,502)
      }
      if(!r.ok){const message=String(data?.detail?.error||data?.detail?.message||data?.error?.message||data?.detail||data?.error||'');
        const publicDetail=/^(no available image quota|rate limit|quota exceeded|invalid api key)$/i.test(message.trim()) ? `：${message.trim()}` : '';
        throw fail(`号池请求失败 HTTP ${r.status}${publicDetail}（详情请看 Host 日志）`,r.status>=400&&r.status<600?r.status:502)}
      return data;
    }catch(e){if(ac.signal.aborted)throw fail('后端请求超时',504);throw e}finally{clearTimeout(tm)}
  }
  function accountRef(t){return createHmac('sha256',secret).update(t).digest('hex')}
  async function resolveAccountRef(ref){
    if(!/^[a-f0-9]{64}$/.test(safeText(ref)))throw fail('账号引用无效');
    const accounts=asArray((await call('/api/accounts')).items);
    const account=accounts.find(a=>accountRef(safeText(a.access_token||a.accessToken))===ref);
    if(!account)throw fail('账号已改变，请刷新账号列表',404);
    return safeText(account.access_token||account.accessToken);
  }
  async function execute({path,method='GET',body}={}){
    if(typeof path!=='string'||typeof method!=='string')throw fail('请求格式无效');
    method=method.toUpperCase();
    // Fixed Host-owned directory only: the browser cannot pass a path here.
    if(path==='/local/open-images-dir'){
      if(method!=='GET'&&method!=='POST')throw fail('接口方法不允许',405);
      if(!resolvedImagesDir)throw fail('当前使用外部后端，没有本机历史图片目录',503);
      try{fs.mkdirSync(resolvedImagesDir,{recursive:true})}catch(e){throw fail(`历史图片目录不可用：${e.message}`,500)}
      const count=countImages(resolvedImagesDir);
      // GET only reports the path so the UI can show a copyable address.
      if(method==='GET')return {dir:resolvedImagesDir,count,opened:false};
      try{await openFolder(resolvedImagesDir)}
      catch(e){return {dir:resolvedImagesDir,count,opened:false,error:String(e?.message||e).slice(0,200)}}
      return {dir:resolvedImagesDir,count,opened:true};
    }
    if(path==='/local/credential-vault'){
      if(!vault)throw fail('本地加密账号暂存功能不可用',503);
      if(method==='GET')return vault.list();
      if(method==='POST'){
        if(!body||typeof body.text!=='string')throw fail('请输入账号行文本');
        if(body.autoAuth){
          if(!authenticator)throw fail('账号自动认证功能不可用',503);
          const parsed=parseCredentialLines(body.text);
          if(!parsed.accounts.length)throw fail('未包含有效的账号数据');
          const targets=parsed.accounts.map(a=>({id:'',email:a.email,password:a.password,totp_secret:a.auxiliary,access_token:a.accessToken||'',refresh_token:a.refreshToken||''}));
          if(targets.length>100)throw fail('单次最多认证 100 个账号');
          const authResult=await authenticator({accounts:targets,proxy:safeText(body?.proxy)});
          const results=asArray(authResult?.results);
          const successes=results.filter(x=>x?.ok&&safeText(x?.access_token));
          const failures=results.filter(x=>!x?.ok);
          let enrolled={added:0,skipped:parsed.duplicates,refreshed:0,errorCount:0};
          if(successes.length>0){
            const accountItems=successes.map(s=>{
              const orig=targets.find(t=>t.email.toLowerCase()===String(s.email).toLowerCase())||{};
              return {
                email:safeText(s.email),
                password:safeText(s.password||orig.password),
                totp_secret:safeText(s.totp_secret||orig.totp_secret),
                access_token:safeText(s.access_token),
                refresh_token:safeText(s.refresh_token||orig.refresh_token),
                id_token:safeText(s.id_token),
                source_type:'oauth_password_2fa',
                type:'oauth'
              };
            });
            const tokens=successes.map(s=>safeText(s.access_token));
            const r=await call('/api/accounts','POST',{accounts:accountItems,tokens},180000);
            enrolled={added:Number(r.added)||0,skipped:(Number(r.skipped)||0)+parsed.duplicates,refreshed:Number(r.refreshed)||0,errorCount:asArray(r.errors).length};
          }
          if(failures.length>0){
            const failLines=failures.map(f=>{
              const orig=targets.find(t=>t.email.toLowerCase()===String(f.email).toLowerCase());
              return orig?`${orig.email}----${orig.password}----${orig.totp_secret}${orig.access_token?'----'+orig.access_token:''}`:'';
            }).filter(Boolean).join('\n');
            if(failLines)vault.importText(failLines);
            for(const f of failures){
              const match=vault.getAll().find(r=>r.email.toLowerCase()===String(f.email).toLowerCase());
              if(match)try{vault.updateStatus(match.id,{state:'auth_failed',lastError:safeText(f.error||'认证失败')})}catch{}
            }
          }
          return {
            autoAuth:true,
            total:targets.length+parsed.duplicates,
            succeeded:successes.length,
            failed:failures.length,
            duplicates:parsed.duplicates,
            enrolled,
            failures:failures.map(f=>({email:safeText(f.email),error:safeText(f.error).slice(0,100)})),
            invalid:parsed.errors.length,
            errors:parsed.errors.slice(0,100),
            vaultCount:vault.list().count
          };
        }
        return vault.importText(body.text);
      }
    }
    if(path==='/local/credential-vault/authenticate'&&method==='POST'){
      if(!vault)throw fail('本地账号暂存功能不可用',503);
      if(!authenticator)throw fail('账号自动认证功能不可用',503);
      let targets=[];
      const text=safeText(body?.text);
      const id=safeText(body?.id);
      const all=Boolean(body?.all);
      let duplicateCount=0;
      let parseErrors=[];
      if(text.trim()){
        const parsed=parseCredentialLines(text);
        if(!parsed.accounts.length)throw fail('未包含有效的账号数据');
        targets=parsed.accounts.map(a=>({id:'',email:a.email,password:a.password,totp_secret:a.auxiliary,access_token:a.accessToken||'',refresh_token:a.refreshToken||''}));
        duplicateCount=parsed.duplicates;
        parseErrors=parsed.errors;
      }else if(id){
        const record=vault.get(id);
        if(!record)throw fail('未找到指定的暂存账号',404);
        targets=[{id:record.id,email:record.email,password:record.password,totp_secret:record.auxiliary,access_token:record.accessToken||'',refresh_token:record.refreshToken||''}];
      }else if(all){
        const records=vault.getAll();
        if(!records.length)throw fail('没有待授权的暂存账号');
        targets=records.map(r=>({id:r.id,email:r.email,password:r.password,totp_secret:r.auxiliary,access_token:r.accessToken||'',refresh_token:r.refreshToken||''}));
      }else{
        throw fail('请提供待授权账号文本、账号 ID 或指定全部授权');
      }
      if(targets.length>100)throw fail('单次最多认证 100 个账号');
      const authResult=await authenticator({accounts:targets,proxy:safeText(body?.proxy)});
      const results=asArray(authResult?.results);
      const successes=results.filter(x=>x?.ok&&safeText(x?.access_token));
      const failures=results.filter(x=>!x?.ok);
      let enrolled={added:0,skipped:duplicateCount,refreshed:0,errorCount:0};
      if(successes.length>0){
        const accountItems=successes.map(s=>{
          const orig=targets.find(t=>t.email.toLowerCase()===String(s.email).toLowerCase())||{};
          return {
            email:safeText(s.email),
            password:safeText(s.password||orig.password),
            totp_secret:safeText(s.totp_secret||orig.totp_secret),
            access_token:safeText(s.access_token),
            refresh_token:safeText(s.refresh_token||orig.refresh_token),
            id_token:safeText(s.id_token),
            source_type:'oauth_password_2fa',
            type:'oauth'
          };
        });
        const tokens=successes.map(s=>safeText(s.access_token));
        const r=await call('/api/accounts','POST',{accounts:accountItems,tokens},180000);
        enrolled={added:Number(r.added)||0,skipped:(Number(r.skipped)||0)+duplicateCount,refreshed:Number(r.refreshed)||0,errorCount:asArray(r.errors).length};
        for(const s of successes){
          if(s.id)try{vault.delete(s.id)}catch{}
          else{
            const match=vault.getAll().find(r=>r.email.toLowerCase()===String(s.email).toLowerCase());
            if(match)try{vault.delete(match.id)}catch{}
          }
        }
      }
      for(const f of failures){
        const targetId=f.id||vault.getAll().find(r=>r.email.toLowerCase()===String(f.email).toLowerCase())?.id;
        if(targetId)try{vault.updateStatus(targetId,{state:'auth_failed',lastError:safeText(f.error||'认证失败')})}catch{}
      }
      return {
        total:targets.length+duplicateCount,
        succeeded:successes.length,
        failed:failures.length,
        duplicates:duplicateCount,
        enrolled,
        failures:failures.map(f=>({email:safeText(f.email),error:safeText(f.error).slice(0,100)})),
        invalid:parseErrors.length,
        errors:parseErrors.slice(0,100),
        vaultCount:vault.list().count
      };
    }
    const vaultDelete=path.match(/^\/local\/credential-vault\/([0-9a-f-]{36})$/i);
    if(vaultDelete&&method==='DELETE'){
      if(!vault)throw fail('本地加密账号暂存功能不可用',503);
      return vault.delete(vaultDelete[1]);
    }
    if(path==='/health?format=json'&&method==='GET'){
      const x=await call(path);return {status:x.status,healthy:x.healthy,version:x.version,accounts:x.accounts,baseUrl};
    }
    if(path==='/api/accounts'){
      if(method==='GET')return {items:asArray((await call(path)).items).map(x=>cleanAccount(x,secret)).filter(Boolean)};
      if(method==='POST'){
        const tokens=asArray(body?.tokens).map(safeText).filter(Boolean),accounts=asArray(body?.accounts);
        if((tokens.length+accounts.length)<1||(tokens.length+accounts.length)>100)throw fail('每次只能导入 1–100 个账号');
        if(tokens.some(x=>x.length>12000)||accounts.some(x=>!safeText(x?.access_token||x?.accessToken)))throw fail('账号数据无效');
        const r=await call(path,'POST',{tokens,accounts},160000);
        return {added:r.added,skipped:r.skipped,refreshed:r.refreshed,errorCount:asArray(r.errors).length};
      }
      if(method==='DELETE'){
        const refs=asArray(body?.tokens);if(refs.length!==1)throw fail('每次仅能删除一个已显示的账号');
        const token=await resolveAccountRef(refs[0]);await call(path,'DELETE',{tokens:[token]});return {ok:true};
      }
    }
    if(path==='/api/accounts/refresh'&&method==='POST'){
      const refs=asArray(body?.access_tokens);if(refs.length!==1)throw fail('每次仅刷新一个已显示的账号');
      const token=await resolveAccountRef(refs[0]);
      const r=await call(path,'POST',{access_tokens:[token]},30000);
      return {progress_id:r.progress_id||null,refreshed:r.refreshed||0};
    }
    if(path==='/api/auth/users'){
      if(method==='GET')return {items:cleanUserKeys((await call(path)).items, resolvedKeyStore)};
      if(method==='POST'){
        const name=safeText(body?.name).trim().slice(0,100)||'本机应用';
        const r=await call(path,'POST',{name});
        const rawKey=safeText(r.key);
        let createdId=safeText(r.item?.id);
        const cleaned=cleanUserKeys(r.items, resolvedKeyStore);
        if(!createdId && cleaned.length){
          const match=cleaned.find(x=>x.name===name)||cleaned[cleaned.length-1];
          createdId=safeText(match?.id);
        }
        if(createdId && rawKey){
          resolvedKeyStore.set(createdId, rawKey);
          const found=cleaned.find(x=>x.id===createdId);
          if(found)found.key=rawKey;
        }
        return {key:rawKey,id:createdId,items:cleaned};
      }
    }
    const keyId=path.match(/^\/api\/auth\/users\/([a-zA-Z0-9_-]{1,100})$/);
    if(keyId&&method==='DELETE'){
      const r=await call(path,'DELETE');
      resolvedKeyStore.delete(keyId[1]);
      return {items:cleanUserKeys(r.items, resolvedKeyStore)};
    }
    if(keyId&&method==='POST'){
      const r=await call(path,'POST',body);
      if(body?.key){
        resolvedKeyStore.set(keyId[1], safeText(body.key));
      }
      return {item:r.item,key:safeText(body?.key),items:cleanUserKeys(r.items, resolvedKeyStore)};
    }
    if(path==='/api/cpa/pools'){
      if(method==='GET')return {pools:cleanPools((await call(path)).pools,['id','name','base_url'])};
      if(method==='POST'){
        const url=safeText(body?.base_url).trim();if(!/^https?:\/\//.test(url)||!safeText(body?.secret_key))throw fail('CPA 地址或密钥为空');
        const r=await call(path,'POST',{name:safeText(body?.name),base_url:url,secret_key:safeText(body.secret_key)});
        return {pools:cleanPools(r.pools,['id','name','base_url'])};
      }
    }
    const cpa=path.match(/^\/api\/cpa\/pools\/([\w-]{1,100})\/(files|import)$/);
    if(cpa){safeId(cpa[1]);if(cpa[2]==='files'&&method==='GET'){
      const r=await call(path);return {files:asArray(r.files).map(x=>typeof x==='string'?x:{name:safeText(x.name||x.filename)}).slice(0,200)};
    }
    if(cpa[2]==='import'&&method==='POST'){
      const names=asArray(body?.names).map(safeText).filter(Boolean).slice(0,100);
      return {import_job:(await call(path,'POST',{names},30000)).import_job||null};
    }}
    if(path==='/api/sub2api/servers'){
      if(method==='GET')return {servers:cleanPools((await call(path)).servers,['id','name','base_url'])};
      if(method==='POST'){
        const url=safeText(body?.base_url).trim();if(!/^https?:\/\//.test(url)||!safeText(body?.api_key))throw fail('sub2api 地址或密钥为空');
        const r=await call(path,'POST',{name:safeText(body?.name),base_url:url,api_key:safeText(body?.api_key)});
        return {servers:cleanPools(r.servers,['id','name','base_url'])};
      }
    }
    const sub=path.match(/^\/api\/sub2api\/servers\/([\w-]{1,100})\/(accounts|import)$/);
    if(sub){safeId(sub[1]);if(sub[2]==='accounts'&&method==='GET')return {accounts:cleanRemoteAccounts((await call(path)).accounts).slice(0,200)};
      if(sub[2]==='import'&&method==='POST'){
        const ids=asArray(body?.account_ids).map(safeText).filter(Boolean).slice(0,100);return {import_job:(await call(path,'POST',{account_ids:ids},30000)).import_job||null};
      }
    }
    if(method==='POST'&&(path==='/v1/images/generations'||path==='/v1/images/edits')){
      const input=acceptedImagePayload(body,path==='/v1/images/edits');
      const result=await call(path,'POST',input,240000);
      return {data:asArray(result.data).slice(0,1).map(x=>({b64_json:safeText(x.b64_json),url:safeText(x.url)})),created:result.created||null};
    }
    throw fail('未授权的管理操作或接口路径',404);
  }
  async function route(req){
    try{
      if(req.method!=='POST')return jsonResponse({error:'Method Not Allowed'},405);
      const raw=await req.text();if(Buffer.byteLength(raw)>MAX_BODY_BYTES)return jsonResponse({error:'请求体过大'},413);
      let payload;try{payload=JSON.parse(raw)}catch{throw fail('请求 JSON 格式无效')}
      return jsonResponse(await execute(payload));
    }catch(e){return jsonResponse({error:String(e?.message||e).replaceAll(secret,'[REDACTED]').slice(0,350)},Number.isInteger(e.status)?e.status:502)}
  }
  return {route,execute};
}
export function createNativeAuthenticator(service){
  return async function authenticateAccounts({accounts=[],proxy=''}={}){
    if(!Array.isArray(accounts)||!accounts.length)return {results:[]};
    const manager=service?.manager;
    const paths=manager?.paths||managedPaths();
    const osName=manager?.os||process.platform;
    const archName=manager?.arch||process.arch;
    const libcName=manager?.spec?.libc||detectLinuxLibc();
    const spec=resolvePlatform(osName,archName,libcName);
    const pythonBin=path.join(paths.source,'.venv',spec.pythonRelative);
    if(!fs.existsSync(pythonBin)){
      throw fail('Python 后端运行环境尚未就绪，请等待服务初始化完成',503);
    }
    const __dirname=path.dirname(fileURLToPath(import.meta.url));
    const workerScript=path.resolve(__dirname,'../scripts/auth-worker.py');
    if(!fs.existsSync(workerScript)){
      throw fail('未找到账号认证工作脚本',500);
    }
    const inputJson=JSON.stringify({
      action:'authenticate',
      accounts:accounts.map(a=>({
        id:safeText(a.id),
        email:safeText(a.email),
        password:safeText(a.password),
        totp_secret:safeText(a.totp_secret||a.auxiliary),
        access_token:safeText(a.access_token),
        refresh_token:safeText(a.refresh_token)
      })),
      proxy:safeText(proxy)
    });
    const env={
      ...process.env,
      UV_PYTHON_INSTALL_DIR:paths.python,
      UV_CACHE_DIR:paths.uvCache,
      PYTHONDONTWRITEBYTECODE:'1',
      PYTHONUNBUFFERED:'1'
    };
    return new Promise((resolve,reject)=>{
      const child=spawn(pythonBin,[workerScript],{
        cwd:paths.source,
        env,
        windowsHide:true,
        stdio:['pipe','pipe','pipe']
      });
      let stdout='',stderr='';
      child.stdout.on('data',d=>{stdout+=String(d)});
      child.stderr.on('data',d=>{stderr+=String(d)});
      const timeoutMs=Math.max(60000,accounts.length*45000);
      const timer=setTimeout(()=>{
        try{child.kill()}catch{}
        reject(fail('账号认证执行超时',504));
      },timeoutMs);
      child.on('error',err=>{
        clearTimeout(timer);
        reject(fail(`启动认证进程失败：${err.message}`,500));
      });
      child.on('close',code=>{
        clearTimeout(timer);
        if(code!==0){
          reject(fail(`认证脚本退出异常（码 ${code}）：${(stderr||stdout).slice(-300)}`,502));
          return;
        }
        try{
          resolve(JSON.parse(stdout.trim()));
        }catch(e){
          reject(fail('认证脚本返回无效数据',502));
        }
      });
      child.stdin.write(inputJson);
      child.stdin.end();
    });
  };
}

export function createAdminRoute(service,options={}){
  const {baseUrl,secret,authenticator,keyStore}=options;
  const resolvedSecret=secret||service._adminKey;
  // Credentials are staged in the local DSH-owned data directory, independent
  // of upstream token-based accounts, and encrypted with the Host-only key.
  const root=service?.manager?.paths?.root||managedPaths().root;
  const vault=new CredentialVault({root,secret:resolvedSecret});
  const resolvedKeyStore=keyStore||new UserKeyStore({root});
  const resolvedAuthenticator=authenticator||createNativeAuthenticator(service);
  // Local image history lives in the managed backend's data dir; an external
  // backend has no folder on this machine.
  const dataDir=service?.manager?.paths?.data||null;
  const handler=createAdminHandler({baseUrl:baseUrl||service.baseUrl,secret:resolvedSecret,vault,authenticator:resolvedAuthenticator,keyStore:resolvedKeyStore,imagesDir:dataDir?path.join(dataDir,'images'):null});
  return {path:ADMIN_ROUTE,methods:['POST'],requestBody:'buffered',fetch:(req)=>handler.route(req)};
}
