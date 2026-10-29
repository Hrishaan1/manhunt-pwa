import express from 'express';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {Server} from 'socket.io';
import {Lobby,Player,Role,Settings,defaults,distance,bearing,safeName,validPosition,canCapture,startRequirements} from '../shared/game.js';
import {createStore} from './store.js';

const app=express();
const httpServer=createServer(app);
const port=Number(process.env.PORT||3001);
const isProduction=process.env.NODE_ENV==='production';
const __dirname=path.dirname(fileURLToPath(import.meta.url));

const MAX_PLAYERS=50;
const MAX_LOBBIES=500;
const MAX_LOBBY_AGE_MS=12*3600000;
const DISCONNECTED_LOBBY_TTL_MS=3600000;

const allowedOrigins=[process.env.CLIENT_ORIGIN,process.env.RENDER_EXTERNAL_URL,process.env.PUBLIC_URL]
  .filter((value):value is string=>!!value)
  .flatMap(value=>value.split(','))
  .map(value=>value.trim().replace(/\/$/,''))
  .filter(Boolean);

function originAllowed(origin?:string,host?:string){
  if(!origin)return true;
  const normalized=origin.replace(/\/$/,'');
  if(allowedOrigins.includes(normalized))return true;
  if(!isProduction&&/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized))return true;
  if(host){
    try{return new URL(normalized).host===host}catch{return false}
  }
  return false;
}

app.disable('x-powered-by');
app.set('trust proxy',Number(process.env.TRUST_PROXY||1));
app.use((_req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  next();
});

const io=new Server(httpServer,{
  maxHttpBufferSize:100000,
  cors:{
    origin:allowedOrigins.length?allowedOrigins:(isProduction?false:true),
    methods:['GET','POST'],
  },
  allowRequest:(request,callback)=>{
    const allowed=originAllowed(request.headers.origin,request.headers.host);
    callback(allowed?null:'Origin not allowed',allowed);
  },
});

const store=createStore();
const lobbies=new Map<string,Lobby>();

type Bucket={count:number;resetAt:number};
const buckets=new Map<string,Bucket>();
function rateLimit(key:string,limit:number,windowMs:number){
  const now=Date.now();
  const bucket=buckets.get(key);
  if(!bucket||bucket.resetAt<=now){
    buckets.set(key,{count:1,resetAt:now+windowMs});
    return true;
  }
  if(bucket.count>=limit)return false;
  bucket.count+=1;
  return true;
}
setInterval(()=>{
  const now=Date.now();
  for(const [key,bucket]of buckets)if(bucket.resetAt<=now)buckets.delete(key);
},60000).unref();

const normalizeCode=(value:unknown)=>typeof value==='string'?value.toUpperCase().trim():'';
const clientIp=(socket:any)=>String(socket.handshake.headers['x-forwarded-for']||socket.handshake.address||'unknown').split(',')[0].trim();
const persist=(lobby:Lobby)=>store.save(lobby);

const publicLobby=(l:Lobby,viewer:Player)=>({
  code:l.code,
  hostId:l.hostId,
  phase:l.phase,
  settings:l.settings,
  startedAt:l.startedAt,
  endsAt:l.endsAt,
  headStartEndsAt:l.headStartEndsAt,
  players:[...l.players.values()].map(p=>({
    id:p.id,
    name:p.name,
    role:p.role,
    ready:p.ready,
    connected:p.connected,
    captured:p.captured,
    position:viewer.role==='hunter'?p.position:undefined,
    lastSeen:p.lastSeen,
  })),
  radar:viewer.role==='runner'&&viewer.position?[...l.players.values()].filter(p=>p.role==='hunter'&&p.position).map(p=>({
    id:p.id,
    name:p.name,
    distance:Math.round(distance(viewer.position!,p.position!)),
    bearing:Math.round(bearing(viewer.position!,p.position!)),
    at:p.position!.at,
    connected:p.connected,
  })):[],
});

const send=(l:Lobby)=>{
  for(const player of l.players.values())io.to(player.id).emit('state',publicLobby(l,player));
};

const get=(socket:any)=>{
  const lobby=lobbies.get(socket.data.code);
  const player=lobby?.players.get(socket.id);
  return lobby&&player?{l:lobby,p:player}:null;
};

const finishIfDone=(l:Lobby)=>{
  if(l.phase!=='active')return false;
  const runners=[...l.players.values()].filter(p=>p.role==='runner');
  if(!runners.some(p=>!p.captured)||(l.endsAt&&Date.now()>=l.endsAt)){
    l.phase='ended';
    return true;
  }
  return false;
};

const checkCaptures=(l:Lobby)=>{
  if(l.phase!=='active')return;
  const hunters=[...l.players.values()].filter(p=>p.role==='hunter'&&p.position);
  for(const runner of l.players.values()){
    if(runner.role!=='runner'||runner.captured||!runner.position)continue;
    if(hunters.some(hunter=>canCapture(hunter.position,runner.position,l.settings.captureRadius)))runner.captured=true;
  }
};

