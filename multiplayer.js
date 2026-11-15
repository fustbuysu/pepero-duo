/* Room transport: PeerJS signaling + a reliable WebRTC data channel. */
(() => {
  const TOTAL = 200, COMBO_GAP = 1000;
  let peer, conn, me = 'A', host = true, connected = false, phase = 'lobby';
  let scores = { A:0, B:0 }, ready = { A:false, B:false }, round = 0;
  let combos = { A:0, B:0 }, lastClick = { A:0, B:0 }, timer, timeout;
  let privateThoughts = [], revealed = 0, seq = 0, receivedSeq = 0;
  let ownAvatar = '', countdown = 0;
  const PEER_TIMEOUT = 15000;
  let heartbeat, lastSeen = 0, roomOpen = false;
  const other = () => me === 'A' ? 'B' : 'A';
  const send = data => { if (conn?.open) conn.send(data); };
  const status = text => { $('roomStatus').textContent = text; };
  const name = k => $('in' + k).value || k;
  function controls(){
    $('occupancy').textContent = `Гравців: ${connected ? 2 : roomOpen && host ? 1 : 0}/2`;
    $('kickGuest').hidden = !host || !connected;
    $('ready').disabled = !connected || !['lobby','done'].includes(phase);
    $('ready').textContent = ready[me] ? '✓ Ви готові · чекаємо партнера' : phase === 'done' ? '♥ Ще раз — готово' : '♥ Готово';
    $('bite').disabled = phase !== 'playing';
    document.querySelectorAll('.panel input,.panel textarea,.panel button').forEach(e => e.disabled = ready[me] || !['lobby','done'].includes(phase));
    $('score').textContent = `${name('A')}: ${scores.A} · ${name('B')}: ${scores.B} — залишилось ${TOTAL - scores.A - scores.B}`;
  }
  function profile(){
    return { name:name(me).slice(0,12), color:heartCol[me], kao:kao[me], flip:flip[me], avatar:ownAvatar };
  }
  function applyProfile(k, p){
    if (!p || typeof p.name !== 'string' || !/^#[\da-f]{6}$/i.test(p.color)) return;
    $('in'+k).value = p.name.slice(0,12); heartCol[k] = p.color;
    kao[k] = typeof p.kao === 'string' ? p.kao.slice(0,14) : ''; flip[k] = !!p.flip; $('flip'+k).checked = flip[k];
    custom[k] = typeof p.avatar === 'string' && p.avatar.length < 300000 && /^data:image\/(?:png|jpeg|webp);base64,/.test(p.avatar);
    if (custom[k]) $('img'+k).src = p.avatar; else refreshHeart(k);
    render(); controls();
  }
  function selectSide(k){
    const saved = profile(), text = $('ti'+me).value;
    if (saved.name === me) saved.name = k;
    me = k; applyProfile(me, saved); $('ti'+me).value = text;
    $('hc'+me).value = saved.color; $('kao'+me).value = saved.kao; $('flip'+me).checked = saved.flip;
    for (const side of ['A','B']){
      $('in'+side).closest('.who').hidden = side !== me;
      $('sw'+side).closest('.hrow').hidden = side !== me;
    }
    $('in'+me).closest('.who').querySelector('h2').textContent = 'Ваш персонаж';
    thoughts.A = []; thoughts.B = []; S.lay = {}; render();
  }
  function clearRound(){
    clearInterval(timer); scores = { A:0,B:0 }; combos = { A:0,B:0 }; lastClick = { A:0,B:0 };
    seq = receivedSeq = 0; revealed = 0;
    privateThoughts = $('ti'+me).value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,5).map(x=>x.slice(0,100));
    thoughts.A = []; thoughts.B = []; S.lay = {};
    S.p = S.k = S.hopT = S.t = 0; S.popped = false; S.playing = false; particles = [];
    $('chat').replaceChildren(); $('comboA').textContent = $('comboB').textContent = ''; render();
  }
  function begin(id){
    round = id; clearRound(); phase = 'countdown'; countdown = 3;
    status('3…'); controls();
    timer = setInterval(()=>{
      countdown--;
      if (countdown > 0) status(`${countdown}…`);
      else { clearInterval(timer); phase = 'playing'; S.playing = true; status('Клікайте! Одна паличка на двох ♥'); controls(); kick(); }
    },1000);
  }
  function startIfReady(){
    if (host && ready.A && ready.B && ['lobby','done'].includes(phase)){
      const id = round + 1; send({type:'start',round:id}); begin(id);
    }
  }
  function reveal(k, text){
    thoughts[k].push(text); S.lay = {};
    const p = document.createElement('p'); p.textContent = `${name(k)}: ${text}`; $('chat').append(p);
    $('chat').scrollTop = $('chat').scrollHeight;
  }
  function revealMine(){
    const target = Math.min(privateThoughts.length, Math.floor(S.p * privateThoughts.length / .9));
    while (revealed < target){
      const index = revealed++, text = privateThoughts[index]; reveal(me,text); send({type:'thought',round,index,text});
    }
  }
  function paintState(){
    const total = scores.A + scores.B;
    S.p = total / TOTAL; m = total ? scores.A / total : .5;
    revealMine();
    if (total === TOTAL){
      phase = 'done'; S.playing = false; S.k = 1; ready = {A:false,B:false};
      status(scores.A === scores.B ? 'Нічия! Палочку поділено порівну ♥' : `${name(scores.A > scores.B ? 'A' : 'B')} з’їдає більше! ♥`);
    }
    for (const k of ['A','B']) $('combo'+k).textContent = combos[k] >= 20 ? `Комбо ×${combos[k]}` : '';
    render(); kick(); controls();
  }
  function acceptClick(k){
    if (phase !== 'playing' || scores.A + scores.B >= TOTAL) return;
    const now = performance.now();
    combos[k] = now - lastClick[k] <= COMBO_GAP ? combos[k] + 1 : 1;
    lastClick[k] = now; scores[k]++;
    const edge = edges()[k === 'A' ? 0 : 1]; for(let i=0;i<3;i++) crumb(k,edge); crunch(k,m); // Exactly one bite: combos never multiply it.
    paintState();
    send({type:'state',round,scores,combos});
  }
  function bite(){
    if (phase !== 'playing') return;
    initAudio();
    if (host) acceptClick(me); else send({type:'click',round,seq:++seq});
  }
  function releaseGuest(text){
    if (!host){ disconnect(text); return; }
    clearInterval(heartbeat); clearTimeout(timeout);
    const previous = conn; conn = null; connected = false;
    previous?.close(); phase = 'lobby'; ready = {A:false,B:false};
    clearRound();
    applyProfile('B',{name:'B',color:'#7aa8ff',kao:'',flip:false,avatar:''});
    status(text); controls();
  }
  function disconnect(text){
    clearInterval(timer); clearInterval(heartbeat); clearTimeout(timeout);
    phase = 'lobby'; connected = false; roomOpen = false; ready = {A:false,B:false};
    S.playing = false;
    const c = conn, previousPeer = peer; conn = null; peer = null;
    c?.close(); previousPeer?.destroy();
    $('createRoom').disabled = $('joinRoom').disabled = false;
    $('roomCode').textContent = ''; $('leave').hidden = true; status(text); controls();
  }
  function watchConnection(c){
    clearInterval(heartbeat); lastSeen = Date.now();
    heartbeat = setInterval(()=>{
      if(conn !== c) return;
      if(Date.now() - lastSeen >= PEER_TIMEOUT){
        releaseGuest('Партнер не відповідає 15 секунд. Місце звільнено.'); return;
      }
      if(c.open) c.send({type:'ping'});
    },1000);
  }
  function attach(c){
    if (conn && Date.now()-lastSeen >= PEER_TIMEOUT) releaseGuest('Місце звільнено.');
    if (conn){ c.on('open',()=>{c.send({type:'full'}); setTimeout(()=>c.close(),200);}); return; }
    conn = c; watchConnection(c);
    c.on('open',()=>{
      if(conn !== c){c.close(); return;}
      lastSeen = Date.now();
      clearTimeout(timeout); connected = true; status('Ви удвох! Налаштуйте персонажів і натисніть «Готово».');
      send({type:'profile',profile:profile()}); controls();
    });
    c.on('data',data=>{
      if (!data || typeof data !== 'object' || conn !== c) return;
      lastSeen = Date.now();
      if(data.type === 'ping'){send({type:'pong'});return;}
      if(data.type === 'pong') return;
      if(data.type === 'leave'){releaseGuest('Партнер вийшов. Чекаємо нового гравця за тим самим кодом.');return;}
      if(data.type === 'kicked' && !host){disconnect('Власник кімнати від’єднав вас.');return;}
      if (data.type === 'full'){ disconnect('Кімната вже зайнята.'); return; }
      if (data.type === 'profile' && ['lobby','done'].includes(phase)) applyProfile(other(),data.profile);
      if (data.type === 'ready' && ['lobby','done'].includes(phase)){
        applyProfile(other(),data.profile); ready[other()] = true; controls(); startIfReady();
      }
      if (data.type === 'start' && !host && ready[me] && Number.isInteger(data.round) && data.round > round) begin(data.round);
      if (data.round !== round) return;
      if (data.type === 'click' && host && Number.isInteger(data.seq) && data.seq > receivedSeq){receivedSeq = data.seq; acceptClick('B');}
      if (data.type === 'state' && !host && ['playing','countdown'].includes(phase)){
        const s = data.scores, c = data.combos;
        if (!s || !c || !['A','B'].every(k=>Number.isInteger(s[k]) && s[k]>=scores[k] && Number.isInteger(c[k]) && c[k]>=0 && c[k]<=s[k]) || s.A+s.B > TOTAL) return;
        for(const k of ['A','B']) if(s[k]>scores[k]){const edge=edges()[k==='A'?0:1]; for(let i=0;i<3;i++) crumb(k,edge); crunch(k,m);}
        scores = s; combos = c; paintState();
      }
      if (data.type === 'thought' && ['playing','done'].includes(phase) && data.index === thoughts[other()].length && data.index < 5 && typeof data.text === 'string'){
        reveal(other(),data.text.slice(0,100)); render();
      }
    });
    c.on('close',()=>{if(conn===c) releaseGuest('Партнер від’єднався. Місце вільне.');});
    c.on('error',()=>{if(conn===c) releaseGuest('З’єднання перервано. Місце вільне.');});
  }
  function connect(isHost){
    const code = $('joinCode').value.trim().toUpperCase();
    if (!isHost && !/^[A-Z2-9]{8}$/.test(code)){status('Введіть код кімнати з 8 символів.');return;}
    if (!window.Peer){status('Не вдалося завантажити модуль з’єднання. Оновіть сторінку.');return;}
    round = 0; host = isHost; selectSide(host?'A':'B'); phase = 'lobby'; clearRound();
    $('createRoom').disabled = $('joinRoom').disabled = true; $('leave').hidden = false; status('З’єднуємося…');
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const room = host ? Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>chars[n%32]).join('') : code;
    peer = new Peer(host ? 'pepero-duo-'+room : undefined);
    const activePeer = peer;
    timeout = setTimeout(()=>disconnect('Не вдалося з’єднатися. Перевірте код та інтернет і спробуйте ще раз.'),20000);
    peer.on('open',()=>{
      if(peer !== activePeer) return;
      roomOpen = true; controls();
      $('roomCode').textContent = room;
      if (host){clearTimeout(timeout); status('Надішліть код партнеру. Чекаємо на підключення…');}
      else attach(peer.connect('pepero-duo-'+room,{reliable:true}));
    });
    peer.on('connection',c=>{if(peer !== activePeer){c.close();return;} if(host) attach(c); else c.close();});
    peer.on('error',()=>{if(peer === activePeer) disconnect('Не вдалося підключитися. Перевірте код кімнати або створіть нову.');});
    peer.on('disconnected',()=>{ if (peer === activePeer && !connected) disconnect('Сервіс кімнат недоступний. Спробуйте ще раз.'); });
  }
  // Keep the original artwork, particle effects and final kiss; progress comes only from accepted clicks.
  simStep = dt => {
    S.t += dt; if(S.popped) S.hopT += dt;
    if (host && phase === 'playing') for (const k of ['A','B']) {
      if(combos[k] && performance.now()-lastClick[k] > COMBO_GAP){combos[k]=0; send({type:'state',round,scores,combos});}
    }
    for (const k of ['A','B']) $('combo'+k).textContent = combos[k]>=20 ? `Комбо ×${combos[k]}` : '';
    stepParticles(dt); render();
  };
  // Only revealed messages enter these arrays; drafts stay on the author's device.
  updateThoughts = k => {
    const layer = $('th'+k), signature = JSON.stringify([thoughts[k],W,H,ch]);
    if(layer.dataset.messages === signature) return;
    layer.dataset.messages = signature; layer.replaceChildren();
    const recent = thoughts[k].slice(-2);
    const mobile = W <= 620, top = 72;
    const charTop = H - FLOOR - ch - 14;
    const bubbleHeight = Math.max(16, Math.min(mobile ? 40 : 44, Math.floor((charTop - 28 - top - 14) / 2)));
    recent.forEach((text,i)=>{
      const b=makeBubble(); b.firstElementChild.textContent=text;
      Object.assign(b.style,{left:k==='A'?'3%':'53%',top:(top+i*(bubbleHeight+14))+'px',width:'44%',padding:mobile?'5px 7px':'6px 10px',fontSize:mobile?'11px':'12px',lineHeight:'1.25',whiteSpace:'normal',height:bubbleHeight+'px',minHeight:'0'});
      Object.assign(b.firstElementChild.style,{display:'-webkit-box',WebkitBoxOrient:'vertical',WebkitLineClamp:'2',overflow:'hidden',overflowWrap:'anywhere'});
      layer.append(b);
    });
  };
  $('createRoom').onclick = ()=>connect(true); $('joinRoom').onclick = ()=>connect(false);
  $('leave').onclick = ()=>{send({type:'leave'}); disconnect('Ви вийшли з кімнати.');};
  $('kickGuest').onclick = ()=>{
    if(!host || !connected) return;
    send({type:'kicked'});
    const kicked = conn;
    // Let the notification leave the reliable channel before closing it.
    setTimeout(()=>{if(conn === kicked) releaseGuest('Гравця від’єднано. Запросіть іншого за тим самим кодом.');},150);
  };
  window.addEventListener('pagehide',()=>{send({type:'leave'}); disconnect('Ви вийшли з кімнати.');});
  $('ready').onclick = ()=>{
    if(!connected || !['lobby','done'].includes(phase) || ready[me])return;
    initAudio(); ready[me]=true; send({type:'ready',profile:profile()}); controls(); startIfReady();
  };
  $('bite').onclick = bite;
  $('bite').onkeydown = e=>{if(e.repeat && (e.code==='Space'||e.code==='Enter')) e.preventDefault();};
  document.querySelector('.panel').addEventListener('input',e=>{
    if(e.target.type !== 'file' && !e.target.id.startsWith('ti')) send({type:'profile',profile:profile()});
  });
  document.querySelector('.panel').addEventListener('click',e=>{
    if(e.target.closest('#sw'+me+' .sw')){ownAvatar=''; send({type:'profile',profile:profile()});}
  });
  for (const k of ['A','B']){
    $('flip'+k).onchange = e=>{
      flip[k] = e.target.checked; render();
      if(k === me) send({type:'profile',profile:profile()});
    };
    $('ti'+k).addEventListener('input',()=>{thoughts.A=[]; thoughts.B=[]; S.lay={}; render();});
    $('hc'+k).addEventListener('input',()=>{ownAvatar='';send({type:'profile',profile:profile()});});
    $('kao'+k).addEventListener('input',()=>{ownAvatar='';send({type:'profile',profile:profile()});});
    $('file'+k).onchange = async e=>{
      const file=e.target.files[0]; if(!file)return;
      if(!file.type.startsWith('image/') || file.size>15*1024*1024){status('Оберіть зображення до 15 МБ.');return;}
      $('ready').disabled=true;
      try {
        const im=await createImageBitmap(file), scale=Math.min(1,256/Math.max(im.width,im.height));
        const cv=document.createElement('canvas'); cv.width=Math.max(1,Math.round(im.width*scale)); cv.height=Math.max(1,Math.round(im.height*scale));
        cv.getContext('2d').drawImage(im,0,0,cv.width,cv.height); im.close();
        // PNG is supported by all canvas encoders, including iOS; preserve transparency.
        ownAvatar=cv.toDataURL('image/png');
        if(ownAvatar.length >= 300000){
          const small=document.createElement('canvas'); small.width=Math.max(1,Math.round(cv.width*.75)); small.height=Math.max(1,Math.round(cv.height*.75));
          small.getContext('2d').drawImage(cv,0,0,small.width,small.height); ownAvatar=small.toDataURL('image/png');
        } custom[me]=true; $('img'+me).src=ownAvatar;
        send({type:'profile',profile:profile()});
      } catch {status('Не вдалося прочитати зображення. Спробуйте PNG, JPEG або WebP.');}
      controls();
    };
  }
  selectSide('A'); controls();
})();
