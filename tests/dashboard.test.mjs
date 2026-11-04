import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Small React stand-in good enough for the panel: hooks keep per-mount cells,
// effects are recorded but not executed, and mount() starts a brand-new
// instance the way DSH does when the user leaves and re-enters the panel.
function loadPanel(){
  let cells=[];
  let refs=[];
  let cursor=0;
  const React={
    Fragment:'fragment',
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){
      const i=cursor++;
      if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;
      return [cells[i],v=>{cells[i]=typeof v==='function'?v(cells[i]):v}];
    },
    useRef(value){
      const i=cursor++;
      if(!(i in refs))refs[i]={current:value};
      return refs[i];
    },
    useCallback(fn){return fn},
    useMemo(fn){return fn()},
    useEffect(){},
    useLayoutEffect(){},
  };
  let moduleExports=null;
  const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{URL,__ModuleLoader__:{load:({factory})=>{moduleExports=factory(id=>{if(id!=='react')throw Error('Missing '+id);return React})}}});
  const slots=[];
  moduleExports.apply({slots:{inject(_name,cb){return cb()},register(def,component){slots.push({def,component});return()=>{}}}});
  const root=slots.find(x=>x.def.name==='main').component;
  function render(){cursor=0;return root()}
  function mount(){cells=[];refs=[];return render()}
  function flatten(node){
    if(node==null||node===false)return [];
    if(Array.isArray(node))return node.flatMap(flatten);
    if(typeof node==='string'||typeof node==='number')return [node];
    if(typeof node.type==='function')return flatten(node.type({...node.props,children:node.children}));
    return [node,...node.children.flatMap(flatten)];
  }
  function text(tree){return flatten(tree).map(x=>typeof x==='object'?'':x).join('')}
  function find(tree,predicate){return flatten(tree).find(x=>x&&typeof x==='object'&&predicate(x))}
  return {mount,render,flatten,text,find,api:moduleExports};
}

test('native workbench has account pool, import, and standalone image tabs',()=>{
  const ui=loadPanel();
  const initial=ui.flatten(ui.mount());
  let labels=ui.text(initial);
  assert.match(labels,/ChatGPT2API/);assert.match(labels,/号池管理/);
  const nav=ui.find(initial,n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&ui.flatten(n).includes('号池管理'));
  assert.ok(nav);nav.props.onClick();
  const pool=ui.flatten(ui.render());labels=ui.text(pool);
  assert.match(labels,/无需管理员密码/);assert.match(labels,/导入一个账号/);assert.match(labels,/邮箱 \/ 密码 \/ 第三字段批量导入/);assert.match(labels,/待授权记录/);
  const apiNav=ui.find(pool,n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&ui.flatten(n).includes('API 接入'));
  assert.ok(apiNav);apiNav.props.onClick();
  const apiPage=ui.flatten(ui.render());labels=ui.text(apiPage);
  assert.match(labels,/通用 API 接入/);assert.match(labels,/OpenAI 兼容 API Base URL/);assert.match(labels,/复制 URL/);
  const imageNav=ui.find(apiPage,n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&ui.flatten(n).includes('图片生成'));
  assert.ok(imageNav);imageNav.props.onClick();
  const image=ui.flatten(ui.render());labels=ui.text(image);
  assert.match(labels,/创建生图任务/);assert.match(labels,/参考图片/);
});

test('leaving and re-entering the panel restores the tab and drafts instead of reloading',()=>{
  const ui=loadPanel();
  let tree=ui.mount();
  const accountsTab=ui.find(tree,n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&ui.flatten(n).includes('号池管理'));
  assert.ok(accountsTab);accountsTab.props.onClick();
  tree=ui.render();
  const draft='someone@example.com----pa55----2FASECRET';
  const textarea=ui.find(tree,n=>n.type==='textarea'&&n.props?.['aria-label']==='一行一条账号凭据文本');
  assert.ok(textarea);textarea.props.onChange({target:{value:draft}});
  const apiTab=ui.find(ui.render(),n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&ui.flatten(n).includes('API 接入'));
  assert.ok(apiTab);apiTab.props.onClick();
  ui.render();

  // DSH unmounts the panel on the switch; re-entering mounts a fresh instance.
  const back=ui.mount();
  const selected=ui.find(back,n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&n.props.className.includes('selected'));
  assert.ok(selected);assert.ok(ui.flatten(selected).includes('API 接入'));

  const accountsTabAgain=ui.find(back,n=>n.type==='button'&&n.props?.className?.includes('c2a-tab')&&ui.flatten(n).includes('号池管理'));
  assert.ok(accountsTabAgain);accountsTabAgain.props.onClick();
  const restored=ui.render();
  const restoredTextarea=ui.find(restored,n=>n.type==='textarea'&&n.props?.['aria-label']==='一行一条账号凭据文本');
  assert.ok(restoredTextarea);assert.equal(restoredTextarea.props.value,draft);
  assert.doesNotMatch(ui.text(restored),/加载中…/);
});

test('image failures explain upstream content policy instead of echoing the apology',()=>{
  const {api}=loadPanel();
  const {imageFailureText,DEFAULT_PROMPT}=api.__test;
  const policy=imageFailureText('非常抱歉，生成的图片可能违反了关于轻度性暗示或挑逗性主题的防护限制。如果你认为此判断有误，请重试或修改提示语。');
  assert.match(policy,/内容安全策略/);assert.match(policy,/改用插画/);assert.match(policy,/上游原文/);
  assert.equal(imageFailureText('连接超时（240 秒）'),'连接超时（240 秒）');
  assert.doesNotMatch(DEFAULT_PROMPT,/写真|真人|性感/);
});
