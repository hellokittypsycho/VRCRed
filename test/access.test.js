import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';
import { decodePacket } from '../lib/osc.js';

const adminPassword = 'test-admin-password-123', viewerPassword = 'test-viewer-password-123';
async function fixture(t, legacy) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deck-accounts-'));
  const packets = [], mock = dgram.createSocket('udp4');
  mock.on('message', data => packets.push(...decodePacket(data)));
  await new Promise(resolve => mock.bind(0,'127.0.0.1',resolve));
  const databaseFile = path.join(directory,'deck.sqlite'), legacyAccessFile = path.join(directory,'legacy.json');
  if (legacy) await writeFile(legacyAccessFile,JSON.stringify(legacy));
  const options = { port:0, receivePort:0, oscPort:mock.address().port, oscQuery:false,
    avatarRoot:path.join(directory,'no-avatars'), databaseFile, legacyAccessFile };
  let app = await createApp(options);
  t.after(async () => { await app.close(); mock.close(); assert.equal(path.dirname(directory),path.resolve(os.tmpdir())); await rm(directory,{recursive:true,force:true}); });
  const f = {
    get app() { return app; }, databaseFile, legacyAccessFile, packets, avatarRoot: options.avatarRoot,
    post(route, body={}, session, extra={}) { return fetch(`${app.url}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json',...session,...extra},body:JSON.stringify(body)}); },
    get(route, session) { return fetch(`${app.url}/api/${route}`,{headers:session}); },
    async session(response) {
      const body = await response.json(); assert.equal(response.status,200,JSON.stringify(body));
      return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-Deck-Token':body.token};
    },
    async setup() { return f.session(await f.post('auth/setup',{username:'Admin',password:adminPassword})); },
    async invite(admin, body={}) { const result=await f.post('invites/create',body,admin); assert.equal(result.status,200); return (await result.json()).code; },
    async register(admin,name='Viewer',body={}) { const invite=await f.invite(admin); return f.session(await f.post('auth/register',{username:name,password:viewerPassword,invite,...body})); },
    async login(name,password=viewerPassword) { return f.session(await f.post('auth/login',{username:name,password})); },
    async restart() { await app.close(); app=await createApp(options); },
  };
  return f;
}
async function until(predicate) { for(let i=0;i<100;i++){if(predicate())return;await delay(15);}throw new Error('Expected live update'); }
async function openEvents(url, headers) {
  const events=[];let ended=false, response;
  const req=http.get(`${url}/api/events`,{headers});
  await new Promise((resolve,reject)=>{req.on('response',res=>{response=res;let pending='';res.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n\n'))>=0){const packet=pending.slice(0,end);pending=pending.slice(end+2);const data=packet.match(/^data: (.*)$/m);if(data)events.push({name:packet.match(/^event: (.*)$/m)?.[1]||'state',data:JSON.parse(data[1])});}});res.on('end',()=>{ended=true;});resolve();});req.on('error',reject);});
  return {events,get ended(){return ended;},close(){response?.destroy();req.destroy();}};
}

test('invite-only accounts protect media; every avatar command and global setting requires an admin',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.app.url, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 200, 'friends can open the login page from an external link');
  assert.equal((await fetch(`${f.app.url}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for(const route of ['state','events','chat','camera/frame','camera/stream','accounts','invites'])assert.equal((await f.get(route)).status,401,route);
  assert.equal((await f.post('auth/setup',{},undefined,{'X-Forwarded-For':'1.2.3.4'})).status,403);
  assert.equal((await f.post('auth/setup',{username:'x',password:adminPassword})).status,400);
  const admin=await f.setup();
  assert.equal((await f.post('auth/setup',{username:'AnotherAdmin',password:adminPassword})).status,409);
  assert.equal((await f.post('auth/register',{username:'Viewer',password:viewerPassword,role:'admin'})).status,400);
  assert.equal((await f.post('auth/register',{username:'Viewer',password:viewerPassword,invite:'made-up-code'})).status,403);
  const viewer=await f.register(admin,'Viewer',{role:'admin',disabled:false});
  const state=await(await f.get('state',viewer)).json();
  assert.equal(state.user.role,'viewer');assert.equal(state.user.username,'Viewer');assert.deepEqual(state.avatars,[]);assert.deepEqual(state.values,{});assert.equal(state.publicOrigin,undefined);
  for(const route of ['move','release','pause','preset','parameter','stop','restore','camera/start','camera/stop','settings','rescan','avatar','access/origin','audio/devices','accounts/update','invites/create','invites/revoke','chat/remove','arm','activate'])assert.equal((await f.post(route,{},viewer)).status,403,route);
  assert.equal((await f.get('accounts',viewer)).status,403);assert.equal((await f.get('invites',viewer)).status,403);
  assert.equal((await f.post('move',{name:'forward'},admin,{'X-Deck-Token':'wrong'})).status,403);
  assert.equal((await f.post('move',{name:'forward'},admin,{Origin:'https://evil.example'})).status,403);
  assert.equal(f.packets.length,0,'rejected viewer commands must send no OSC');
  assert.equal((await f.post('move',{name:'forward',duration:60},admin)).status,200);
  await until(()=>f.packets.some(p=>p.address==='/input/Vertical'&&p.args[0]===0));
  assert.equal(f.packets.find(p=>p.address==='/input/Vertical').args[0],1);
  assert.equal((await f.post('settings',{dryRun:true,oscPort:9000},admin)).status,400);
  for(const route of ['arm','activate'])assert.equal((await f.post(route,{},admin)).status,404);
  const users=(await(await f.get('accounts',admin)).json()).users;
  assert.ok(users.every(u=>!('hash'in u)&&!('salt'in u)));
  const db=new DatabaseSync(f.databaseFile,{readOnly:true});
  const rows=db.prepare('SELECT username,hash,salt FROM users').all();assert.equal(rows.length,2);
  for(const row of rows){assert.match(row.hash,/^[a-f0-9]{128}$/);assert.match(row.salt,/^[a-f0-9]{48}$/);assert.notEqual(row.hash,adminPassword);assert.notEqual(row.hash,viewerPassword);}
  db.close();
});

test('chat delivers live events, identifies authors on the server, limits spam and allows admin moderation',async t=>{
  const f=await fixture(t),admin=await f.setup(),viewer=await f.register(admin);
  const live=await openEvents(f.app.url,viewer);t.after(()=>live.close());
  await until(()=>live.events.some(e=>e.name==='chat-history'));
  const response=await f.post('chat/send',{text:'<img src=x onerror=alert(1)> Hello stream',username:'Admin',role:'admin'},viewer);
  const {message}=await response.json();assert.equal(response.status,200);assert.equal(message.username,'Viewer');assert.equal(message.role,'viewer');
  await until(()=>live.events.some(e=>e.name==='chat'&&e.data.message.id===message.id));
  assert.equal((await f.post('chat/send',{text:'   '},viewer)).status,400);
  assert.equal((await f.post('chat/send',{text:'x'.repeat(501)},viewer)).status,400);
  assert.equal((await f.post('chat/remove',{id:message.id},viewer)).status,403);
  assert.equal((await f.post('chat/remove',{id:message.id},admin)).status,200);
  await until(()=>live.events.some(e=>e.name==='chat'&&e.data.message.id===message.id&&e.data.message.deleted));
  const history=(await(await f.get('chat',viewer)).json()).messages;assert.equal(history[0].text,'');assert.equal(history[0].deleted,1);
  for(let i=0;i<4;i++)assert.equal((await f.post('chat/send',{text:`Message ${i}`},viewer)).status,200);
  assert.equal((await f.post('chat/send',{text:'too fast'},viewer)).status,429);
  assert.equal((await f.post('chat/send',{text:'Admin can chat too'},admin)).status,200);
});

test('only admins enable persistent chat relay; new viewer messages use trusted names and real chatbox OSC', async t => {
  const f = await fixture(t), admin = await f.setup(), viewer = await f.register(admin, 'Mosa');
  const chatPackets = () => f.packets.filter(packet => packet.address === '/chatbox/input');
  assert.equal((await (await f.get('state', admin)).json()).chatRelayEnabled, false);
  await f.post('chat/send', { text: 'Website only' }, viewer);
  assert.equal(chatPackets().length, 0);
  assert.equal((await f.post('chat/relay', { enabled: true }, viewer)).status, 403);
  assert.equal((await f.post('chat/relay', { enabled: 'yes' }, admin)).status, 400);
  assert.equal((await f.post('chat/relay', { enabled: true }, admin)).status, 200);
  await f.post('chat/send', { text: 'Hello guys!', username: 'FakeAdmin', role: 'admin' }, viewer);
  await until(() => chatPackets().length === 1);
  assert.deepEqual(chatPackets()[0].args, ['STREAM CHAT\nMosa › Hello guys!', true, false]);
  const queued = await (await f.post('chat/send', { text: 'Moderated before relay' }, viewer)).json();
  assert.equal((await f.post('chat/remove', { id: queued.message.id }, admin)).status, 200);
  await f.post('chat/send', { text: 'Hello again' }, admin);
  await delay(3100);
  assert.deepEqual(chatPackets()[1].args, ['STREAM CHAT\nMosa › Hello guys!\nAdmin › Hello again', true, false]);
  await f.restart();
  assert.equal((await (await f.get('state', admin)).json()).chatRelayEnabled, true);
  await f.get('chat', viewer); await delay(40);
  assert.equal(chatPackets().length, 2, 'restarts and history reads never replay old chat');
  await f.post('chat/send', { text: 'x'.repeat(500) }, viewer);
  await until(() => chatPackets().length === 3);
  assert.equal(chatPackets()[2].args[0].length, 144);
  assert.equal((await f.post('chat/relay', { enabled: false }, admin)).status, 200);
  await f.restart();
  assert.equal((await (await f.get('state', admin)).json()).chatRelayEnabled, false);
});

test('SQLite keeps accounts, sessions, invites, sharing and chat through server restarts',async t=>{
  const f=await fixture(t),admin=await f.setup(),viewer=await f.register(admin);
  const spareInvite=await f.invite(admin,{maxUses:2,days:30});
  assert.equal((await f.post('access/origin',{origin:'https://friends.ngrok-free.app'},admin)).status,200);
  await f.post('chat/send',{text:'See you next stream'},viewer);
  await f.restart();
  const info=await(await f.get('auth/session',viewer)).json();assert.equal(info.authenticated,true);assert.equal(info.user.username,'Viewer');
  const history=(await(await f.get('chat',viewer)).json()).messages;assert.equal(history.at(-1).text,'See you next stream');
  assert.equal((await(await f.get('state',admin)).json()).publicOrigin,'https://friends.ngrok-free.app');
  await f.login('vIeWeR');
  const next=await f.session(await f.post('auth/register',{username:'NextFriend',password:viewerPassword,invite:spareInvite}));
  assert.equal((await(await f.get('auth/session',next)).json()).user.role,'viewer');
  const remote=await new Promise((resolve,reject)=>{const req=http.request(`${f.app.url}/api/auth/login`,{method:'POST',headers:{Host:'friends.ngrok-free.app',Origin:'https://friends.ngrok-free.app','Content-Type':'application/json'}},res=>{res.resume();resolve(res);});req.on('error',reject);req.end(JSON.stringify({username:'Viewer',password:viewerPassword}));});
  assert.equal(remote.statusCode,200);assert.match(remote.headers['set-cookie'][0],/; Secure/);
  await f.post('auth/logout',{},viewer);assert.equal((await f.get('state',viewer)).status,401);
});

test('invites are single-use by default, revoke immediately and cannot grant admin privileges',async t=>{
  const f=await fixture(t),admin=await f.setup(),code=await f.invite(admin);
  const responses=await Promise.all(['First','Second'].map(username=>f.post('auth/register',{username,password:viewerPassword,invite:code,role:'admin'})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);
  const accounts=(await(await f.get('accounts',admin)).json()).users;assert.equal(accounts.filter(u=>u.role==='admin').length,1);
  const result=await(await f.post('invites/create',{label:'Revoked invite'},admin)).json();
  const invite=result.invites.find(i=>i.label==='Revoked invite');await f.post('invites/revoke',{id:invite.id},admin);
  assert.equal((await f.post('auth/register',{username:'NoInvite',password:viewerPassword,invite:result.code})).status,403);
  const fresh=await f.invite(admin);
  assert.equal((await f.post('auth/register',{username:'admin',password:viewerPassword,invite:fresh})).status,409);
});

test('permission changes revoke live sessions and cancel movement; disabled accounts cannot log in',async t=>{
  const f=await fixture(t),admin=await f.setup(),viewer=await f.register(admin);
  const users=(await(await f.get('accounts',admin)).json()).users,account=users.find(u=>u.role==='viewer'),owner=users.find(u=>u.role==='admin');
  assert.equal((await f.post('accounts/update',{id:owner.id,role:'viewer',disabled:false},admin)).status,400);
  await f.post('accounts/update',{id:account.id,role:'admin',disabled:false},admin);
  assert.equal((await f.get('state',viewer)).status,401);
  const promoted=await f.login('Viewer');const live=await openEvents(f.app.url,promoted);t.after(()=>live.close());
  assert.equal((await f.post('preset',{name:'wiggle'},promoted)).status,200);await delay(60);
  await f.post('accounts/update',{id:account.id,role:'viewer',disabled:true},admin);
  await until(()=>live.ended);assert.equal(f.app.state().activePreset,null);
  await delay(30);const count=f.packets.length;await delay(600);assert.equal(f.packets.length,count,'revocation cancels scheduled movement');
  assert.equal((await f.post('move',{name:'forward'},promoted)).status,401);
  assert.equal((await f.post('auth/login',{username:'Viewer',password:viewerPassword})).status,401);
  await f.post('accounts/update',{id:account.id,role:'viewer',disabled:false},admin);
  const enabled=await f.login('Viewer');assert.equal((await f.post('move',{name:'forward'},enabled)).status,403);
});

test('changing a password invalidates old sessions and persists the replacement hash',async t=>{
  const f=await fixture(t),admin=await f.setup(),viewer=await f.register(admin),other=await f.login('Viewer');
  assert.equal((await f.post('auth/password',{currentPassword:'wrong',newPassword:'replacement-password-123'},viewer)).status,400);
  const replacement=await f.session(await f.post('auth/password',{currentPassword:viewerPassword,newPassword:'replacement-password-123'},viewer));
  assert.equal((await f.get('state',other)).status,401);assert.equal((await f.get('state',viewer)).status,401);
  assert.equal((await f.get('state',replacement)).status,200);
  assert.equal((await f.post('auth/login',{username:'Viewer',password:viewerPassword})).status,401);
  await f.restart();await f.login('Viewer','replacement-password-123');
});

test('existing host password migrates to admin; the former friends password becomes an invitation',async t=>{
  const salt='a'.repeat(48),hash=p=>({salt,hash:scryptSync(p,salt,64).toString('hex')});
  const legacy={version:1,host:hash('old-host-password'),friend:hash('old-friends-password'),publicOrigin:'https://old.ngrok-free.app'};
  const f=await fixture(t,legacy);const before=await readFile(f.legacyAccessFile,'utf8');
  const admin=await f.login('admin','old-host-password');
  const state=await(await f.get('state',admin)).json();assert.equal(state.role,'admin');assert.equal(state.publicOrigin,legacy.publicOrigin);
  assert.equal((await(await f.get('auth/session')).json()).migrated,true);
  const viewer=await f.session(await f.post('auth/register',{username:'NewFriend',password:viewerPassword,invite:'old-friends-password'}));
  assert.equal((await(await f.get('auth/session',viewer)).json()).user.role,'viewer');
  await f.restart();assert.equal((await(await f.get('accounts',admin)).json()).users.length,2);
  assert.equal(await readFile(f.legacyAccessFile,'utf8'),before,'original config is retained as a backup');
});

test('large avatar catalogs keep live chat connected and are sent only when definitions change', async t => {
  const f = await fixture(t), admin = await f.setup();
  const folder = path.join(f.avatarRoot, 'usr_test', 'Avatars'); await mkdir(folder, { recursive: true });
  const parameters = Array.from({ length: 1000 }, (_, i) => ({ name: `Feature${i}/${'x'.repeat(150)}`, input: { address: `/avatar/parameters/Feature${i}/${'x'.repeat(150)}`, type: 'Bool' } }));
  await writeFile(path.join(folder, 'avtr_large.json'), JSON.stringify({ name: 'Large avatar', parameters }));
  assert.equal((await f.post('rescan', {}, admin)).status, 200);
  const live = await openEvents(f.app.url, admin); t.after(() => live.close());
  await until(() => live.events.filter(e => e.name === 'state').length >= 2);
  const states = live.events.filter(e => e.name === 'state');
  assert.equal(states[0].data.avatars[0].parameters.length, 1000);
  assert.ok(!Object.hasOwn(states[1].data, 'avatars'));
  assert.ok(live.events.some(e => e.name === 'presence' && e.data.online === 1));
  await f.post('chat/send', { text: 'Chat stays connected.' }, admin);
  await until(() => live.events.some(e => e.name === 'chat'));
  assert.equal(live.ended, false);
});

test('sign-in attempt limits persist across server restarts', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 20; i++) assert.equal((await f.post('auth/login', { username: 'Admin', password: 'wrong' })).status, 401);
  assert.equal((await f.post('auth/login', { username: 'Admin', password: 'wrong' })).status, 429);
  await f.restart();
  assert.equal((await f.post('auth/login', { username: 'Admin', password: 'wrong' })).status, 429);
});
