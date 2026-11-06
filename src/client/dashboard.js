/* DSH native panel for independent cross-platform local chatgpt2api service.
 * Admin requests go through DSH's same-origin authenticated Connection route;
 * no login prompt, admin credential, or upstream admin authorization in browser.
 */
function createChatGPT2APIDashboard(React, STYLES) {
  const h=React.createElement;
  const {useState,useEffect,useMemo,useRef,useCallback}=React;
  const useIsoLayoutEffect=typeof React.useLayoutEffect==='function'?React.useLayoutEffect:useEffect;
  const PANEL='chatgpt2api-dashboard';
  const DEFAULT_URL='http://127.0.0.1:38650';
  const PAGES=[['overview','总览','▣'],['accounts','号池管理','◉'],['api','API 接入','⇄'],['image','图片生成','▧'],['advanced','高级导入','⚙'],['settings','插件设置','≡']];
  const MAX_FILE_SIZE=12*1024*1024;
  function urlClean(value){
    try{const u=new URL(String(value).trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return null;return u.origin}catch{return null}
  }

  function shortError(e){return String(e?.message||e||'请求失败').slice(0,260)}
  const DEFAULT_PROMPT='一只橘猫坐在木质窗台上晒太阳，水彩插画风格，柔和光线';
  const ZERO_QUOTA_PROMPT='我已经导入了所有的账号，但是剩余额度一直是 0，让他检查了一下。请帮我排查 chatgpt2api-dsh：确认登录和 Token 导入正常后，重点检查 chatgpt.com 的额度查询是否走了代理、全局 proxy 配置是否正确，并测试代理连通性与账号额度刷新进度。不要直接把数据库额度改成非零，也不要在聊天中暴露账号密码、2FA 密钥或 Token。';
  // Upstream refuses portrait / suggestive image prompts with a polite apology
  // in plain text (HTTP 400, code content_policy_violation). Showing that text
  // verbatim reads like a plugin bug, so name the cause and say what to change.
  const POLICY_ERROR=/违反|防护限制|内容政策|安全策略|敏感|不安全|挑逗|性暗示|violat|moderation|content[_ ]policy|safety/i;
  function imageFailureText(raw){
    const text=String(raw||'请求失败').slice(0,300);
    if(!POLICY_ERROR.test(text))return text;
    return '上游以内容安全策略拒绝了本次生图，这不是号池或网络故障。\n'+
      '请避免「写真 / 真人 / 性感 / 身体特写」等描述，改用插画、水彩、景物或虚构角色后重试。\n'+
      '（上游原文：'+text.slice(0,180)+'）';
  }
  function HeaderIcon(){return h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'20px',height:'20px',fontSize:'18px'}},'◉')}
  function Chip({kind='neutral',children}){return h('span',{className:'c2a-chip '+kind},children)}
  function Btn({children,onClick,primary=false,disabled=false,danger=false,cls='',className='',style,title}){
    const c='c2a-button'+(primary?' primary':'')+(danger?' danger':'')+((cls||className)?' '+(cls||className):'');
    return h('button',{type:'button',className:c,onClick,disabled,style,title},children);
  }
  function Card({title,children,cls=''}){return h('section',{className:'c2a-card '+cls},h('h3',null,title),children)}
  function number(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString('zh-CN'):'—'}
  function maskToken(v){if(typeof v!=='string'||!v)return '—';return v.slice(0,5)+'••••'+v.slice(-4)}
  function accountToken(a){return String(a?.ref||'')}
  function copyToClipboard(text, onSuccess){
    if(!text)return;
    function fallback(){
      try{
        if(typeof document==='undefined')return;
        const ta=document.createElement('textarea');
        ta.value=text;
        ta.setAttribute('readonly','');
        ta.style.position='fixed';
        ta.style.top='-9999px';
        ta.style.left='-9999px';
        ta.style.opacity='0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0,99999);
        const ok=document.execCommand('copy');
        document.body.removeChild(ta);
        if(ok&&typeof onSuccess==='function')onSuccess();
      }catch(e){console.warn('复制降级失败',e)}
    }
    try{
      if(globalThis.navigator?.clipboard?.writeText){
        globalThis.navigator.clipboard.writeText(text).then(()=>{
          if(typeof onSuccess==='function')onSuccess();
        }).catch(()=>fallback());
        return;
      }
    }catch{}
    fallback();
  }
  const LOCAL_USER_KEYS_KEY='c2a_saved_user_keys_v1';
  function getLocalUserKeys(){
    try{
      const raw=globalThis.localStorage?.getItem(LOCAL_USER_KEYS_KEY);
      return raw?JSON.parse(raw):{};
    }catch{return {}}
  }
  function saveLocalUserKey(id,key,name){
    if(!id||!key)return;
    try{
      const cur=getLocalUserKeys();
      cur[String(id)]={key:String(key),name:String(name||''),time:Date.now()};
      globalThis.localStorage?.setItem(LOCAL_USER_KEYS_KEY,JSON.stringify(cur));
    }catch{}
  }
  function removeLocalUserKey(id){
    if(!id)return;
    try{
      const cur=getLocalUserKeys();
      delete cur[String(id)];
      globalThis.localStorage?.setItem(LOCAL_USER_KEYS_KEY,JSON.stringify(cur));
    }catch{}
  }
  function formatKeyDate(str){
    if(!str)return '—';
    try{
      const d=new Date(str);
      if(isNaN(d.getTime()))return String(str).slice(0,19).replace('T',' ');
      const p=n=>String(n).padStart(2,'0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }catch{return String(str).slice(0,19)}
  }
  function parseJsonResponse(resp,txt){
    let obj;try{obj=JSON.parse(txt)}catch{throw Error(`HTTP ${resp.status}: 返回内容不是 JSON`)}
    if(!resp.ok){const err=obj?.detail?.error||obj?.detail?.message||obj?.detail||obj?.error?.message||obj?.error||('HTTP '+resp.status);throw Error(typeof err==='string'?err:JSON.stringify(err))}
    return obj;
  }
  // DSH renders only the active 'main' entry: switching to another plugin
  // panel or to another session unmounts this component, and coming back
  // mounts a brand-new instance. Component-local state by definition starts
  // over, which reads exactly like a full page refresh (tab resets, drafts
  // vanish, requests restart, scroll jumps to top).
  //
  // The panel therefore keeps its whole view model outside the component:
  // active tab, drafts, file selections, fetched snapshots, busy flags,
  // long-running task results and the scroll offset per tab. Setters write
  // through synchronously, so a request that finishes while the panel is
  // unmounted still lands in the store instead of being dropped; mounted
  // instances subscribe for those external updates. Secrets stay in this
  // in-memory map only (never localStorage/sessionStorage) and disappear when
  // the web client itself reloads.
  const panelStore=new Map();
  const panelWatchers=new Set();
  const tabScroll=new Map();
  function storeSet(key,next){
    const prev=panelStore.get(key);
    const value=typeof next==='function'?next(prev):next;
    panelStore.set(key,value);
    for(const watch of panelWatchers)watch(key);
    return value;
  }
  function usePanelState(key,initial,revive){
    const [value,setValue]=useState(()=>{
      if(panelStore.has(key)){
        const cached=panelStore.get(key);
        const revived=typeof revive==='function'?revive(cached):cached;
        // Keep store and view identical: "loading" flags frozen by an unmount
        // must not resurrect through the subscription below.
        if(revived!==cached)panelStore.set(key,revived);
        return revived;
      }
      const fresh=typeof initial==='function'?initial():initial;
      panelStore.set(key,fresh);
      return fresh;
    });
    const mounted=useRef(true);
    useEffect(()=>{
      // React strict mode replays the effect: (re)mark the instance live and
      // pick up writes that happened before the subscription was attached.
      mounted.current=true;
      const watch=changed=>{if(changed===key&&mounted.current)setValue(panelStore.get(key))};
      panelWatchers.add(watch);
      setValue(panelStore.get(key));
      return()=>{mounted.current=false;panelWatchers.delete(watch)};
    },[key]);
    const set=useCallback(next=>{
      const nextValue=storeSet(key,next);
      if(mounted.current)setValue(nextValue);
      return nextValue;
    },[key]);
    return [value,set];
  }
  function Dashboard(){
    const [tab,setTab]=usePanelState('tab','overview');
    const [baseUrl,setBaseUrl]=usePanelState('baseUrl',DEFAULT_URL);
    const [health,setHealth]=usePanelState('health',{loading:true,data:null,error:''},x=>({...x,loading:false}));
    const [refreshTick,setRefreshTick]=useState(0);
    const [pool,setPool]=usePanelState('pool',{loading:false,loaded:false,items:[],error:'',message:''},x=>({...x,loading:false}));
    const [newToken,setNewToken]=usePanelState('newToken','');
    const [credentialText,setCredentialText]=usePanelState('credentialText','');
    const [credentialItems,setCredentialItems]=usePanelState('credentialItems',[]);
    const [credentialBusy,setCredentialBusy]=usePanelState('credentialBusy',false);
    const [credentialFeedback,setCredentialFeedback]=usePanelState('credentialFeedback',null);
    const [credentialError,setCredentialError]=usePanelState('credentialError','');
    const [doing,setDoing]=usePanelState('doing',false);
    const [proxyState,setProxyState]=usePanelState('proxyState',{url:'',draft:'',configured:false,hasCredentials:false,busy:false,error:'',message:'',test:null});
    const [prompt,setPrompt]=usePanelState('prompt',DEFAULT_PROMPT);
    const [imageModels,setImageModels]=usePanelState('imageModels',{items:[],loading:false,error:''});
    const [imagePrefs,setImagePrefs]=usePanelState('imagePrefs',{defaultModel:'gpt-image-2',defaultImageTier:'auto',loaded:false,saving:false,error:'',message:''});
    const [imageModel,setImageModel]=usePanelState('imageModel','gpt-image-2');
    const [imageTier,setImageTier]=usePanelState('imageTier','auto');
    const [animatedGif,setAnimatedGif]=usePanelState('animatedGif',false);
    const [gifFrameCount,setGifFrameCount]=usePanelState('gifFrameCount',9);
    const [gifFrameDuration,setGifFrameDuration]=usePanelState('gifFrameDuration',200);
    const [gifCapability,setGifCapability]=usePanelState('gifCapability',{enabled:false,loaded:false});
    const [imageFiles,setImageFiles]=usePanelState('imageFiles',[]);
    const [imageResult,setImageResult]=usePanelState('imageResult',{loading:false,url:'',error:''});
    const [folderBusy,setFolderBusy]=usePanelState('folderBusy',false);
    const [folderNote,setFolderNote]=usePanelState('folderNote','');
    const [folderInfo,setFolderInfo]=usePanelState('folderInfo',{dir:'',count:0});
    const [frameIndex,setFrameIndex]=useState(0);
    const [userKeys,setUserKeys]=usePanelState('userKeys',[]);
    const [userKeysLoaded,setUserKeysLoaded]=usePanelState('userKeysLoaded',false);
    const [userKeyName,setUserKeyName]=usePanelState('userKeyName','本机应用');
    const [userKeyCustom,setUserKeyCustom]=usePanelState('userKeyCustom','');
    const [userKeyPlain,setUserKeyPlain]=usePanelState('userKeyPlain','');
    const [userKeyBusy,setUserKeyBusy]=usePanelState('userKeyBusy',false);
    const [userKeyError,setUserKeyError]=usePanelState('userKeyError','');
    const [copiedId,setCopiedId]=useState(null);
    const [revealedKeys,setRevealedKeys]=usePanelState('revealedKeys',{});
    const [importJson,setImportJson]=usePanelState('importJson','');
    const [importMessage,setImportMessage]=usePanelState('importMessage','');
    const [cpaDraft,setCpaDraft]=usePanelState('cpaDraft',{name:'',base_url:'',secret_key:''});
    const [cpaPools,setCpaPools]=usePanelState('cpaPools',[]);
    const [cpaPool,setCpaPool]=usePanelState('cpaPool','');
    const [cpaFiles,setCpaFiles]=usePanelState('cpaFiles',[]);
    const [cpaSelection,setCpaSelection]=usePanelState('cpaSelection',[]);
    const [subDraft,setSubDraft]=usePanelState('subDraft',{name:'',base_url:'',api_key:''});
    const [subServers,setSubServers]=usePanelState('subServers',[]);
    const [subServer,setSubServer]=usePanelState('subServer','');
    const [subAccounts,setSubAccounts]=usePanelState('subAccounts',[]);
    const [subSelection,setSubSelection]=usePanelState('subSelection',[]);
    const [advancedBusy,setAdvancedBusy]=usePanelState('advancedBusy',false);
    const [advancedError,setAdvancedError]=usePanelState('advancedError','');
    const [poolsLoaded,setPoolsLoaded]=usePanelState('poolsLoaded',false);
    const mainRef=useRef(null);
    const tabRef=useRef(tab);
    tabRef.current=tab;
    const endpoint=useMemo(()=>urlClean(baseUrl),[baseUrl]);
    const data=health.data,acc=data?.accounts||{};
    const online=!!data&&!health.error;
    const ready=!!data?.healthy;
    function reload(){setHealth(x=>({...x,loading:true,error:''}));setRefreshTick(x=>x+1)}
    function refreshInBackground(){setRefreshTick(x=>x+1)}
    useEffect(()=>{
      // Keep the stylesheet for the whole client session: removing it on every
      // panel switch made the returning page paint unstyled for a frame, which
      // is most of what "the page reloaded" looked like.
      const id='c2a-native-dashboard-css';
      if(document.getElementById(id))return;
      const el=document.createElement('style');el.id=id;el.textContent=STYLES;document.head.appendChild(el);
    },[]);
    useIsoLayoutEffect(()=>{
      const el=mainRef.current;if(!el)return;
      const top=tabScroll.get(tab)||0;
      el.scrollTop=top;
      // Images restored from cache may finish decoding after layout and grow
      // the page; re-apply once so the returning view keeps its position.
      if(top&&typeof requestAnimationFrame==='function'){
        const raf=requestAnimationFrame(()=>{if(el.isConnected)el.scrollTop=top});
        return()=>cancelAnimationFrame(raf);
      }
    },[tab]);
    useEffect(()=>{
      const el=mainRef.current;
      if(!el||typeof el.addEventListener!=='function')return;
      let raf=0;
      const onScroll=()=>{
        if(raf)return;
        const owner=tabRef.current,top=el.scrollTop;
        const remember=()=>{raf=0;tabScroll.set(owner,top)};
        raf=typeof requestAnimationFrame==='function'?requestAnimationFrame(remember):setTimeout(remember,80);
      };
      el.addEventListener('scroll',onScroll,{passive:true});
      return()=>{
        el.removeEventListener('scroll',onScroll);
        if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(raf);else clearTimeout(raf);
      };
    },[]);
    useEffect(()=>{
      let alive=true;
      const load=async()=>{
        try{
          const result=await upstream('/health?format=json',{timeoutMs:9000});
          if(alive){setHealth({loading:false,data:result,error:''});setBaseUrl(result?.baseUrl||DEFAULT_URL)}
        }catch(e){if(alive)setHealth(x=>({...x,loading:false,error:shortError(e)}))}
      };
      load();const timer=setInterval(load,15000);
      return()=>{alive=false;clearInterval(timer)};
    },[refreshTick]);
    async function upstream(path,{method='GET',body,timeoutMs=140000}={}){
      // The DSH Host authenticates this browser session and adds the backend's
      // private admin secret on the Host side. No password is ever requested.
      const controller=new AbortController(),t=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const res=await fetch('/api/chatgpt2api-native/manage',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({path,method,body}),signal:controller.signal
        });
        return parseJsonResponse(res,await res.text());
      }catch(e){if(controller.signal.aborted)throw Error('服务请求超时');throw e}finally{clearTimeout(t)}
    }
    useEffect(()=>{
      // Revalidate in the background when a snapshot already exists, so a
      // returning panel shows its previous content and then updates in place
      // instead of flashing "加载中…" like a fresh page load.
      if(tab==='accounts'){void listAccounts({silent:pool.loaded});void listCredentials();void loadProxy();}
      else if(tab==='settings')void loadProxy();
      else if(tab==='api')void loadUserKeys({silent:userKeysLoaded});
      else if(tab==='advanced')void refreshPools({silent:poolsLoaded});
      else if(tab==='image'){void loadImagesFolder();void loadImagePreferences();void loadImageModels();void loadGifCapability();}
    },[tab]);
    function copyWithFeedback(text, id){
      copyToClipboard(text, ()=>{
        setCopiedId(id);
        setTimeout(()=>setCopiedId(cur=>cur===id?null:cur), 2000);
      });
    }
    function toggleReveal(id){
      setRevealedKeys(prev=>({...prev,[id]:!prev[id]}));
    }
    function mergeUserKeysWithLocal(items){
      const local=getLocalUserKeys();
      const list=Array.isArray(items)?items:[];
      return list.map(item=>{
        const id=String(item.id||'');
        const k=String(item.key||local[id]?.key||'');
        if(item.key&&!local[id]?.key)saveLocalUserKey(id,item.key,item.name);
        return {...item,key:k};
      });
    }
    async function loadUserKeys({silent=false}={}){
      if(!silent)setUserKeyBusy(true);
      setUserKeyError('');
      try{
        const json=await upstream('/api/auth/users',{timeoutMs:15000});
        setUserKeys(mergeUserKeysWithLocal(json?.items));
        setUserKeysLoaded(true);
      }catch(e){setUserKeyError(shortError(e))}finally{if(!silent)setUserKeyBusy(false)}
    }
    function generateRandomApiKey(){
      const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let s='';
      if(globalThis.crypto?.getRandomValues){
        const b=new Uint8Array(28);
        globalThis.crypto.getRandomValues(b);
        for(let i=0;i<28;i++) s+=chars[b[i]%chars.length];
      }else{
        for(let i=0;i<28;i++) s+=chars[Math.floor(Math.random()*chars.length)];
      }
      return 'sk-'+s;
    }
    async function resetUserKey(id, customKey=null){
      let nextKey=(customKey?String(customKey).trim():'');
      if(!nextKey){
        nextKey=generateRandomApiKey();
      }
      setUserKeyBusy(true);setUserKeyError('');
      try{
        const json=await upstream('/api/auth/users/'+encodeURIComponent(String(id)),{
          method:'POST',
          body:{key:nextKey},
          timeoutMs:15000
        });
        saveLocalUserKey(id,nextKey);
        setUserKeyPlain(nextKey);
        const merged=mergeUserKeysWithLocal(json?.items);
        setUserKeys(merged);
        copyWithFeedback(nextKey,'new-key');
      }catch(e){
        setUserKeyError(shortError(e));
      }finally{
        setUserKeyBusy(false);
      }
    }
    async function promptCustomKey(item){
      const currentName=item?.name||'该密钥';
      const input=globalThis.prompt?.(`为「${currentName}」设置自定义 API Key（留空将自动生成随机 sk- 密钥）：`,'');
      if(input===null)return;
      await resetUserKey(item.id, input.trim()||null);
    }
    async function createUserKey(){
      const name=userKeyName.trim()||'本机应用';
      const customKey=userKeyCustom.trim();
      setUserKeyBusy(true);setUserKeyError('');setUserKeyPlain('');
      try{
        const json=await upstream('/api/auth/users',{method:'POST',body:{name},timeoutMs:15000});
        const rawItems=Array.isArray(json.items)?json.items:[];
        const newId=String(json.id||json.item?.id||rawItems.find(x=>x.name===name)?.id||'');
        let finalKey=String(json.key||'');
        if(customKey&&newId){
          const upd=await upstream('/api/auth/users/'+encodeURIComponent(newId),{
            method:'POST',
            body:{key:customKey},
            timeoutMs:15000
          });
          finalKey=customKey;
          saveLocalUserKey(newId,finalKey,name);
          setUserKeys(mergeUserKeysWithLocal(upd?.items));
        }else{
          if(newId&&finalKey){
            saveLocalUserKey(newId,finalKey,name);
          }
          setUserKeys(mergeUserKeysWithLocal(rawItems));
        }
        setUserKeyPlain(finalKey);
        setUserKeyCustom('');
        copyWithFeedback(finalKey,'new-key');
      }catch(e){setUserKeyError(shortError(e))}finally{setUserKeyBusy(false)}
    }
    async function revokeUserKey(id){
      if(!globalThis.confirm?.('确认吊销这个 API Key？使用它的第三方软件会立即无法调用。'))return;
      setUserKeyBusy(true);setUserKeyError('');
      try{
        const json=await upstream('/api/auth/users/'+encodeURIComponent(String(id)),{method:'DELETE',timeoutMs:15000});
        removeLocalUserKey(id);
        const merged=mergeUserKeysWithLocal(json?.items);
        setUserKeys(merged);
        if(userKeyPlain&&!merged.some(x=>x.key===userKeyPlain))setUserKeyPlain('');
      }catch(e){setUserKeyError(shortError(e))}finally{setUserKeyBusy(false)}
    }
    async function importAccountsJson(){
      let body;try{
        const x=JSON.parse(importJson);
        let items=Array.isArray(x)?x:(Array.isArray(x?.accounts)?x.accounts:Array.isArray(x?.items)?x.items:x&&typeof x==='object'?[x]:[]);
        if(!items.length||items.length>100||items.some(item=>!item||typeof item!=='object'||!String(item.access_token||item.accessToken||'').trim()))throw Error('JSON 应包含 1~100 条带 access_token 的账号对象');
        body={accounts:items};
      }catch(e){setAdvancedError('导入 JSON 无效：'+e.message);return}
      setAdvancedBusy(true);setAdvancedError('');setImportMessage('');
      try{const r=await upstream('/api/accounts',{method:'POST',body,timeoutMs:150000});setImportJson('');setImportMessage(`导入成功，新增 ${r?.added??'—'} 个，跳过 ${r?.skipped??'—'} 个。`);await listAccounts()}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function refreshPools({silent=false}={}){
      if(!silent)setAdvancedBusy(true);
      setAdvancedError('');
      try{const [a,b]=await Promise.all([upstream('/api/cpa/pools'),upstream('/api/sub2api/servers')]);setCpaPools(Array.isArray(a?.pools)?a.pools:[]);setSubServers(Array.isArray(b?.servers)?b.servers:[]);setPoolsLoaded(true)}
      catch(e){setAdvancedError(shortError(e))}finally{if(!silent)setAdvancedBusy(false)}
    }
    async function createCpaPool(){
      if(!cpaDraft.base_url||!cpaDraft.secret_key){setAdvancedError('请输入 CPA 服务器地址和密钥');return}
      setAdvancedBusy(true);setAdvancedError('');
      try{const r=await upstream('/api/cpa/pools',{method:'POST',body:cpaDraft});setCpaPools(Array.isArray(r?.pools)?r.pools:[]);setCpaDraft({name:'',base_url:'',secret_key:''});setImportMessage('CPA 连接已保存，请选择连接加载文件。')}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function loadCpaFiles(){if(!cpaPool)return;setAdvancedBusy(true);setAdvancedError('');setCpaFiles([]);setCpaSelection([]);
      try{const r=await upstream('/api/cpa/pools/'+encodeURIComponent(cpaPool)+'/files',{timeoutMs:30000});setCpaFiles(Array.isArray(r?.files)?r.files:[])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function importCpaFiles(){if(!cpaPool||!cpaSelection.length)return;setAdvancedBusy(true);setAdvancedError('');
      try{const r=await upstream('/api/cpa/pools/'+encodeURIComponent(cpaPool)+'/import',{method:'POST',body:{names:cpaSelection},timeoutMs:30000});setImportMessage('CPA 导入任务已提交；请在号池页刷新账号列表。');setCpaSelection([])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function createSubServer(){if(!subDraft.base_url||!subDraft.api_key){setAdvancedError('请输入 sub2api 地址和 API Key');return}
      setAdvancedBusy(true);setAdvancedError('');try{const r=await upstream('/api/sub2api/servers',{method:'POST',body:subDraft});setSubServers(Array.isArray(r?.servers)?r.servers:[]);setSubDraft({name:'',base_url:'',api_key:''});setImportMessage('sub2api 服务器连接已保存。')}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function loadSubAccounts(){if(!subServer)return;setAdvancedBusy(true);setAdvancedError('');setSubAccounts([]);setSubSelection([]);
      try{const r=await upstream('/api/sub2api/servers/'+encodeURIComponent(subServer)+'/accounts',{timeoutMs:30000});setSubAccounts(Array.isArray(r?.accounts)?r.accounts:[])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function importSubAccounts(){if(!subServer||!subSelection.length)return;setAdvancedBusy(true);setAdvancedError('');
      try{await upstream('/api/sub2api/servers/'+encodeURIComponent(subServer)+'/import',{method:'POST',body:{account_ids:subSelection},timeoutMs:30000});setImportMessage('sub2api 导入任务已提交；请在号池页刷新账号列表。');setSubSelection([])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function listAccounts({silent=false}={}){
      if(!silent)setPool(x=>({...x,loading:true,error:''}));
      try{
        const json=await upstream('/api/accounts',{timeoutMs:15000});
        setPool(x=>({...x,loading:false,loaded:true,items:Array.isArray(json.items)?json.items:[],error:'',message:silent?x.message:'已更新账号列表'}));
        if(silent)refreshInBackground();else reload();
      }catch(e){setPool(x=>({...x,loading:false,error:shortError(e)}))}
    }
    async function listCredentials(){
      try{const r=await upstream('/local/credential-vault',{timeoutMs:15000});setCredentialItems(Array.isArray(r?.items)?r.items:[]);setCredentialError('')}
      catch(e){setCredentialError(shortError(e))}
    }
    async function importCredentialLines(){
      if(!credentialText.trim()){setCredentialError('请输入每行一条的账号文本');return}
      if(new TextEncoder().encode(credentialText).length>1024*1024){setCredentialError('单次导入最多 1MB');return}
      setCredentialBusy(true);setCredentialError('');setCredentialFeedback(null);
      try{
        const r=await upstream('/local/credential-vault',{method:'POST',body:{text:credentialText},timeoutMs:40000});
        setCredentialFeedback(r);setCredentialText('');await listCredentials();
      }catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function importAndAuthenticate(){
      if(!credentialText.trim()){setCredentialError('请输入每行一条的账号文本');return}
      if(new TextEncoder().encode(credentialText).length>1024*1024){setCredentialError('单次导入最多 1MB');return}
      setCredentialBusy(true);setCredentialError('');setCredentialFeedback(null);
      try{
        const r=await upstream('/local/credential-vault/authenticate',{method:'POST',body:{text:credentialText},timeoutMs:300000});
        setCredentialFeedback(r);setCredentialText('');
        await Promise.all([listCredentials(),listAccounts()]);
      }catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function authenticateCredential(item){
      if(!item?.id)return;
      setCredentialBusy(true);setCredentialError('');
      try{
        const r=await upstream('/local/credential-vault/authenticate',{method:'POST',body:{id:item.id},timeoutMs:180000});
        setCredentialFeedback(r);
        await Promise.all([listCredentials(),listAccounts()]);
      }catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function authenticateAllCredentials(){
      if(!credentialItems.length)return;
      setCredentialBusy(true);setCredentialError('');setCredentialFeedback(null);
      try{
        const r=await upstream('/local/credential-vault/authenticate',{method:'POST',body:{all:true},timeoutMs:300000});
        setCredentialFeedback(r);
        await Promise.all([listCredentials(),listAccounts()]);
      }catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function deleteCredential(item){
      if(!item?.id)return;
      if(!globalThis.confirm?.(`确认删除 ${item?.email||'该账号'} 的本地加密暂存记录？`))return;
      setCredentialBusy(true);setCredentialError('');
      try{await upstream('/local/credential-vault/'+encodeURIComponent(item.id),{method:'DELETE',timeoutMs:15000});await listCredentials()}
      catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function loadCredentialFile(file){
      if(!file)return;
      if(file.size>1024*1024){setCredentialError('文本文件超过 1MB');return}
      try{setCredentialText(await file.text());setCredentialFeedback(null);setCredentialError('')}
      catch{setCredentialError('文本文件读取失败')}
    }
    async function loadProxy(){
      try{
        const result=await upstream('/local/proxy',{timeoutMs:15000});
        setProxyState(x=>({...x,url:result.url||'',draft:result.url||'',configured:!!result.configured,hasCredentials:!!result.hasCredentials,error:''}));
      }catch(e){setProxyState(x=>({...x,error:'读取代理配置失败：'+shortError(e)}))}
    }
    async function saveProxy(){
      setProxyState(x=>({...x,busy:true,error:'',message:'',test:null}));
      try{
        const result=await upstream('/local/proxy',{method:'POST',body:{url:proxyState.draft.trim()},timeoutMs:20000});
        setProxyState(x=>({...x,busy:false,url:result.url||'',draft:result.url||'',configured:!!result.configured,hasCredentials:false,message:'代理已保存。请点击“全部刷新额度”重新查询账号，代理需保持开启。'}));
      }catch(e){setProxyState(x=>({...x,busy:false,error:shortError(e)}))}
    }
    async function testProxy(){
      setProxyState(x=>({...x,busy:true,error:'',message:'',test:null}));
      try{
        const response=await upstream('/local/proxy/test',{method:'POST',body:{url:proxyState.draft.trim()},timeoutMs:35000});
        setProxyState(x=>({...x,busy:false,test:response?.result||null}));
      }catch(e){setProxyState(x=>({...x,busy:false,error:shortError(e)}))}
    }
    async function waitForQuotaRefresh(progressId){
      if(!/^[0-9a-f-]{36}$/i.test(String(progressId||'')))return null;
      // The upstream refresh endpoint starts a background job; polling avoids
      // reporting a successful refresh while the account still shows old quota.
      for(let i=0;i<30;i++){
        await new Promise(resolve=>setTimeout(resolve,1000));
        let progress;
        try{progress=await upstream('/api/accounts/refresh/progress/'+progressId,{timeoutMs:10000})}
        catch(e){
          // The background job may not yet have created its progress record.
          if(i<4&&/HTTP 404/.test(shortError(e)))continue;
          throw e;
        }
        if(progress?.done)return progress;
        setPool(x=>({...x,message:`正在刷新额度：${progress?.processed||0}/${progress?.total||'?'}…`}));
      }
      return null;
    }
    async function refreshAllAccounts(){
      if(!pool.items.length)return;
      if(typeof globalThis.confirm==='function'&&!globalThis.confirm(`确定刷新全部 ${pool.items.length} 个账号的额度？这会向上游发起网络请求。`))return;
      setDoing(true);setPool(x=>({...x,error:'',message:'正在提交全部账号额度刷新…'}));
      try{
        const job=await upstream('/local/accounts/refresh-all',{method:'POST',timeoutMs:30000});
        const progress=await waitForQuotaRefresh(job?.progress_id);
        await listAccounts();
        setPool(x=>({...x,message:progress?`额度刷新已结束：处理 ${progress.processed}/${progress.total}，查询异常 ${progress.errorCount}。请核对当前额度。`:'刷新任务仍在后台执行，请稍后点击刷新账号列表。'}));
      }catch(e){setPool(x=>({...x,error:shortError(e)}))}finally{setDoing(false)}
    }
    async function addAccount(){
      const token=newToken.trim();if(!token){setPool(x=>({...x,error:'请填写你有权使用的账号 access_token'}));return}
      if(token.length>12000){setPool(x=>({...x,error:'账号凭据长度不合法'}));return}
      setDoing(true);setPool(x=>({...x,error:'',message:'正在导入并验证账号…'}));
      try{const r=await upstream('/api/accounts',{method:'POST',body:{tokens:[token]},timeoutMs:160000});setNewToken('');setPool(x=>({...x,message:`导入完成：新增 ${r?.added??'—'} 个；请刷新查看状态。`}));await listAccounts()}
      catch(e){setPool(x=>({...x,error:shortError(e)}))}finally{setDoing(false)}
    }
    async function deleteAccount(item){
      const t=accountToken(item);if(!t)return;
      const title=String(item?.email||'该账号');
      if(!globalThis.confirm?.(`确认移除 ${title}？这会从号池中删除该账号。`))return;
      setDoing(true);
      try{await upstream('/api/accounts',{method:'DELETE',body:{tokens:[t]},timeoutMs:20000});await listAccounts()}
      catch(e){setPool(x=>({...x,error:shortError(e)}))}finally{setDoing(false)}
    }
    async function refreshAccount(item){
      const t=accountToken(item);if(!t)return;
      setDoing(true);setPool(x=>({...x,error:'',message:'正在检测账号额度…'}));
      try{
        const job=await upstream('/api/accounts/refresh',{method:'POST',body:{access_tokens:[t]},timeoutMs:30000});
        const progress=await waitForQuotaRefresh(job?.progress_id);
        await listAccounts();
        setPool(x=>({...x,message:progress?(progress.errorCount?'额度刷新完成，但上游查询失败；请检查代理和网络。':'额度刷新完成，请核对当前额度。'):'刷新任务仍在后台执行，请稍后刷新账号列表。'}));
      }catch(e){setPool(x=>({...x,error:shortError(e)}))}finally{setDoing(false)}
    }
    async function loadImageModels(){
      setImageModels(x=>({...x,loading:true,error:''}));
      try{
        const r=await upstream('/local/models',{timeoutMs:25000});
        const items=Array.isArray(r.models)?r.models:[];
        setImageModels({items,loading:false,error:items.length?'':'上游没有返回可用模型'});
      }catch(e){setImageModels(x=>({...x,loading:false,error:shortError(e)}))}
    }
    async function loadImagePreferences(){
      try{
        const r=await upstream('/local/image-preferences',{timeoutMs:10000});
        const defaultModel=String(r.defaultModel||'gpt-image-2');
        const defaultImageTier=String(r.defaultImageTier||'auto');
        setImagePrefs(x=>({...x,defaultModel,defaultImageTier,loaded:true,error:''}));
        // Only initialize the drafts from defaults once per page lifetime.
        if(!panelStore.get('imagePrefsInitialized')){
          setImageModel(defaultModel);setImageTier(defaultImageTier);
          panelStore.set('imagePrefsInitialized',true);
        }
      }catch(e){setImagePrefs(x=>({...x,error:'读取图片偏好失败：'+shortError(e)}))}
    }
    async function saveImagePreferences(){
      setImagePrefs(x=>({...x,saving:true,error:'',message:''}));
      try{
        const r=await upstream('/local/image-preferences',{method:'POST',body:{defaultModel:imageModel,defaultImageTier:imageTier},timeoutMs:10000});
        setImagePrefs(x=>({...x,defaultModel:r.defaultModel,defaultImageTier:r.defaultImageTier,saving:false,loaded:true,message:'默认模型和分辨率已保存'}));
      }catch(e){setImagePrefs(x=>({...x,saving:false,error:shortError(e)}))}
    }
    async function loadGifCapability(){
      try{
        const result=await upstream('/local/gif-capabilities',{timeoutMs:10000});
        setGifCapability({enabled:result.enabled===true,loaded:true});
      }catch{setGifCapability({enabled:false,loaded:true})}
    }
    async function generate(){
      const pr=prompt.trim();if(!pr){setImageResult({loading:false,url:'',error:'请输入提示词'});return}
      if(animatedGif&&imageFiles.length){setImageResult({loading:false,url:'',error:'原生 GIF 暂仅支持文生图，请移除参考图片'});return}
      if(animatedGif&&gifCapability.loaded&&!gifCapability.enabled){setImageResult({loading:false,url:'',error:'要使用原生 GIF，需在 DSH Host 配置 DSH_OPENAI_GIF_API_KEY 并重启插件'});return}
      if(animatedGif&&(!Number.isInteger(Number(gifFrameCount))||Number(gifFrameCount)<2||Number(gifFrameCount)>16)){setImageResult({loading:false,url:'',error:'GIF 帧数须为 2–16'});return}
      if(animatedGif&&(!Number.isInteger(Number(gifFrameDuration))||Number(gifFrameDuration)<20||Number(gifFrameDuration)>2000||Number(gifFrameDuration)%10)){setImageResult({loading:false,url:'',error:'每帧时长须为 20–2000 毫秒且为 10 毫秒整数倍'});return}
      if(imageFiles.length>4){setImageResult({loading:false,url:'',error:'最多选择 4 张参考图'});return}
      if(imageFiles.some(x=>x.size>MAX_FILE_SIZE)){setImageResult({loading:false,url:'',error:'每张参考图不得超过 12 MB'});return}
      setImageResult({loading:true,url:'',error:''});
      const requestTimeout=animatedGif?720000:240000;
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),requestTimeout);
      try{
        const images=await Promise.all(imageFiles.map(file=>new Promise((resolve,reject)=>{
          const reader=new FileReader();reader.onerror=()=>reject(Error('图片读取失败'));
          reader.onload=()=>{
            const result=String(reader.result||''),raw=result.split(',')[1]||'';
            if(!raw)return reject(Error('图片为空'));
            resolve({b64_json:raw,mime_type:file.type||'image/png'});
          };
          reader.readAsDataURL(file);
        })));
        const path=images.length?'/v1/images/edits':'/v1/images/generations';
        const result=await upstream(path,{method:'POST',body:{model:imageModel,prompt:pr,n:1,response_format:'b64_json',resolution:imageTier,...(animatedGif?{output_format:'gif',frame_count:Number(gifFrameCount),frame_duration_ms:Number(gifFrameDuration)}:{}),...(images.length?{images}:{})},timeoutMs:requestTimeout});
        const first=result?.data?.[0];const format=animatedGif?'gif':'png';
        const output=first?.b64_json?'data:image/'+format+';base64,'+first.b64_json:first?.url||'';
        if(!output)throw Error('生成服务未返回图片');
        setImageResult({loading:false,url:output,error:'',format});reload();
      }catch(e){setImageResult({loading:false,url:'',error:ctrl.signal.aborted?'生成等待超时':imageFailureText(shortError(e))})}
      finally{clearTimeout(timer)}
    }
    async function loadImagesFolder(){
      try{
        const r=await upstream('/local/open-images-dir',{method:'GET',timeoutMs:10000});
        setFolderInfo({dir:String(r?.dir||''),count:Number(r?.count||0)});
      }catch{/* Host older than this panel: the path stays hidden until a restart. */}
    }
    async function openImagesFolder(){
      setFolderBusy(true);setFolderNote('');
      try{
        const r=await upstream('/local/open-images-dir',{method:'POST',timeoutMs:15000});
        setFolderInfo({dir:String(r?.dir||''),count:Number(r?.count||0)});
        setFolderNote(r?.opened
          ?`已请求在文件管理器中打开（当前 ${Number(r?.count)||0} 张图片）。如果没看到窗口，可能被当前窗口挡住或在任务栏；也可以直接复制下面的地址打开。`
          :`无法自动打开：${r?.error||'系统没有可用的文件管理器'}。请复制下面的地址，在资源管理器/访达中粘贴打开。`);
      }catch(e){
        const raw=shortError(e);
        setFolderNote(/未授权|404/.test(raw)
          ?'当前 DSH 仍在运行旧版插件 Host，重启 DSH 后即可显示目录地址。'
          :'打开失败：'+raw);
      }finally{setFolderBusy(false)}
    }
    const notes=[['当前账号',acc.total,'◉'],['可用账号',acc.active,'✓'],['限流账号',acc.limited,'◷'],['剩余额度',acc.total_quota,'▦'],['成功调用',acc.total_success,'↗'],['失败调用',acc.total_fail,'!']];
    return h('div',{className:'c2a-root'},
      h('header',{className:'c2a-header'},
        h('div',{className:'c2a-brand'},h('span',{className:'c2a-logo'},'◉'),h('div',null,h('strong',null,'ChatGPT2API · 号池'),h('small',null,'跨平台 本地号池 · 通用 OpenAI 兼容接口'))),
        h('div',{className:'c2a-headright'},h(Chip,{kind:online?(ready?'success':'warning'):'danger'},online?(ready?'号池运行中':'暂无可用账号'):'后端未就绪'),h('span',{className:'c2a-version'},online?'v'+(data.version||'—'):'插件 v0.6.0'),h(Btn,{onClick:reload,disabled:health.loading},health.loading?'检测中…':'刷新'))
      ),
      h('nav',{className:'c2a-tabbar','aria-label':'号池功能'},...PAGES.map(([id,label,icon])=>h('button',{key:id,type:'button',className:'c2a-tab'+(tab===id?' selected':''),onClick:()=>setTab(id)},h('span',{className:'c2a-tabicon'},icon),label))),
      h('main',{className:'c2a-main',ref:mainRef},
        tab==='overview'?h(React.Fragment,null,
          h('section',{className:'c2a-hero'},
            h('div',null,h('div',{className:'c2a-kicker'},h('span',{className:'c2a-dot '+(ready?'on':'')},'●'),'跨平台 内置 Python 运行时 / 独立 API 服务'),
              h('h1',null,online?'本机号池 API 已就绪':'首次启动正在安装 Python 后端，或服务尚未就绪'),
              h('p',null,online?'为 DSH 其他插件和本机第三方客户端提供独立的 OpenAI 兼容接口。':'无需 Docker 或单独安装 Python。首次使用会联网下载固定版本的运行环境及后端源码。'),
              h('div',{className:'c2a-hero-actions'},h(Btn,{primary:true,onClick:()=>setTab('accounts')},'进入号池管理（账号导入） →'),h(Btn,{onClick:()=>setTab('image')},'测试单张生图'))
            ),h('div',{className:'c2a-hero-art'},h('span',{className:'c2a-orbit one'},''),h('span',{className:'c2a-orbit two'},''),h('span',{className:'c2a-hero-glyph'},'✦'))
          ),
          health.error?h('div',{className:'c2a-alert'},h('b',null,'当前连接问题：'),health.error,'。首次初始化需要联网下载 Python 和依赖，请检查 DSH 日志；也可以运行插件自检命令。'):null,
          h('section',{className:'c2a-stats'},...notes.map(([name,num,ic],i)=>h('article',{className:'c2a-stat',key:name},h('div',{className:'c2a-stat-heading'},name,h('span',null,ic)),h('strong',null,online?number(num):'—'),h('span',{className:'c2a-stat-note'},i===1?'健康接口的可用账户数':'从后端状态接口读取')))),
          h('div',{className:'c2a-info',style:{margin:'18px 0 0',display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:'12px',background:'linear-gradient(135deg,#f0f7ff 0%,#e7f2ff 100%)',border:'1px solid #c2dcff',borderRadius:'12px',padding:'14px 18px'}},
            h('div',{style:{display:'flex',alignItems:'center',gap:'10px'}},
              h('span',{style:{fontSize:'22px'}},'💡'),
              h('div',null,
                h('strong',{style:{display:'block',color:'#193f7b',fontSize:'13px',marginBottom:'2px'}},'低成本号池扩容建议'),
                h('span',{style:{color:'#385680',fontSize:'12px'}},
                  '无需高价号，可以上 ',
                  h('a',{href:'https://priceai.cc/',target:'_blank',rel:'noopener noreferrer',style:{color:'#2459e1',fontWeight:'600',textDecoration:'underline'}},'https://priceai.cc/'),
                  ' 买几分钱的普号（一般 5 毛钱可以买 10 个）。购买后复制提取文本，在「号池管理」直接按「邮箱---密码---2FA」或「邮箱----密码----2FA」一键授权入池。'
                )
              )
            ),
            h(Btn,{primary:true,onClick:()=>setTab('accounts')},'前往账号导入（支持 TXT/邮箱格式） →')
          ),
          h('div',{className:'c2a-columns'},
            h(Card,{title:'快捷操作'},h('div',{className:'c2a-quick'},...[["accounts","账号池与导入","批量导入邮箱/TXT文件、管理 Token 账号","◉"],["api","API 接入","第三方客户端连接、独立调用密钥","⇄"],["image","图片生成","文生图或最多四张参考图","▧"],["advanced","高级账号导入","JSON / CPA / sub2api","⚙"],["settings","插件运行设置","环境检查、运行时排障","≡"]].map(([id,n,desc,icon])=>h('button',{key:id,type:'button',className:'c2a-quicklink',onClick:()=>setTab(id)},h('span',{className:'c2a-quickicon'},icon),h('span',null,h('strong',null,n),h('small',null,desc)),h('span',{className:'c2a-arrow'},'›'))))),
            h(Card,{title:'集成说明'},h('div',{className:'c2a-checks'},
              h('div',null,h('span',null,'插件内置 Python 后端'),h(Chip,{kind:online?'success':'warning'},online?'已连接':'未连接')),
              h('div',null,h('span',null,'DSH Host 服务名称'),h('code',null,'ctx.chatgpt2api')),
              h('div',null,h('span',null,'号池数据'),h(Chip,null,'保存在 DSH 用户目录')),
              h('div',null,h('span',null,'第三方兼容 API'),h(Chip,{kind:online?'success':'warning'},'/v1 / Bearer Key'))
            ),h('p',{className:'c2a-help'},'支持 DSH Host 服务与本机 HTTP API。接口兼容范围以 chatgpt2api 实际实现为准；逆向服务可能随上游变化而失效。'))
          )
        ):
        tab==='accounts'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'账号池管理'),h('p',null,'已通过 DSH 本机登录会话自动授权，不需要单独输入管理密码。')),h(Btn,{onClick:()=>{void listAccounts();void listCredentials()},disabled:pool.loading},pool.loading?'加载中…':'刷新账号列表')),
          pool.loaded&&pool.items.length>0&&pool.items.every(a=>Number(a?.quota??a?.image_quota??0)===0)?
            h(Card,{title:'账号已导入，但剩余额度一直为 0'},
              h('p',{className:'c2a-help'},'这不一定是账号无额度：登录走 auth.openai.com，而额度/生图请求走 chatgpt.com，后者可能未走代理而查询失败。请在下方测试并保存代理，然后点击“全部刷新额度”；也可以复制说明交给 DeepSeek 排查。'),
              h(Btn,{onClick:()=>copyWithFeedback(ZERO_QUOTA_PROMPT,'zero-quota'),primary:true},copiedId==='zero-quota'?'✓ 已复制排查说明':'复制给 DeepSeek 的排查说明')
            ):null,
          h(Card,{title:'代理与额度排障'},
            h('p',{className:'c2a-help'},'如果导入成功却显示额度 0，优先确认 chatgpt.com 能通过代理访问；仅登录成功不等于额度查询成功。请填写你本机实际使用的代理地址，常见端口有 7890、7897、10809（不是统一固定值）。'),
            h('div',{className:'c2a-formrow'},
              h('input',{value:proxyState.draft,placeholder:'例如 http://127.0.0.1:7897','aria-label':'号池全局代理地址',autoComplete:'off',onChange:e=>setProxyState(x=>({...x,draft:e.target.value,test:null}))}),
              h(Btn,{onClick:testProxy,disabled:proxyState.busy},proxyState.busy?'处理中…':'测试代理连通性'),
              h(Btn,{onClick:saveProxy,disabled:proxyState.busy,primary:true},'保存全局代理'),
              h(Btn,{onClick:loadProxy,disabled:proxyState.busy},'读取配置')
            ),
            h('p',{className:'c2a-help'},proxyState.hasCredentials?'当前代理含认证信息，界面不会显示；如需修改，请输入新的无账号密码代理地址。':proxyState.configured?'当前已配置全局代理。可先测试，再刷新额度。':'当前未配置全局代理；不需要代理的网络可保持为空。'),
            proxyState.test?h('p',{className:proxyState.test.ok?'c2a-info':'c2a-alert'},proxyState.test.ok?`代理测试通过：HTTP ${proxyState.test.status}，${proxyState.test.latency_ms} ms（仅代表网络连通，不保证额度）`:`代理测试未通过：${proxyState.test.error||'连接失败'}`):null,
            proxyState.error?h('p',{className:'c2a-alert'},proxyState.error):null,
            proxyState.message?h('p',{className:'c2a-info'},proxyState.message):null,
            h('div',{className:'c2a-formrow'},
              h(Btn,{onClick:refreshAllAccounts,disabled:doing||!pool.items.length},doing?'正在刷新…':'全部刷新额度'),
              h(Btn,{onClick:()=>copyWithFeedback(ZERO_QUOTA_PROMPT,'zero-quota'),disabled:doing},copiedId==='zero-quota'?'✓ 已复制':'复制排查说明给 DeepSeek')
            ),
            h('p',{className:'c2a-help'},'不会伪造或手工修改额度；刷新后仍为 0 时，请排查代理规则、账号权限及上游服务。代理软件必须持续运行。')
          ),
          h(Card,{title:'本机管理已启用'},
            h('div',{className:'c2a-formrow'},h(Chip,{kind:'success'},'无需管理员密码'),
              h('p',{className:'c2a-help'},'本页面使用 DSH 已登录的浏览器会话。号池内部认证凭据仅由插件 Host 保管，不发送到网页。'))
          ),
          pool.error?h('div',{className:'c2a-alert'},pool.error):null,
          pool.message?h('div',{className:'c2a-info'},pool.message):null,
          h(React.Fragment,null,
            h(Card,{title:'导入一个账号'},
              h('div',{className:'c2a-formrow'},h('input',{type:'password',value:newToken,placeholder:'粘贴你有权使用的 access_token','aria-label':'账号 access_token',autoComplete:'off',onChange:e=>setNewToken(e.target.value)}),h(Btn,{primary:true,onClick:addAccount,disabled:doing},doing?'处理中…':'导入并检测')),
              h('p',{className:'c2a-help'},'单账号导入后由上游服务完成有效性检查；CPA、sub2api 等复杂导入请使用「高级导入」页面。')
            ),
            h(Card,{title:'邮箱 / 密码 / 第三字段批量导入（每行一条）'},
              h('div',{className:'c2a-info',style:{margin:'0 0 12px 0',lineHeight:'1.6'}},
                '💡 提示：可以上 ',
                h('a',{href:'https://priceai.cc/',target:'_blank',rel:'noopener noreferrer',style:{color:'#2257d4',fontWeight:'600',textDecoration:'underline'}},'https://priceai.cc/'),
                ' 买几分钱的普号（一般 5 毛钱可以买 10 个）。购买提取后直接粘贴在下方文本框，点击「导入并授权入池」即可。'
              ),
              h('div',{className:'c2a-format-guide',style:{background:'#f8fafd',border:'1px solid #dbe6f5',borderRadius:'10px',padding:'13px 16px',margin:'10px 0 14px',fontSize:'12px',lineHeight:'1.6'}},
                h('div',{style:{fontWeight:'700',color:'#1e3a68',marginBottom:'6px'}},
                  '📋 支持导入的账号格式规范（每行一条，分隔符支持 ---- 或 ---）：'
                ),
                h('div',{style:{display:'grid',gap:'8px',color:'#3d5375'}},
                  h('div',null,
                    h('span',{style:{background:'#e6efff',color:'#1c4bb5',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'格式 1 标准三字段'),
                    h('code',{style:{background:'#edf2f9',padding:'2px 5px',borderRadius:'4px',fontFamily:'monospace'}},'邮箱----密码----2FA密钥'),
                    h('span',{style:{color:'#6b7c96',marginLeft:'8px'}},'（自动通过 OAuth + TOTP 登录换取 Token 加入号池）')
                  ),
                  h('div',null,
                    h('span',{style:{background:'#e6efff',color:'#1c4bb5',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'格式 2 卡密带邮箱链接'),
                    h('code',{style:{background:'#edf2f9',padding:'2px 5px',borderRadius:'4px',fontFamily:'monospace'}},'邮箱----密码----2FA密钥----https://mail.xxx.store/...'),
                    h('span',{style:{color:'#6b7c96',marginLeft:'8px'}},'（第四字段为网页邮箱/接码链接，系统自动识别并使用前三项自动登录）')
                  ),
                  h('div',null,
                    h('span',{style:{background:'#e6efff',color:'#1c4bb5',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'格式 3 带已生成 Token'),
                    h('code',{style:{background:'#edf2f9',padding:'2px 5px',borderRadius:'4px',fontFamily:'monospace'}},'邮箱----密码----2FA密钥----eyJhbGci...'),
                    h('span',{style:{color:'#6b7c96',marginLeft:'8px'}},'（第四字段为有效 access_token 时优先直接复用入池，过期会自动重新登录）')
                  ),
                  h('div',null,
                    h('span',{style:{background:'#f0f3f8',color:'#55657d',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'文本文件导入'),
                    '点击下方「选择账号文本文件（.txt）」可直接选择包含上述格式的本地 txt 文件，自动加载入框。'
                  )
                )
              ),
              h('div',{style:{margin:'10px 0 8px'}},
                h('label',{style:{display:'block',fontWeight:'600',fontSize:'12px',color:'#385680',marginBottom:'5px'}},'📁 选择账号文本文件（.txt）：'),
                h('input',{type:'file',accept:'.txt,text/plain', 'aria-label':'导入账号文本文件',onChange:e=>{void loadCredentialFile(e.target.files?.[0]);e.target.value=''}})
              ),
              h('textarea',{className:'c2a-textarea',value:credentialText,onChange:e=>{setCredentialText(e.target.value);setCredentialFeedback(null)},placeholder:'yarrow.89.commons@icloud.com----@8PL3X4nXpXTmeN%----T7MXFNYRY5JZZYL2NNGGRLV6KTO3CQYX----https://mail.bsf94666.store/...\nsecond@example.com----your-password----2fa-secret',rows:5,spellCheck:false,autoComplete:'off','aria-label':'一行一条账号凭据文本'}),
              h('div',{className:'c2a-formrow'},
                h(Btn,{primary:true,onClick:importAndAuthenticate,disabled:credentialBusy||!credentialText.trim()},credentialBusy?'正在登录并换取 Token…':'导入并授权入池'),
                h(Btn,{onClick:importCredentialLines,disabled:credentialBusy||!credentialText.trim()},'仅加密暂存'),
                h(Btn,{onClick:()=>{setCredentialText('');setCredentialFeedback(null);setCredentialError('')}},'清空输入'),
                h(Btn,{onClick:()=>{void listCredentials();void listAccounts()},disabled:credentialBusy},'刷新列表')
              ),
              credentialError?h('div',{className:'c2a-alert'},credentialError):null,
              credentialFeedback?h('div',{className:'c2a-info'},
                credentialFeedback.succeeded!==undefined?
                  (
                    credentialFeedback.total > 0 && credentialFeedback.succeeded === 0 && credentialFeedback.failed === 0 && ((credentialFeedback.poolSkipped||0) + (credentialFeedback.enrolled?.skipped||0) + (credentialFeedback.duplicates||0)) ?
                      `全部账号（共 ${credentialFeedback.total} 个）均已在号池中（状态正常）或已重复，已自动跳过，无需重复导入。`:
                      `完成：成功授权并入池 ${credentialFeedback.succeeded||0} 个账号（新增 ${credentialFeedback.enrolled?.added||0}，刷新 ${credentialFeedback.enrolled?.refreshed||0}${((credentialFeedback.poolSkipped||0)+(credentialFeedback.enrolled?.skipped||0)+(credentialFeedback.duplicates||0)) ? `，重复跳过 ${(credentialFeedback.poolSkipped||0)+(credentialFeedback.enrolled?.skipped||0)+(credentialFeedback.duplicates||0)}` : ''}）；失败 ${credentialFeedback.failed||0} 个。`
                  ):
                  `加密暂存 ${credentialFeedback.added||0} 条；重复跳过 ${credentialFeedback.skipped||0} 条；格式错误 ${credentialFeedback.invalid||0} 行。`,
                Array.isArray(credentialFeedback.errors)&&credentialFeedback.errors.length?h('ul',null,...credentialFeedback.errors.map((x,i)=>h('li',{key:i},`第 ${x.line} 行：${x.reason}`))):null,
                Array.isArray(credentialFeedback.failures)&&credentialFeedback.failures.length?h('ul',null,...credentialFeedback.failures.map((x,i)=>h('li',{key:i},`${x.email}：${x.error}`))):null
              ):null,
              h('div',{className:'c2a-sectiontitle',style:{marginTop:'1rem'}},
                h('h4',null,`本地待授权记录（${credentialItems.length}）`),
                credentialItems.length?h(Btn,{disabled:credentialBusy,onClick:authenticateAllCredentials},credentialBusy?'处理中…':'全部授权入池'):null
              ),
              credentialItems.length?h('div',{className:'c2a-tablewrap'},h('table',{className:'c2a-table'},
                h('thead',null,h('tr',null,...['邮箱','状态','操作'].map(x=>h('th',{key:x},x)))),
                h('tbody',null,...credentialItems.slice(0,300).map(x=>h('tr',{key:x.id},
                  h('td',null,h('strong',null,String(x.email||'—')),x.lastError?h('small',{style:{display:'block',color:'var(--c2a-danger)'}},x.lastError):null),
                  h('td',null,h(Chip,{kind:x.state==='auth_failed'?'danger':'warning'},x.state==='auth_failed'?'授权失败':'待授权')),
                  h('td',null,h('div',{className:'c2a-rowactions'},
                    h(Btn,{disabled:credentialBusy,onClick:()=>authenticateCredential(x)},'授权入池'),
                    h(Btn,{danger:true,disabled:credentialBusy,onClick:()=>deleteCredential(x)},'删除')
                  ))
                ))))):h('p',{className:'c2a-help'},'没有待授权记录。成功授权的账号已自动进入上方「可用 Token 号池」。密码及第三字段不会在页面中回显。')
            ),
            h(Card,{title:`可用 Token 号池（${pool.items.length}）`},
              pool.items.length?h('div',{className:'c2a-tablewrap'},h('table',{className:'c2a-table'},h('thead',null,h('tr',null,...['账号','类型','状态','剩余额度','操作'].map(t=>h('th',{key:t},t)))),h('tbody',null,...pool.items.slice(0,300).map((a,i)=>h('tr',{key:accountToken(a)||i},
                h('td',null,h('strong',null,String(a?.email||a?.name||('账号 '+(i+1)))),h('small',null,maskToken(accountToken(a)))),
                h('td',null,String(a?.type||a?.plan||'—')),
                h('td',null,h(Chip,{kind:['normal','active','ok'].includes(String(a?.status||'').toLowerCase())?'success':'neutral'},String(a?.status||'—'))),
                h('td',null,number(a?.quota??a?.image_quota),Number(a?.quota??a?.image_quota??0)===0?h('small',null,a?.quota_check_failed?'最近查询失败':'请核对网络/额度'):null),
                h('td',null,h('div',{className:'c2a-rowactions'},h(Btn,{onClick:()=>refreshAccount(a),disabled:doing},'检测'),h(Btn,{onClick:()=>deleteAccount(a),danger:true,disabled:doing},'删除')))
              ))))):h('div',{className:'c2a-emptymini'},'暂无账号，或尚未刷新列表。')
            )
          )
        ):
        tab==='api'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'通用 API 接入'),h('p',null,'任何受支持的 DSH Host 插件和本机 OpenAI 兼容客户端都可以连接本服务；无需安装其他桥接工具。'))),
          h(Card,{title:'第三方软件连接参数'},
            h('p',{className:'c2a-help'},'推荐只连接本机软件。远程机器需要自行配置认证、HTTPS 反向代理和访问限制。'),
            h('label',{className:'c2a-fieldlabel'},'OpenAI 兼容 API Base URL'),
            h('div',{style:{display:'flex',gap:'8px',alignItems:'center'}},
              h('pre',{className:'c2a-code',style:{flex:1,margin:0}},endpoint?endpoint+'/v1':'http://127.0.0.1:38650/v1'),
              h(Btn,{
                cls:copiedId==='base-url'?'copied':'',
                onClick:()=>copyWithFeedback(endpoint?endpoint+'/v1':'http://127.0.0.1:38650/v1','base-url')
              },copiedId==='base-url'?'✓ 已复制':'复制 URL')
            ),
            h('label',{className:'c2a-fieldlabel'},'认证方式'),
            h('pre',{className:'c2a-code'},'Authorization: Bearer <你创建的用户 API Key>'),
            h('label',{className:'c2a-fieldlabel'},'可用接口'),
            h('pre',{className:'c2a-code'},'GET /v1/models\nPOST /v1/chat/completions\nPOST /v1/responses\nPOST /v1/images/generations\nPOST /v1/images/edits'),
            h('p',{className:'c2a-help'},'可在 Cherry Studio 等软件中将接口地址设为上述 Base URL，填入下方创建的用户密钥；具体兼容性依模型与客户端而定。')
          ),
          h(Card,{title:'创建第三方调用 API Key'},
            h('div',{className:'c2a-formrow'},
              h('input',{value:userKeyName,'aria-label':'新 API Key 名称',onChange:e=>setUserKeyName(e.target.value),placeholder:'名称，例如：Cherry Studio'}),
              h('input',{value:userKeyCustom,'aria-label':'自定义密钥（可选）',onChange:e=>setUserKeyCustom(e.target.value),placeholder:'自定义密钥（可选，留空自动生成）'}),
              h(Btn,{primary:true,onClick:createUserKey,disabled:userKeyBusy},userKeyBusy?'处理中…':'生成用户密钥'),
              h(Btn,{onClick:loadUserKeys,disabled:userKeyBusy},'刷新密钥列表')
            ),
            userKeyError?h('div',{className:'c2a-alert'},userKeyError):null,
            userKeyPlain?h('div',{className:'c2a-newkey-card'},
              h('div',{className:'c2a-newkey-title'},
                h('span',{style:{fontSize:'16px'}},'🔑'),
                h('span',null,'新 API Key 生成成功！')
              ),
              h('p',{style:{margin:'0 0 6px 0',fontSize:'12px',color:'#3b5883'}},'已自动同步保存在本机密钥库，并在下方表格常驻展示。您可点击直接复制或全选文本：'),
              h('input',{
                type:'text',
                readOnly:true,
                value:userKeyPlain,
                className:'c2a-newkey-input',
                onClick:e=>e.target.select(),
                title:'点击可全选密钥'
              }),
              h('div',{className:'c2a-newkey-actions'},
                h(Btn,{
                  primary:copiedId!=='new-key',
                  cls:copiedId==='new-key'?'copied':'',
                  onClick:()=>copyWithFeedback(userKeyPlain,'new-key')
                },copiedId==='new-key'?'✓ 已复制到剪贴板':'复制完整密钥'),
                h(Btn,{
                  cls:copiedId==='new-key-bearer'?'copied':'',
                  onClick:()=>copyWithFeedback(`Bearer ${userKeyPlain}`,'new-key-bearer')
                },copiedId==='new-key-bearer'?'✓ 已复制 Bearer':'复制 Bearer 标头'),
                h(Btn,{onClick:()=>setUserKeyPlain('')},'关闭提示')
              )
            ):null,
            userKeys.length?h('div',{className:'c2a-tablewrap'},h('table',{className:'c2a-table'},
              h('thead',null,h('tr',null,...['名称','API Key (密钥)','创建时间','状态','操作'].map(x=>h('th',{key:x},x)))),
              h('tbody',null,...userKeys.map((x,i)=>{
                const id=String(x?.id||i);
                const keyStr=String(x?.key||'');
                const hasKey=Boolean(keyStr);
                const isRevealed=Boolean(revealedKeys[id]);
                const display=hasKey?(isRevealed?keyStr:(keyStr.length>12?keyStr.slice(0,6)+'••••••••'+keyStr.slice(-4):'••••••••')):'sk-•••••••• (历史哈希)';
                const isCopied=copiedId===id;
                return h('tr',{key:id},
                  h('td',null,
                    h('strong',null,String(x?.name||'用户密钥')),
                    x?.id?h('small',null,'ID: '+x.id):null
                  ),
                  h('td',null,
                    hasKey?h('div',{className:'c2a-key-cell'},
                      h('code',{className:'c2a-key-code',title:isRevealed?'点击隐藏':'点击显示完整明文'},display),
                      h(Btn,{
                        style:{padding:'3px 8px',fontSize:'11px'},
                        onClick:()=>toggleReveal(id)
                      },isRevealed?'隐藏':'显示'),
                      h(Btn,{
                        cls:isCopied?'copied':'',
                        style:{padding:'3px 8px',fontSize:'11px'},
                        onClick:()=>copyWithFeedback(keyStr,id)
                      },isCopied?'✓ 已复制':'复制'),
                      h(Btn,{
                        style:{padding:'3px 8px',fontSize:'11px'},
                        disabled:userKeyBusy,
                        onClick:()=>resetUserKey(id),
                        title:'重新生成随机密钥'
                      },'重置')
                    ):h('div',{className:'c2a-key-cell',style:{gap:'6px'}},
                      h('code',{className:'c2a-key-code',style:{color:'#9a5b13',background:'#fff7eb'},title:'历史旧版本仅存储了不可逆哈希。点击右侧按钮立即生成新明文并复制！'},display),
                      h(Btn,{
                        primary:true,
                        cls:isCopied?'copied':'',
                        style:{padding:'3px 10px',fontSize:'11px',fontWeight:'600'},
                        disabled:userKeyBusy,
                        onClick:()=>resetUserKey(id),
                        title:'立即为此历史条目重新生成新密钥并直接复制'
                      },isCopied?'✓ 已复制新密钥':'🎲 重新生成并复制'),
                      h(Btn,{
                        style:{padding:'3px 8px',fontSize:'11px'},
                        disabled:userKeyBusy,
                        onClick:()=>promptCustomKey(x),
                        title:'手动设置自定义密钥或填回已知密钥'
                      },'✏️ 设置密钥')
                    )
                  ),
                  h('td',null,h('span',{style:{fontSize:'11px',color:'var(--muted)'}},formatKeyDate(x?.created_at))),
                  h('td',null,h(Chip,{kind:x?.enabled===false?'warning':'success'},x?.enabled===false?'已禁用':'可用')),
                  h('td',null,
                    h('div',{className:'c2a-rowactions'},
                      h(Btn,{danger:true,disabled:userKeyBusy,onClick:()=>revokeUserKey(x?.id)},'吊销')
                    )
                  )
                );
              }))
            )):h('p',{className:'c2a-help'},'尚未创建第三方 API Key。管理页面本身不需要密钥。')
          ),
          h(Card,{title:'DSH 插件内部服务'},h('pre',{className:'c2a-code'},'ctx.chatgpt2api.models()\nctx.chatgpt2api.chatCompletion({...})\nctx.chatgpt2api.createResponse({...})\nctx.chatgpt2api.generateImage({...})'),
            h('p',{className:'c2a-help'},'供其他 DSH Host 插件通过依赖注入调用；第三方客户端使用独立 API Key。'))
        ):
        tab==='image'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'图片生成'),h('p',null,'调用当前插件托管的生图服务，一次生成一张图。'))),
          h('div',{className:'c2a-columns'},
            h(Card,{title:'创建生图任务'},
              h('label',{className:'c2a-fieldlabel'},'提示词'),
              h('textarea',{className:'c2a-textarea',value:prompt,onChange:e=>setPrompt(e.target.value),rows:5,'aria-label':'提示词'}),
              h('p',{className:'c2a-help'},'提示：真实人物写真、性感或身体特写类描述容易被上游安全策略拒绝并返回 400；插画、水彩、景物或虚构角色更稳定。'),
              h('label',{className:'c2a-fieldlabel'},'生成模型'),
              h('div',{className:'c2a-formrow'},
                h('select',{className:'c2a-input',value:imageModel,'aria-label':'生成模型',onChange:e=>setImageModel(e.target.value)},
                  ...[...new Set([imageModel,...imageModels.items])].filter(Boolean).map(x=>h('option',{key:x,value:x},x))),
                h(Btn,{onClick:loadImageModels,disabled:imageModels.loading},imageModels.loading?'刷新中…':'刷新模型')
              ),
              imageModels.error?h('p',{className:'c2a-help'},'模型列表：'+imageModels.error):null,
              h('label',{className:'c2a-fieldlabel'},'分辨率档位'),
              h('div',{className:'c2a-formrow'},
                h('select',{className:'c2a-input',value:imageTier,'aria-label':'分辨率档位',onChange:e=>setImageTier(e.target.value)},
                  ...[['auto','自动'],['1k','1K'],['2k','2K'],['4k','4K']].map(([value,label])=>h('option',{key:value,value},label))),
                h(Btn,{onClick:saveImagePreferences,disabled:imagePrefs.saving},imagePrefs.saving?'保存中…':'保存为默认')
              ),
              h('p',{className:'c2a-help'},'不保存图片比例。提示词中明确写出 16:9、9:16、1:1 等比例后，插件会结合当前档位生成目标尺寸；未指定比例时使用后端自动尺寸。上游模型可能不支持某些高分辨率组合。'),
              imagePrefs.error?h('p',{className:'c2a-alert'},imagePrefs.error):null,
              imagePrefs.message?h('p',{className:'c2a-info'},imagePrefs.message):null,
              h('label',{className:'c2a-fieldlabel'},'动图 GIF'),
              h('div',{className:'c2a-formrow'},
                h('label',null,h('input',{type:'checkbox',checked:animatedGif,'aria-label':'动图 GIF',onChange:e=>setAnimatedGif(e.target.checked)}),'生成 GIF 动画（原生接口）')
              ),
              animatedGif?h(React.Fragment,null,
                h('p',{className:'c2a-help'},gifCapability.enabled?'GIF 将通过单独配置的 OpenAI 官方 API 生成，普通图片仍走本地号池。':'当前 GIF 通道未配置：在 DSH Host 环境中设置 DSH_OPENAI_GIF_API_KEY 后重启。普通静态生图无需此密钥。'),
                h('div',{className:'c2a-formrow'},
                  h('label',{className:'c2a-fieldlabel'},'帧数（2–16）'),
                  h('input',{type:'number',min:2,max:16,step:1,value:gifFrameCount,'aria-label':'GIF 帧数',onChange:e=>setGifFrameCount(e.target.value)}),
                  h('label',{className:'c2a-fieldlabel'},'每帧时长（毫秒）'),
                  h('input',{type:'number',min:20,max:2000,step:10,value:gifFrameDuration,'aria-label':'GIF 每帧时长',onChange:e=>setGifFrameDuration(e.target.value)})
                )
              ):null,
              h('label',{className:'c2a-fieldlabel'},'参考图片（最多 4 张，可不选）'),
              h('input',{type:'file',accept:'image/png,image/jpeg,image/webp',multiple:true,'aria-label':'参考图片',onChange:e=>setImageFiles(Array.from(e.target.files||[]).slice(0,5))}),
              h('p',{className:'c2a-help'},imageFiles.length?'已选择 '+imageFiles.length+' 张参考图；每张最大 12MB。':'不选择图片则走文生图；选择参考图则走图片编辑接口。'),
              h('div',{className:'c2a-formrow'},
                h(Btn,{primary:true,onClick:generate,disabled:imageResult.loading},imageResult.loading?(animatedGif?'正在生成 GIF…':'正在生图，请勿关闭页面…'):(animatedGif?'生成 GIF 动画':'生成一张图片')),
                h(Btn,{onClick:openImagesFolder,disabled:folderBusy,title:'在本机文件管理器中打开后端按日期保存历史图片的目录'},folderBusy?'正在打开…':'打开历史图片文件夹')
              ),
              folderNote?h('p',{className:'c2a-help'},folderNote):null,
              folderInfo.dir?h('div',{className:'c2a-formrow',style:{alignItems:'stretch'}},
                h('code',{className:'c2a-code',style:{flex:1,minWidth:0,margin:0,padding:'10px 12px',fontSize:'11px',whiteSpace:'pre-wrap',wordBreak:'break-all'}},folderInfo.dir),
                h(Btn,{cls:copiedId==='folder-path'?'copied':'',onClick:()=>copyWithFeedback(folderInfo.dir,'folder-path'),title:'复制完整文件夹地址'},copiedId==='folder-path'?'✓ 已复制':'复制地址')
              ):null,
              h('p',{className:'c2a-help'},'成功后图片会自动按 年/月/日 保存在本机后端数据目录；如果系统没有弹出文件管理器，直接复制上面的地址粘贴到资源管理器/访达即可。')
            ),
            h(Card,{title:'生成结果'},
              imageResult.error?h('div',{className:'c2a-alert'},imageResult.error):null,
              imageResult.url?h('div',{className:'c2a-result'},h('img',{src:imageResult.url,alt:'生成结果'}),h('a',{className:'c2a-download',href:imageResult.url,download:'dsh-chatgpt2api-image.'+(imageResult.format==='gif'?'gif':'png')},'下载图片')):h('div',{className:'c2a-result-empty'},imageResult.loading?'正在等待后端生成结果…':'生成完成后图片显示在这里')
            )
          )
        ):
        tab==='advanced'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'高级账号导入'),h('p',null,'使用本插件原生界面管理账号来源；不依赖原项目 Next.js 网页或额外部署。')),h(Btn,{onClick:refreshPools,disabled:advancedBusy},advancedBusy?'处理中…':'刷新连接')),
          h('div',{className:'c2a-info',style:{margin:'0 0 12px 0',display:'flex',justifyContent:'space-between',alignItems:'center',gap:'12px',flexWrap:'wrap'}},
            h('div',null,
              h('strong',null,'💡 想导入「邮箱---密码---2FA」文本或选择 .txt 文件？'),
              h('p',{style:{margin:'4px 0 0',color:'#42659e',fontSize:'12px'}},'当前页面为 CPA / sub2api / JSON 格式的高级导入；常规账号批量导入及 TXT 文件选择请前往「号池管理 / 导入」页面。')
            ),
            h(Btn,{primary:true,onClick:()=>setTab('accounts')},'前往账号导入（支持 TXT） →')
          ),
          advancedError?h('div',{className:'c2a-alert'},advancedError):null,
          importMessage?h('div',{className:'c2a-info'},importMessage):null,
          h(Card,{title:'导入 CPA / OAuth JSON 文件'},
            h('input',{type:'file',accept:'.json,application/json',onChange:async e=>{const f=e.target.files?.[0];if(f){if(f.size>2000000){setAdvancedError('文件超过 2 MB');return}try{setImportJson(await f.text());setAdvancedError('')}catch(err){setAdvancedError(shortError(err))}}}}),
            h('textarea',{className:'c2a-textarea',value:importJson,onChange:e=>setImportJson(e.target.value),rows:4,placeholder:'粘贴 {"accounts":[{"access_token":"...","refresh_token":"..."}]} 或含 access_token 的对象数组','aria-label':'账号 JSON'}),
            h('div',{className:'c2a-formrow'},h(Btn,{primary:true,onClick:importAccountsJson,disabled:advancedBusy||!importJson.trim()},'导入 JSON 账号')),
            h('p',{className:'c2a-help'},'仅从你有权使用的账号文件导入。账号信息提交至本机后端；导入成功后清空浏览器输入。')
          ),
          h(Card,{title:'CPA 服务器导入'},
            h('p',{className:'c2a-help'},'添加已授权的 CPA 连接，获取远程文件并选择导入。'),
            h('div',{className:'c2a-formrow'},
              h('input',{value:cpaDraft.name,placeholder:'连接名称',onChange:e=>setCpaDraft(v=>({...v,name:e.target.value}))}),
              h('input',{value:cpaDraft.base_url,placeholder:'CPA 服务器 https://...',onChange:e=>setCpaDraft(v=>({...v,base_url:e.target.value}))}),
              h('input',{type:'password',value:cpaDraft.secret_key,placeholder:'CPA Secret Key',onChange:e=>setCpaDraft(v=>({...v,secret_key:e.target.value}))}),
              h(Btn,{onClick:createCpaPool,disabled:advancedBusy},'保存连接')),
            h('div',{className:'c2a-formrow'},h('select',{value:cpaPool,onChange:e=>{setCpaPool(e.target.value);setCpaFiles([]);setCpaSelection([])}},h('option',{value:''},'选择 CPA 连接'),...cpaPools.map(x=>h('option',{key:x.id,value:x.id},x.name||x.base_url||x.id))),h(Btn,{onClick:loadCpaFiles,disabled:!cpaPool||advancedBusy},'获取远程文件')),
            h('div',{className:'c2a-formrow'},...cpaFiles.slice(0,100).map(x=>{const name=typeof x==='string'?x:String(x?.name||x?.filename||'');return name?h('label',{key:name},h('input',{type:'checkbox',checked:cpaSelection.includes(name),onChange:e=>setCpaSelection(v=>e.target.checked?[...new Set([...v,name])]:v.filter(a=>a!==name))}),name):null})),
            h(Btn,{onClick:importCpaFiles,primary:true,disabled:!cpaSelection.length||advancedBusy},'导入已选文件（'+cpaSelection.length+'）')
          ),
          h(Card,{title:'sub2api 账号导入'},
            h('p',{className:'c2a-help'},'输入你有权使用的 sub2api 服务地址与 API Key，再选择账号导入。'),
            h('div',{className:'c2a-formrow'},
              h('input',{value:subDraft.name,placeholder:'连接名称',onChange:e=>setSubDraft(v=>({...v,name:e.target.value}))}),
              h('input',{value:subDraft.base_url,placeholder:'sub2api 服务 https://...',onChange:e=>setSubDraft(v=>({...v,base_url:e.target.value}))}),
              h('input',{type:'password',value:subDraft.api_key,placeholder:'sub2api API Key',onChange:e=>setSubDraft(v=>({...v,api_key:e.target.value}))}),
              h(Btn,{onClick:createSubServer,disabled:advancedBusy},'保存连接')),
            h('div',{className:'c2a-formrow'},h('select',{value:subServer,onChange:e=>{setSubServer(e.target.value);setSubAccounts([]);setSubSelection([])}},h('option',{value:''},'选择 sub2api 连接'),...subServers.map(x=>h('option',{key:x.id,value:x.id},x.name||x.base_url||x.id))),h(Btn,{onClick:loadSubAccounts,disabled:!subServer||advancedBusy},'获取远程账号')),
            h('div',{className:'c2a-formrow'},...subAccounts.slice(0,100).map(x=>{const id=String(x?.id??x?.account_id??'');return id?h('label',{key:id},h('input',{type:'checkbox',checked:subSelection.includes(id),onChange:e=>setSubSelection(v=>e.target.checked?[...new Set([...v,id])]:v.filter(a=>a!==id))}),String(x?.email||x?.name||id)):null})),
            h(Btn,{onClick:importSubAccounts,primary:true,disabled:!subSelection.length||advancedBusy},'导入已选账号（'+subSelection.length+'）')
          )
        ):
        h('div',{className:'c2a-settings'},
          h(Card,{title:'跨平台 无 Docker 运行方式'},
            h('p',{className:'c2a-help'},'插件优先利用系统已有 Python 环境（若检测到已有 Python 则直接复用并自动补齐依赖，无需重复下载）；若未检测到可用 Python，会自动下载轻量隔离环境。无须另装 Docker。账号数据保留在用户目录。'),
            h('div',{className:'c2a-info'},'支持 Windows、macOS 或 Linux（x64/ARM64）。优先复用系统已有环境以节省下载流量与磁盘占用。不会自动获取账号或绕过任何上游额度限制。'),
            h('p',{className:'c2a-help'},'管理页面无需额外密码。内部认证由 DSH Host 自动执行，第三方应用仍需独立用户 API Key。'),
            h('p',{className:'c2a-fieldlabel'},'查看 本机运行状态'),
            h('pre',{className:'c2a-code'},'node scripts/manage-backend.mjs status'),
            h('p',{className:'c2a-fieldlabel'},'插件 Host 服务'),
            h('pre',{className:'c2a-code'},'ctx.chatgpt2api.health()\nctx.chatgpt2api.models()\nctx.chatgpt2api.chatCompletion({...})\nctx.chatgpt2api.generateImage({...})')
          ),
          h(Card,{title:'额度为 0 时的排查提示'},
            h('p',{className:'c2a-help'},'如果账号已经导入，但剩余额度持续为 0，请去「号池管理」检查代理、运行测试并刷新全部账号的额度；也可以复制排查说明交给 DeepSeek。'),
            h(Btn,{onClick:()=>copyWithFeedback(ZERO_QUOTA_PROMPT,'zero-quota-settings')},copiedId==='zero-quota-settings'?'✓ 已复制':'复制给 DeepSeek 的排查说明'),
            h(Btn,{onClick:()=>setTab('accounts')},'前往号池管理')
          ),
          h(Card,{title:'本机接口地址'},
            h('p',{className:'c2a-help'},'服务默认绑定本机回环端口，仅供本机应用使用；修改实际端口请在插件 Host 配置中完成。'),
            h('pre',{className:'c2a-code'},endpoint?endpoint+'/v1':'http://127.0.0.1:38650/v1')
          ),
          h(Card,{title:'注意事项'},h('p',{className:'c2a-help'},'chatgpt2api 是对网站接口的逆向研究，可能失效或导致账号受限。仅使用你本人有权限使用的账号，并遵循上游项目和平台的规则；本插件不提供跨账号自动批量调度。'))
        )
      ),
      h('footer',{className:'c2a-footer'},h('span',null,'ChatGPT2API Native · 跨平台 x64 · DSH Host + OpenAI 兼容 HTTP API'),h('span',null,'管理免密码 · 第三方 API Key 独立隔离'))
    );
  }
  return {Dashboard,HeaderIcon,urlClean,PANEL,imageFailureText,DEFAULT_PROMPT};
}