io.on('connection',socket=>{
  socket.on('create',(data,cb)=>{
    const ip=clientIp(socket);
    if(!rateLimit(`create:${ip}`,5,600000))return cb?.({error:'Too many lobby creation attempts. Wait a few minutes and try again.'});
    if(lobbies.size>=MAX_LOBBIES)return cb?.({error:'The server is at capacity right now. Try again shortly.'});
    const name=safeName(data?.name);
    if(!name)return cb?.({error:'Choose a display name (1–22 characters).'});
    let code='';
    do code=crypto.randomBytes(3).toString('hex').toUpperCase();while(lobbies.has(code));
    const player:Player={id:socket.id,token:crypto.randomUUID(),name,role:'hunter',ready:false,connected:true,captured:false,lastSeen:Date.now()};
    const lobby:Lobby={code,hostId:player.id,phase:'lobby',players:new Map([[player.id,player]]),settings:{...defaults},createdAt:Date.now()};
    lobbies.set(code,lobby);
    socket.join(code);
    socket.data={code,token:player.token,lastPositionAt:0};
    cb?.({code,token:player.token});
    persist(lobby);
    send(lobby);
  });

  socket.on('join',(data,cb)=>{
    const ip=clientIp(socket);
    if(!rateLimit(`join:${ip}`,90,600000))return cb?.({error:'Too many join attempts. Wait a few minutes and try again.'});
    const code=normalizeCode(data?.code);
    const name=safeName(data?.name);
    const lobby=lobbies.get(code);
    if(!lobby||!name)return cb?.({error:!lobby?'Lobby not found. Check the signal code.':'Choose a valid display name.'});
    if(lobby.phase!=='lobby')return cb?.({error:'This round has already started.'});
    if(lobby.players.size>=MAX_PLAYERS)return cb?.({error:'This lobby is full.'});
    const player:Player={id:socket.id,token:crypto.randomUUID(),name,role:'runner',ready:false,connected:true,captured:false,lastSeen:Date.now()};
    lobby.players.set(socket.id,player);
    socket.join(code);
    socket.data={code,token:player.token,lastPositionAt:0};
    cb?.({code,token:player.token});
    persist(lobby);
    send(lobby);
  });

  socket.on('resume',(data,cb)=>{
    if(!rateLimit(`resume:${clientIp(socket)}`,60,60000))return cb?.({error:'Too many reconnect attempts. Wait a moment and try again.'});
    const lobby=lobbies.get(normalizeCode(data?.code));
    const entry=lobby&&[...lobby.players.values()].find(p=>p.token===data?.token);
    if(!lobby||!entry)return cb?.({error:'That session has expired.'});
    const previousId=entry.id;
    lobby.players.delete(previousId);
    entry.id=socket.id;
    entry.connected=true;
    entry.lastSeen=Date.now();
    lobby.players.set(socket.id,entry);
    if(lobby.hostId===previousId)lobby.hostId=socket.id;
    socket.join(lobby.code);
    socket.data={code:lobby.code,token:entry.token,lastPositionAt:0};
    cb?.({code:lobby.code,token:entry.token});
    persist(lobby);
    send(lobby);
    const previous=io.sockets.sockets.get(previousId);
    if(previous&&previous.id!==socket.id)previous.disconnect(true);
  });

  socket.on('ready',value=>{
    const found=get(socket);
    if(!found||found.l.phase!=='lobby')return;
    found.p.ready=!!value;
    persist(found.l);
    send(found.l);
  });

  socket.on('configure',(settings:Partial<Settings>)=>{
    const found=get(socket);
    if(!found||found.l.hostId!==found.p.id||found.l.phase!=='lobby')return;
    const clamp=(value:any,min:number,max:number,base:number)=>Number.isFinite(value)?Math.min(max,Math.max(min,Math.round(value))):base;
    found.l.settings={
      durationMin:clamp(settings.durationMin,1,180,found.l.settings.durationMin),
      captureRadius:clamp(settings.captureRadius,5,200,found.l.settings.captureRadius),
      headStartSec:clamp(settings.headStartSec,0,600,found.l.settings.headStartSec),
      runnerRevealSec:clamp(settings.runnerRevealSec,15,900,found.l.settings.runnerRevealSec),
    };
    persist(found.l);
    send(found.l);
  });

  socket.on('role',(id:string,role:Role)=>{
    const found=get(socket);
    const target=found?.l.players.get(id);
    if(!found||!target||found.l.hostId!==found.p.id||found.l.phase!=='lobby'||!['hunter','runner'].includes(role))return;
    target.role=role;
    target.ready=false;
    persist(found.l);
    send(found.l);
  });

  socket.on('start',cb=>{
    const found=get(socket);
    if(!found||found.l.hostId!==found.p.id)return cb?.({error:'Host controls the round.'});
    if(found.l.phase!=='lobby')return cb?.({error:'This round has already started.'});
    const issues=startRequirements([...found.l.players.values()]);
    if(issues.length)return cb?.({error:issues.join(' '),issues});
    const now=Date.now();
    found.l.startedAt=now;
    found.l.headStartEndsAt=now+found.l.settings.headStartSec*1000;
    found.l.endsAt=found.l.headStartEndsAt+found.l.settings.durationMin*60000;
    found.l.phase=found.l.settings.headStartSec?'headstart':'active';
    persist(found.l);
    send(found.l);
    cb?.({ok:true});
  });

  socket.on('position',position=>{
    const found=get(socket);
    if(!found||!validPosition(position)||!['headstart','active'].includes(found.l.phase))return;
    const now=Date.now();
    if(now-(socket.data.lastPositionAt||0)<750)return;
    socket.data.lastPositionAt=now;
    found.p.position={lat:position.lat,lng:position.lng,accuracy:Math.min(position.accuracy,5000),at:now};
    found.p.lastSeen=now;
    checkCaptures(found.l);
    finishIfDone(found.l);
    persist(found.l);
    send(found.l);
  });

  socket.on('leave',()=>{
    const found=get(socket);
    if(!found)return;
    found.l.players.delete(found.p.id);
    if(found.l.hostId===found.p.id&&found.l.players.size)found.l.hostId=found.l.players.keys().next().value!;
    if(!found.l.players.size){
      lobbies.delete(found.l.code);
      store.delete(found.l.code);
    }else{
      persist(found.l);
      send(found.l);
    }
    socket.leave(found.l.code);
    socket.data={};
  });

  socket.on('disconnect',()=>{
    const found=get(socket);
    if(!found)return;
    found.p.connected=false;
    found.p.lastSeen=Date.now();
    persist(found.l);
    send(found.l);
  });
});

