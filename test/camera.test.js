import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpoutCamera } from '../lib/camera.js';
import { createApp } from '../server.js';

function fakeCamera(options = {}) {
  const workers = [], calls = [];
  const camera = new SpoutCamera({ platform: 'win32', retryDelays: [15,30,45], ...options, spawnWorker(exe,args) {
    const worker = new EventEmitter(); worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter(); worker.killed = false;
    worker.kill = () => { worker.killed = true; worker.emit('exit',0); };
    workers.push(worker); calls.push({exe,args}); return worker;
  } });
  camera.runtime = () => process.execPath;
  return { camera, workers, calls };
}
function packet(kind, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(9); header.write('CDK1'); header[4]=kind; header.writeUInt32BE(bytes.length,5);
  return Buffer.concat([header,bytes]);
}
async function until(check, timeout=1500) { const end=Date.now()+timeout; while(!check()){if(Date.now()>end)throw new Error('Camera did not recover');await delay(5);} }

test('receiver crashes reconnect with the same settings and healthy frames clear the retry state', async t => {
  const f=fakeCamera(); t.after(()=>f.camera.stop());
  f.camera.start('VRCSelected',30,{resolution:720,game:false,microphone:false,device:3});
  const config=f.camera.configuration();
  f.workers[0].emit('exit',1);
  assert.equal(f.camera.state().enabled,true); assert.equal(f.camera.state().running,false); assert.equal(f.camera.state().reconnecting,true);
  await until(()=>f.workers.length===2);
  assert.deepEqual(f.camera.configuration(),config);
  assert.equal(f.calls[1].args[2],'VRCSelected');assert.equal(f.calls[1].args[3],'30');
  const args=JSON.parse(f.calls[1].args[4]); assert.equal(args.resolution,720);assert.equal(args.game,false);assert.equal(args.microphone,false);assert.equal(args.device,3);
  f.workers[1].stdout.emit('data',packet(2,Buffer.from([0xff,0xd8,0xff,0xd9])));
  assert.equal(f.camera.state().connected,true);assert.equal(f.camera.state().attempts,0);assert.equal(f.camera.state().reconnecting,false);
});

test('intentional disconnect cancels pending reconnects and ignores old worker callbacks', async () => {
  const f=fakeCamera(); f.camera.start('',60,{game:false,microphone:false});
  f.workers[0].emit('error',new Error('lost receiver'));
  f.camera.stop(); f.workers[0].emit('exit',1);
  await delay(100);
  assert.equal(f.workers.length,1);assert.equal(f.camera.state().enabled,false);assert.equal(f.camera.state().running,false);assert.equal(f.camera.retryTimer,null);
});

test('a stalled encoder is replaced even if it keeps sending status messages', async t => {
  const f=fakeCamera({stallTimeout:50,healthInterval:5}); t.after(()=>f.camera.stop());
  f.camera.start('',60,{game:false,microphone:false});
  const statuses=setInterval(()=>f.workers[0].stdout.emit('data',packet(1,{message:'Still running'})),10); t.after(()=>clearInterval(statuses));
  await until(()=>f.workers.length>=2);
  assert.equal(f.workers[0].killed,true);assert.equal(f.camera.state().enabled,true);
});

test('bad settings do not interrupt an existing stream', () => {
  const f=fakeCamera(); f.camera.start('',30,{game:false,microphone:false});
  assert.throws(()=>f.camera.start('OtherApp',30),/VRChat/);
  assert.equal(f.workers.length,1);assert.equal(f.workers[0].killed,false);assert.equal(f.camera.state().enabled,true);
  f.camera.stop();
});

test('active broadcasts resume across server restarts, but a disconnected broadcast stays stopped', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'deck-camera-intent-'));
  const options={port:0,receivePort:0,oscQuery:false,avatarRoot:path.join(directory,'none'),databaseFile:path.join(directory,'deck.sqlite')};
  const first=fakeCamera(); let app=await createApp({...options,camera:first.camera});
  t.after(async()=>{await app.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  const post=(route,body,headers={})=>fetch(`${app.url}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const setup=await post('auth/setup',{username:'Admin',password:'camera-test-password-123'});
  const headers={Cookie:setup.headers.get('set-cookie').split(';')[0],'X-Deck-Token':(await setup.json()).token};
  const wanted={source:'VRCSelected',fps:30,resolution:720,game:false,microphone:false,device:3};
  assert.equal((await post('camera/start',wanted,headers)).status,200);assert.equal(first.camera.enabled,true);
  await app.close();
  const second=fakeCamera(); app=await createApp({...options,camera:second.camera});
  assert.equal(second.workers.length,1);assert.equal(second.camera.enabled,true);assert.deepEqual(second.camera.configuration(),wanted);
  assert.equal((await post('camera/stop',{},headers)).status,200);assert.equal(second.camera.enabled,false);
  await app.close();
  const third=fakeCamera(); app=await createApp({...options,camera:third.camera});
  assert.equal(third.camera.enabled,false);assert.equal(third.workers.length,0);
});
