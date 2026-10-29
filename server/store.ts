import type {Lobby,Player} from '../shared/game.js';

export type SerializedLobby=Omit<Lobby,'players'>&{players:Player[]};

export function serializeLobby(lobby:Lobby):SerializedLobby{
  return {...lobby,players:[...lobby.players.values()]};
}

export function deserializeLobby(raw:unknown):Lobby|null{
  if(!raw||typeof raw!=='object')return null;
  const value=raw as Partial<SerializedLobby>;
  if(typeof value.code!=='string'||!Array.isArray(value.players)||typeof value.hostId!=='string'||typeof value.phase!=='string'||!value.settings||typeof value.createdAt!=='number')return null;
  const players=new Map<string,Player>();
  for(const player of value.players){
    if(!player||typeof player.id!=='string'||typeof player.token!=='string'||typeof player.name!=='string')continue;
    players.set(player.id,{...player,connected:false});
  }
  if(!players.size)return null;
  return {...value,players} as Lobby;
}

export interface LobbyStore{
  readonly kind:'memory'|'supabase';
  load():Promise<Lobby[]>;
  save(lobby:Lobby):void;
  delete(code:string):void;
  flush():Promise<void>;
}

class MemoryStore implements LobbyStore{
  readonly kind='memory' as const;
  async load(){return []}
  save(){}
  delete(){}
  async flush(){}
}

class SupabaseStore implements LobbyStore{
  readonly kind='supabase' as const;
  private readonly base:string;
  private readonly key:string;
  private readonly pending=new Map<string,Lobby>();
  private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly deletions=new Set<string>();
  private readonly debounceMs=750;

  constructor(url:string,key:string){
    this.base=url.replace(/\/$/,'')+'/rest/v1/lobbies';
    this.key=key;
  }

  private headers(extra:Record<string,string>={}){
    return {apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'application/json',...extra};
  }

  async load():Promise<Lobby[]>{
    const cutoff=new Date(Date.now()-12*3600000).toISOString();
    const url=`${this.base}?select=code,data&updated_at=gte.${encodeURIComponent(cutoff)}&order=updated_at.desc&limit=500`;
    const response=await fetch(url,{headers:this.headers(),signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error(`Supabase load failed (${response.status}): ${await response.text()}`);
    const rows=await response.json() as Array<{data:unknown}>;
    return rows.map(row=>deserializeLobby(row.data)).filter((lobby):lobby is Lobby=>!!lobby);
  }

  save(lobby:Lobby){
    const code=lobby.code;
    this.deletions.delete(code);
    this.pending.set(code,lobby);
    if(this.timers.has(code))return;
    const timer=setTimeout(()=>{void this.flushCode(code)},this.debounceMs);
    timer.unref?.();
    this.timers.set(code,timer);
  }

  delete(code:string){
    const timer=this.timers.get(code);
    if(timer)clearTimeout(timer);
    this.timers.delete(code);
    this.pending.delete(code);
    this.deletions.add(code);
    void this.deleteRemote(code).then(()=>this.deletions.delete(code)).catch(error=>console.error('Supabase delete failed:',error instanceof Error?error.message:error));
  }

  private async flushCode(code:string){
    this.timers.delete(code);
    const lobby=this.pending.get(code);
    this.pending.delete(code);
    if(!lobby||this.deletions.has(code))return;
    try{
      const response=await fetch(`${this.base}?on_conflict=code`,{
        method:'POST',
        headers:this.headers({Prefer:'resolution=merge-duplicates,return=minimal'}),
        body:JSON.stringify({code,data:serializeLobby(lobby),updated_at:new Date().toISOString()}),
        signal:AbortSignal.timeout(8000),
      });
      if(!response.ok)throw new Error(`Supabase save failed (${response.status}): ${await response.text()}`);
    }catch(error){
      console.error('Supabase save failed:',error instanceof Error?error.message:error);
    }
  }

  private async deleteRemote(code:string){
    const response=await fetch(`${this.base}?code=eq.${encodeURIComponent(code)}`,{
      method:'DELETE',
      headers:this.headers({Prefer:'return=minimal'}),
      signal:AbortSignal.timeout(8000),
    });
    if(!response.ok)throw new Error(`Supabase delete failed (${response.status}): ${await response.text()}`);
  }

  async flush(){
    await Promise.all([...this.pending.keys()].map(code=>this.flushCode(code)));
    await Promise.all([...this.deletions].map(async code=>{
      try{await this.deleteRemote(code);this.deletions.delete(code)}catch(error){console.error('Supabase delete failed:',error instanceof Error?error.message:error)}
    }));
  }
}

export function createStore():LobbyStore{
  const url=process.env.SUPABASE_URL?.trim();
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if(url&&key){
    console.log('Lobby storage: Supabase Postgres');
    return new SupabaseStore(url,key);
  }
  console.warn('Lobby storage: memory only (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for restart-safe lobbies)');
  return new MemoryStore();
}
