import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fakeUi(){
  const values=[];let index=0;
  const React={
    Fragment:'fragment',
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v}]},
    useEffect(){},useMemo:fn=>fn(),
  };
  let moduleExports=null;
  const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{URL, __ModuleLoader__:{load:({factory})=>{moduleExports=factory(()=>React)}}});
  const slots=[];
  moduleExports.apply({slots:{inject(_name,cb){return cb()},register(def,component){slots.push({def,component});return()=>{}}}});
  const root=slots.find(x=>x.def.name==='main').component;
  function render(){index=0;return root()}
  function flatten(node){
    if(node==null||node===false)return [];
    if(Array.isArray(node))return node.flatMap(flatten);
    if(typeof node==='string'||typeof node==='number')return [node];
    if(typeof node.type==='function')return flatten(node.type({...node.props,children:node.children}));
    return [node,...node.children.flatMap(flatten)];
  }
  return {render,flatten};
}

test('native workbench has account pool, import, and standalone image tabs',()=>{
  const {render,flatten}=fakeUi();
  const initial=flatten(render());
  let labels=initial.map(x=>typeof x==='object'?'':x).join('');
  assert.match(labels,/ChatGPT2API/);assert.match(labels,/号池管理/);
  const nav=initial.find(n=>n?.type==='button'&&n?.props?.className?.includes('c2a-tab')&&flatten(n).some(c=>c==='号池管理'));
  assert.ok(nav);nav.props.onClick();
  const pool=flatten(render());labels=pool.filter(x=>typeof x==='string').join('');
  assert.match(labels,/无需管理员密码/);assert.match(labels,/导入一个账号/);assert.match(labels,/邮箱 \/ 密码 \/ 第三字段批量导入/);assert.match(labels,/待授权记录/);
  const apiNav=pool.find(n=>n?.type==='button'&&n?.props?.className?.includes('c2a-tab')&&flatten(n).includes('API 接入'));
  assert.ok(apiNav);apiNav.props.onClick();
  const apiPage=flatten(render());labels=apiPage.filter(x=>typeof x==='string').join('');
  assert.match(labels,/通用 API 接入/);assert.match(labels,/OpenAI 兼容 API Base URL/);assert.match(labels,/复制 URL/);
  const imageNav=apiPage.find(n=>n?.type==='button'&&n?.props?.className?.includes('c2a-tab')&&flatten(n).includes('图片生成'));
  assert.ok(imageNav);imageNav.props.onClick();
  const image=flatten(render());labels=image.filter(x=>typeof x==='string').join('');
  assert.match(labels,/创建生图任务/);assert.match(labels,/参考图片/);
});
