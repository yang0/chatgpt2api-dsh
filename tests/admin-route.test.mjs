import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAdminHandler,createAdminRoute,ADMIN_ROUTE,UserKeyStore} from '../lib/admin-route.js';

const SECRET='host-private-secret-which-client-never-sees';
const TOKEN='upstream_access_token_supersecret';
const headerStore=[];
const calls=[];
const fetcher=async (url,opts)=>{
  calls.push({url,method:opts.method,body:opts.body&&JSON.parse(opts.body)});
  headerStore.push(opts.headers.Authorization);
  const route=new URL(url).pathname;
  let data;
  if(route==='/api/accounts'&&opts.method==='GET')data={items:[{access_token:TOKEN,refresh_token:'refreshsecret',id_token:'idsecret',email:'a@example.com',status:'normal',type:'plus',quota:10}]};
  else if(route==='/api/accounts'&&opts.method==='DELETE')data={removed:1,items:[]};
  else if(route==='/api/accounts/refresh')data={progress_id:'progress123',items:[]};
  else if(route==='/api/accounts'&&opts.method==='POST')data={added:1,skipped:0,items:[{access_token:TOKEN}],errors:['oops with '+TOKEN]};
  else if(route==='/api/auth/users'&&opts.method==='GET')data={items:[{id:'abcdef012345',name:'Cherry Studio',enabled:true,created_at:'2026-11-04',key_hash:'secret-hash'}]};
  else if(route==='/api/auth/users'&&opts.method==='POST')data={key:'userkey123456',items:[{id:'abcdef012345',name:'Cherry Studio',enabled:true}]};
  else if(route==='/api/auth/users/abcdef012345')data={items:[]};
  else if(route==='/health')data={status:'ok',healthy:true,version:'test',accounts:{total:1,active:1}};
  else if(route==='/api/cpa/pools')data={pools:[{id:'cpa1',name:'pool',base_url:'https://service.test',secret_key:'hidden'}]};
  else if(route==='/api/sub2api/servers')data={servers:[{id:'sub1',name:'srv',base_url:'https://service.test',api_key:'hidden'}]};
  else if(route==='/v1/images/generations')data={data:[{b64_json:'aW1hZ2U='}]};
  else throw new Error('mock unhandled: '+route);
  return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(data)};
};
const backend=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,fetcher});
function req(body){return new Request('http://localhost/api/chatgpt2api-native/manage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function call(payload){let res=await backend.route(req(payload));return {status:res.status,body:await res.json(),cache:res.headers.get('Cache-Control')}}

test('register passwordless management only via DSH exact authenticated Connection route',()=>{
  const route=createAdminRoute({_adminKey:SECRET,baseUrl:'http://127.0.0.1:38650'});
  assert.equal(route.path,ADMIN_ROUTE);
  assert.deepEqual(route.methods,['POST']);
  assert.equal(route.requestBody,'buffered');
  assert.equal(typeof route.fetch,'function');
});
test('fetch health and accounts without browser admin key, never leak upstream credentials',async()=>{
  let res=await call({path:'/health?format=json'});
  assert.equal(res.body.accounts.active,1);assert.equal(res.body.baseUrl,'http://127.0.0.1:38650');assert.equal(res.cache,'no-store');
  res=await call({path:'/api/accounts'});
  assert.equal(res.body.items.length,1);
  assert.match(res.body.items[0].ref,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(res.body),/upstream_access_token|refreshsecret|idsecret/);
  assert.ok(headerStore.every(x=>x===`Bearer ${SECRET}`));
});
test('account deletion and refresh use opaque reference resolved by Host only',async()=>{
  const res=await call({path:'/api/accounts'});const ref=res.body.items[0].ref;
  const removed=await call({path:'/api/accounts',method:'DELETE',body:{tokens:[ref]}});
  assert.equal(removed.body.ok,true);
  const lastDelete=calls.filter(x=>x.method==='DELETE').at(-1);
  assert.equal(lastDelete.body.tokens[0],TOKEN);
  const refresh=await call({path:'/api/accounts/refresh',method:'POST',body:{access_tokens:[ref]}});
  assert.equal(refresh.body.progress_id,'progress123');
});
test('independent user API keys stay separate from Host admin secret',async()=>{
  const created=await call({path:'/api/auth/users',method:'POST',body:{name:'Cherry Studio'}});
  assert.equal(created.body.key,'userkey123456');assert.ok(!JSON.stringify(created.body).includes(SECRET));
  const listed=await call({path:'/api/auth/users'});
  assert.equal(listed.body.items[0].id,'abcdef012345');
  assert.ok(!JSON.stringify(listed.body).includes('key_hash'));
});
test('generic or malicious paths are not forwarded to upstream',async()=>{
  const n=calls.length;
  for(const path of ['/api/settings','/api/accounts/oauth/start','http://attacker/','/api/../../api/settings']){
    const res=await call({path});assert.equal(res.status,404);
  }
  assert.equal(calls.length,n);
});
test('CPA/sub2api connection secrets are stripped from UI response',async()=>{
  const cpa=await call({path:'/api/cpa/pools'}),sub=await call({path:'/api/sub2api/servers'});
  assert.doesNotMatch(JSON.stringify(cpa.body),/secret_key/);
  assert.doesNotMatch(JSON.stringify(sub.body),/api_key/);
});
test('image generation uses protected Host bridge, not upstream auth in browser',async()=>{
  const result=await call({path:'/v1/images/generations',method:'POST',body:{model:'gpt-image-2',prompt:'An original scene',n:1}});
  assert.equal(result.body.data[0].b64_json,'aW1hZ2U=');
});
test('sensitive import errors and upstream items are not returned to browser',async()=>{
  const result=await call({path:'/api/accounts',method:'POST',body:{tokens:[TOKEN]}});
  assert.equal(result.body.added,1);
  assert.equal(result.body.errorCount,1);
  assert.doesNotMatch(JSON.stringify(result.body),/upstream_access_token/);
});
test('direct text authentication converts credentials to tokens and enrolls to upstream',async()=>{
  let registered=null;
  const mockFetcher=async (url,opts)=>{
    if(url.endsWith('/api/accounts')&&opts.method==='POST'){
      registered=JSON.parse(opts.body);
      return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({added:1,skipped:0,refreshed:1,errors:[]})};
    }
    return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({})};
  };
  const mockAuth=async ({accounts})=>({
    results: accounts.map(a=>({
      id: a.id,
      email: a.email,
      ok: true,
      access_token: 'secret_token_12345',
      refresh_token: 'rt_secret_67890',
      id_token: 'id_secret_abc'
    }))
  });
  const mockVault={list:()=>({count:0,items:[]}),getAll:()=>[],get:()=>null,delete:()=>{},updateStatus:()=>{},importText:()=>{}};
  const handler=createAdminHandler({
    baseUrl:'http://127.0.0.1:38650',
    secret:SECRET,
    fetcher:mockFetcher,
    vault:mockVault,
    authenticator:mockAuth
  });
  const request=new Request('http://localhost/api/chatgpt2api-native/manage',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      path:'/local/credential-vault/authenticate',
      method:'POST',
      body:{text:'direct@example.com----p@ssword----TOTPSECRET123'}
    })
  });
  const res=await handler.route(request);
  const data=await res.json();
  assert.equal(data.total,1);
  assert.equal(data.succeeded,1);
  assert.equal(data.enrolled.added,1);
  assert.equal(registered.tokens[0],'secret_token_12345');
  assert.equal(registered.accounts[0].email,'direct@example.com');
  assert.equal(registered.accounts[0].totp_secret,'TOTPSECRET123');
  assert.doesNotMatch(JSON.stringify(data),/secret_token|rt_secret|p@ssword|TOTPSECRET/);
});

