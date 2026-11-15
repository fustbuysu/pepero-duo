const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname+'/../multiplayer.js','utf8');
let now=0, queue=[], peers=new Map(), clients=[];
function flush(){while(queue.length) queue.shift()();}
class Emitter { constructor(){this.events={};} on(e,f){(this.events[e]??=[]).push(f);} emit(e,x){for(const f of this.events[e]||[])f(x);} }
class Link extends Emitter {
 constructor(){super();this.open=false;this.silent=false;}
 send(data){if(this.open && !this.silent) queue.push(()=>this.remote.emit('data',structuredClone(data)));}
 close(){if(this.closed)return;this.closed=true;this.open=false;this.emit('close'); if(this.remote && !this.remote.closed)this.remote.close();}
}
class Peer extends Emitter {
 constructor(id){super();this.id=id||'guest-'+Math.random();peers.set(this.id,this);queue.push(()=>this.emit('open'));}
 connect(id){const a=new Link(),b=new Link();a.remote=b;b.remote=a;queue.push(()=>{peers.get(id).emit('connection',b);a.open=b.open=true;b.emit('open');a.emit('open');});return a;}
 destroy(){peers.delete(this.id);}
}
function client(){
 const elements={},intervals=new Map();let tid=0;
 function element(id){return elements[id]??={value:id==='inA'?'A':id==='inB'?'B':'',style:{},dataset:{},checked:false,children:[],textContent:'',addEventListener(){},closest(){return this;},querySelector(){return element(id+'child');},replaceChildren(){this.children=[];},append(x){this.children.push(x);}};}
 const context={Peer,Date:{now:()=>now},performance:{now:()=>now},crypto:{getRandomValues:a=>{a.fill(clients.length);return a;}},Uint8Array,
 $:element,document:{querySelector:()=>element('panel'),querySelectorAll:()=>[],createElement:()=>element('created')},window:{Peer,addEventListener(){}},
 setInterval:f=>{intervals.set(++tid,f);return tid;},clearInterval:id=>intervals.delete(id),setTimeout:f=>{queue.push(f);return 1;},clearTimeout(){},
 heartCol:{A:'#ff0000',B:'#0000ff'},kao:{A:'',B:''},flip:{A:false,B:false},custom:{},thoughts:{A:[],B:[]},S:{},particles:[],
 render(){},refreshHeart(){},initAudio(){},kick(){},stepParticles(){},simStep(){},updateThoughts(){},W:375,H:360,ch:110,FLOOR:26};
 // Connection timeout is tested via heartbeat; do not fire it immediately in this harness.
 context.setTimeout=(f,ms)=>{if(ms<1000)queue.push(f);return 1;};
 vm.createContext(context);new vm.Script(source).runInContext(context);
 const result={e:element,ctx:context,tick(){for(const f of [...intervals.values()])f();}};clients.push(result);return result;
}
function join(host){const guest=client();guest.e('joinCode').value=host.e('roomCode').textContent;guest.e('joinRoom').onclick();flush();return guest;}
const host=client();host.e('createRoom').onclick();flush();const code=host.e('roomCode').textContent;
assert.equal(host.e('occupancy').textContent,'Гравців: 1/2');
let guest=join(host);assert.equal(host.e('occupancy').textContent,'Гравців: 2/2');
guest.e('flipB').onchange({target:{checked:true}});flush();assert.equal(host.ctx.flip.B,true);
guest.e('flipB').onchange({target:{checked:false}});flush();assert.equal(host.ctx.flip.B,false);
const third=join(host);assert.match(third.e('roomStatus').textContent,/зайнята/);
// Idle players remain connected while responding to heartbeat.
for(let i=0;i<20;i++){now+=1000;host.tick();guest.tick();flush();}
assert.equal(host.e('occupancy').textContent,'Гравців: 2/2');
guest.e('leave').onclick();flush();assert.equal(host.e('roomCode').textContent,code);assert.equal(host.e('occupancy').textContent,'Гравців: 1/2');
guest=join(host);host.e('kickGuest').onclick();flush();assert.match(guest.e('roomStatus').textContent,/від’єднав вас/);assert.equal(host.e('occupancy').textContent,'Гравців: 1/2');
guest=join(host);
// Simulate a dead guest tab: it cannot send even in response to pings.
const hostPeer=[...peers.values()].find(p=>p.id.startsWith('pepero-duo-'));
// Capture a fresh connection and suppress all guest traffic.
guest.e('leave').onclick();flush();let liveLink;hostPeer.on('connection',c=>liveLink=c);guest=join(host);liveLink.remote.silent=true;
now+=14999;host.tick();flush();assert.equal(host.e('occupancy').textContent,'Гравців: 2/2');
now+=1;host.tick();flush();assert.equal(host.e('occupancy').textContent,'Гравців: 1/2');assert.equal(host.e('roomCode').textContent,code);
const staleLink=liveLink; guest=join(host);assert.equal(host.e('occupancy').textContent,'Гравців: 2/2');
// Old connection events cannot remove a replacement guest.
staleLink.emit('close');assert.equal(host.e('occupancy').textContent,'Гравців: 2/2');
console.log('PASS: occupancy, flip on/off, full room, idle heartbeat, leave/rejoin, kick, 15s timeout, retained room code');