setInterval(()=>{
  const now=Date.now();
  for(const [code,lobby]of lobbies){
    let changed=false;
    if(lobby.phase==='headstart'&&lobby.headStartEndsAt&&now>=lobby.headStartEndsAt){
      lobby.phase='active';
      changed=true;
    }
    if(finishIfDone(lobby))changed=true;
    if(changed){
      persist(lobby);
      send(lobby);
    }else if(lobby.phase==='ended'){
      send(lobby);
    }
    if(!lobby.players.size){
      lobbies.delete(code);
      store.delete(code);
      continue;
    }
    const lastSeen=Math.max(...[...lobby.players.values()].map(p=>p.lastSeen));
    if(now-lobby.createdAt>MAX_LOBBY_AGE_MS||(![...lobby.players.values()].some(p=>p.connected)&&now-lastSeen>DISCONNECTED_LOBBY_TTL_MS)){
      lobbies.delete(code);
      store.delete(code);
    }
  }
},1000).unref();

app.get('/healthz',(_req,res)=>{
  res.status(200).json({ok:true,uptime:Math.round(process.uptime()),lobbies:lobbies.size,storage:store.kind});
});

if(isProduction){
  const client=path.resolve(__dirname,'../../dist');
  app.use(express.static(client,{
    setHeaders(res,filePath){
      if(filePath.endsWith('sw.js')||filePath.endsWith('index.html'))res.setHeader('Cache-Control','no-cache');
      else if(/\.(js|css|svg|png|webp|woff2?)$/.test(filePath))res.setHeader('Cache-Control','public, max-age=31536000, immutable');
    },
  }));
  app.get('*',(_req,res)=>res.sendFile(path.join(client,'index.html')));
}

async function hydrate(){
  try{
    const loaded=await store.load();
    for(const lobby of loaded){
      if(lobbies.has(lobby.code))continue;
      if(Date.now()-lobby.createdAt>MAX_LOBBY_AGE_MS)continue;
      if(!lobby.players.has(lobby.hostId))lobby.hostId=lobby.players.keys().next().value!;
      lobbies.set(lobby.code,lobby);
    }
    if(loaded.length)console.log(`Restored ${lobbies.size} lobby session(s) from storage.`);
  }catch(error){
    console.error('Could not load persisted lobbies; starting with empty memory state:',error instanceof Error?error.message:error);
  }
}

let shuttingDown=false;
async function shutdown(signal:string){
  if(shuttingDown)return;
  shuttingDown=true;
  console.log(`${signal} received; disconnecting clients and flushing lobbies.`);
  io.disconnectSockets(true);
  httpServer.close();
  for(const lobby of lobbies.values())store.save(lobby);
  try{await store.flush()}catch(error){console.error('Final storage flush failed:',error instanceof Error?error.message:error)}
  process.exit(0);
}
process.on('SIGTERM',()=>void shutdown('SIGTERM'));
process.on('SIGINT',()=>void shutdown('SIGINT'));

hydrate().then(()=>{
  httpServer.listen(port,()=>{
    console.log(`Trail Signal listening on ${port} (${store.kind} storage)`);
    if(allowedOrigins.length)console.log(`Allowed client origin(s): ${allowedOrigins.join(', ')}`);
  });
});