test('UserKeyStore persists keys to disk and reloads them', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-test-keys-'));
  try {
    const store1 = new UserKeyStore({root: tmpDir});
    store1.set('key1', 'sk-test123456');
    assert.equal(store1.get('key1'), 'sk-test123456');

    // Reload from same dir
    const store2 = new UserKeyStore({root: tmpDir});
    assert.equal(store2.get('key1'), 'sk-test123456');

    store2.delete('key1');
    assert.equal(store2.get('key1'), '');

    const store3 = new UserKeyStore({root: tmpDir});
    assert.equal(store3.get('key1'), '');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('user API key creation retains plain key and exposes it in user list', async () => {
  let userItems = [];
  const testFetcher = async (url, opts) => {
    const route = new URL(url).pathname;
    if (route === '/api/auth/users' && opts.method === 'POST') {
      const createdItem = {id: 'usr_abc123', name: 'Test Key', enabled: true, created_at: '2026-11-04T12:00:00Z'};
      userItems = [createdItem];
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({item: createdItem, key: 'sk-plaintext-key-xyz', items: userItems})};
    }
    if (route === '/api/auth/users' && opts.method === 'GET') {
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({items: userItems})};
    }
    if (route.startsWith('/api/auth/users/') && opts.method === 'DELETE') {
      userItems = [];
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({items: []})};
    }
    throw new Error('unhandled ' + route);
  };
  const keyStore = new UserKeyStore();
  const testHandler = createAdminHandler({baseUrl: 'http://127.0.0.1:38650', secret: SECRET, fetcher: testFetcher, keyStore});
  const exec = async (payload) => {
    const res = await testHandler.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)}));
    return res.json();
  };

  const createRes = await exec({path: '/api/auth/users', method: 'POST', body: {name: 'Test Key'}});
  assert.equal(createRes.key, 'sk-plaintext-key-xyz');
  assert.equal(createRes.id, 'usr_abc123');
  assert.equal(createRes.items[0].key, 'sk-plaintext-key-xyz');

  const listRes = await exec({path: '/api/auth/users', method: 'GET'});
  assert.equal(listRes.items.length, 1);
  assert.equal(listRes.items[0].id, 'usr_abc123');
  assert.equal(listRes.items[0].key, 'sk-plaintext-key-xyz');

  const delRes = await exec({path: '/api/auth/users/usr_abc123', method: 'DELETE'});
  assert.equal(delRes.items.length, 0);
  assert.equal(keyStore.get('usr_abc123'), '');
});

