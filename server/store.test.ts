import {describe,it,expect} from 'vitest';
import {deserializeLobby,serializeLobby} from './store.js';
import {defaults,type Lobby,type Player} from '../shared/game.js';

const player:Player={id:'socket-1',token:'token-1',name:'Rowan',role:'hunter',ready:true,connected:true,captured:false,position:{lat:40,lng:-74,accuracy:5,at:1},lastSeen:1};
const lobby:Lobby={code:'A1B2C3',hostId:'socket-1',phase:'active',players:new Map([[player.id,player]]),settings:{...defaults},startedAt:1,endsAt:2,headStartEndsAt:1,createdAt:1};

describe('lobby persistence',()=>{
  it('round-trips a lobby through storage JSON',()=>{
    const restored=deserializeLobby(JSON.parse(JSON.stringify(serializeLobby(lobby))));
    expect(restored?.code).toBe('A1B2C3');
    expect(restored?.players.get('socket-1')).toMatchObject({name:'Rowan',role:'hunter',position:player.position});
  });
  it('marks restored players disconnected',()=>{
    const restored=deserializeLobby(JSON.parse(JSON.stringify(serializeLobby(lobby))));
    expect(restored?.players.get('socket-1')?.connected).toBe(false);
  });
  it('rejects malformed stored rows',()=>{
    expect(deserializeLobby(null)).toBeNull();
    expect(deserializeLobby({code:'A1B2C3'})).toBeNull();
    expect(deserializeLobby({code:'A1B2C3',hostId:'x',phase:'lobby',settings:defaults,createdAt:1,players:[]})).toBeNull();
  });
});