test('opening the local image history folder only accepts the fixed Host path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-test-images-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.png'), 'x');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    let opened = null;
    const handler = createAdminHandler({
      baseUrl: 'http://127.0.0.1:38650',
      secret: SECRET,
      fetcher,
      imagesDir: dir,
      openFolder: async (target) => { opened = target; },
    });
    const exec = async (payload) => {
      const res = await handler.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)}));
      return {status: res.status, body: await res.json()};
    };

    const ok = await exec({path: '/local/open-images-dir', method: 'POST'});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.opened, true);
    assert.equal(ok.body.count, 1);
    assert.equal(ok.body.dir, path.resolve(dir));
    assert.equal(opened, path.resolve(dir));

    // GET only reports the copyable path, never launches anything.
    const get = await exec({path: '/local/open-images-dir', method: 'GET'});
    assert.equal(get.status, 200);
    assert.equal(get.body.dir, path.resolve(dir));
    assert.equal(get.body.count, 1);
    assert.equal(get.body.opened, false);

    // A failed launch still returns the path so the UI can offer copy/paste.
    let launchError = null;
    const failing = createAdminHandler({
      baseUrl: 'http://127.0.0.1:38650',
      secret: SECRET,
      fetcher,
      imagesDir: dir,
      openFolder: async () => { throw new Error('opener exploded'); },
    });
    const failRes = await failing.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: '/local/open-images-dir', method: 'POST'})}));
    launchError = await failRes.json();
    assert.equal(failRes.status, 200);
    assert.equal(launchError.opened, false);
    assert.equal(launchError.dir, path.resolve(dir));
    assert.match(launchError.error, /opener exploded/);

    const external = createAdminHandler({baseUrl: 'http://127.0.0.1:38650', secret: SECRET, fetcher});
    const res = await external.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: '/local/open-images-dir', method: 'POST'})}));
    assert.equal(res.status, 503);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});



test('authenticate route deduplicates identical accounts in input text and correctly aggregates skipped count', async () => {
  let registered = null;
  let authTargets = [];
  const mockFetcher = async (url, opts) => {
    if (url.endsWith('/api/accounts') && opts.method === 'POST') {
      registered = JSON.parse(opts.body);
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({added: 1, skipped: 0, refreshed: 0, errors: []})};
    }
    return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({})};
  };
  const mockAuth = async ({accounts}) => {
    authTargets = accounts;
    return {
      results: accounts.map(a => ({
        id: a.id,
        email: a.email,
        ok: true,
        access_token: 'secret_token_dup_test',
        refresh_token: 'rt_secret_dup_test',
        id_token: 'id_secret_dup_test'
      }))
    };
  };
  const mockVault = {list: () => ({count: 0, items: []}), getAll: () => [], get: () => null, delete: () => {}, updateStatus: () => {}, importText: () => {}};
  const handler = createAdminHandler({
    baseUrl: 'http://127.0.0.1:38650',
    secret: SECRET,
    fetcher: mockFetcher,
    vault: mockVault,
    authenticator: mockAuth
  });

  const dupText = [
    'repeat@example.com----pass1----2FASECRET1',
    'repeat@example.com----pass2----2FASECRET2'
  ].join('\n');

  const request = new Request('http://localhost/api/chatgpt2api-native/manage', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      path: '/local/credential-vault/authenticate',
      method: 'POST',
      body: {text: dupText}
    })
  });
  const res = await handler.route(request);
  const data = await res.json();

  assert.equal(data.total, 2);
  assert.equal(data.duplicates, 1);
  assert.equal(data.succeeded, 1);
  assert.equal(data.enrolled.added, 1);
  assert.equal(data.enrolled.skipped, 1);
  assert.equal(authTargets.length, 1);
  assert.equal(authTargets[0].email, 'repeat@example.com');
  assert.equal(registered.accounts.length, 1);
});

test('a non-JSON backend reply reports status and a redacted body snippet', async () => {
  // uvicorn answers an unhandled ASGI exception with plain text. Reporting only
  // "not valid JSON" hides both the status and the real cause from the user.
  const plainTextFetcher = async () => ({
    status: 500,
    ok: false,
    headers: {get: name => (name === 'content-type' ? 'text/plain; charset=utf-8' : null)},
    text: async () => `Internal Server Error: No module named 'anyio._backends' ${SECRET} sk-abcdef123456`
  });
  const handler = createAdminHandler({baseUrl: 'http://127.0.0.1:38650', secret: SECRET, fetcher: plainTextFetcher});
  const res = await handler.route(new Request('http://localhost/api/chatgpt2api-native/manage', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path: '/health?format=json'})
  }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /HTTP 500/);
  assert.match(body.error, /text\/plain/);
  assert.match(body.error, /anyio\._backends/);
  assert.doesNotMatch(body.error, new RegExp(SECRET));
  assert.doesNotMatch(body.error, /sk-abcdef123456/);
});
