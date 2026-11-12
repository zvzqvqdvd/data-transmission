/* room.js — 房间运行时
 * 只有一种房间：房间码前端生成、消息与文件只存房主内存、生命周期由房主页面管理。
 * 外网访客走 PeerJS；局域网设备走本机程序的内存转发桥（断外网也能用）。
 */
'use strict';

/* ================= 数据源 ================= */
function messagesOf(){ return MODE === 'host' ? (STORE ? STORE.messages : []) : GUEST_MESSAGES; }
function myName(){ return MY_NAME || (MODE === 'host' ? '房主' : '访客'); }
function isHost(){ return MODE === 'host'; }

function pushSystem(text){
  const arr = messagesOf();
  arr.push({ id:uid('m'), kind:'system', from:'', name:'', text, ts:Date.now() });
  renderMessages();
}

function addTextMessage(from, name, text, ts){
  const m = { id:uid('m'), kind:'text', from, name, text, ts: ts || Date.now() };
  if (isHost()) STORE.add(m); else GUEST_MESSAGES.push(m);
  noteActivity();
  return m;
}
function addFileMessage(from, name, meta, ts, expired){
  const m = {
    id:uid('m'), kind:'file', from, name, text:'',
    file:{ id:meta.id, name:meta.name, size:meta.size, type:meta.type || '' },
    ts: ts || Date.now(), expired: !!expired
  };
  if (isHost()) { STORE.add(m); STORE.putFile(meta); }
  else GUEST_MESSAGES.push(m);
  noteActivity();
  return m;
}
function messageByFileId(id){
  return messagesOf().find(m => m.kind === 'file' && m.file && m.file.id === id) || null;
}

/* ================= 渲染 ================= */
function renderMessages(){
  const box = $('msgList');
  if (!box) return;
  const list = messagesOf();
  box.innerHTML = list.map(m => {
    if (m.kind === 'system') return '<div class="bub sys">' + esc(m.text) + '</div>';
    const mine = m.from === MY_ID || (isHost() && m.from === 'host');
    const who = '<span class="who">' + esc(m.name || '设备') + ' · ' + fmtClock(m.ts) + '</span>';
    if (m.kind === 'text') {
      return '<div class="bub' + (mine ? ' me' : '') + '">' + who + esc(m.text) + '</div>';
    }
    const f = m.file || { name:'文件', size:0 };
    const dead = !!m.expired || (isHost() && (!STORE.file(f.id) || !STORE.file(f.id).data));
    return '<div class="filecard' + (mine ? ' me' : '') + '">' +
      '<span class="ext">' + esc(extOf(f.name)) + '</span>' +
      '<span class="fmeta"><span class="fn">' + esc(f.name) + '</span>' +
        '<span class="fs">' + fmtSize(f.size) + (dead ? ' · <span class="expired">文件已失效，需重新发送</span>' : '') + '</span></span>' +
      '<button class="dl" data-file="' + esc(f.id) + '"' + (dead ? ' disabled' : '') + '>下载</button></div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function renderMembers(){
  const box = $('memberList');
  if (!box) return;
  const names = [myName() + (isHost() ? '（房主）' : '')];
  for (const [id, m] of MEMBERS) if (id !== MY_ID) names.push(esc(m.name || '设备'));
  box.innerHTML = names.map(n => '<div>· ' + n + '</div>').join('');
  const oc = $('onlineCount');
  if (oc) oc.textContent = '在线 ' + (1 + MEMBERS.size) + ' 台';
}
function updateElapsed(){
  const el = $('roomElapsed');
  if (el && STARTED_AT) el.textContent = '已开 ' + fmtElapsed(Date.now() - STARTED_AT);
  const idle = $('composerTip');
  if (idle && LAST_ACTIVITY) {
    const left = Math.max(0, IDLE_LIMIT - (Date.now() - LAST_ACTIVITY));
    idle.textContent = '房间将在 ' + Math.ceil(left / 60000) + ' 分钟无人通信后自动销毁';
  }
}
function updateQr(){
  if (!ROOM) return;
  qrInto($('inviteQr'), inviteUrl(ROOM));
  if (LAN_READY && LAN_ADDR) qrInto($('lanQr'), lanInviteUrl(ROOM, LAN_ADDR));
}
function updateSide(){
  const code = $('sideRoomCode'), top = $('topRoom');
  if (code) code.textContent = ROOM || '----------';
  if (top) top.textContent = ROOM ? '· ' + ROOM : '';
  const addr = $('lanAddr');
  if (addr) addr.textContent = LAN_READY && LAN_ADDR ? LAN_ADDR : '-';
  applyLanVisibility(LAN_ON);
  updateQr();
  renderMembers();
}

/* ================= 房间启动 ================= */
function initRoomView(){
  showRoom();
  updateSide();
  renderMessages();
  bindRoomUI();
  if (STARTED_AT) updateElapsed();
}
function bindRoomUI(){
  const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  bind('btnSend', 'click', () => sendTextNow());
  bind('textInput', 'keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextNow(); }
  });
  bind('btnFile', 'click', () => { const f = $('fileInput'); if (f) f.click(); });
  bind('fileInput', 'change', e => { if (e.target.files && e.target.files.length) sendPickedFiles(e.target.files); e.target.value = ''; });
  bind('btnCopyCode', 'click', async () => { toast(await copyText(ROOM) ? '房间号已复制' : '复制失败，请手动选择'); });
  bind('btnCopyLink', 'click', async () => { toast(await copyText(inviteUrl(ROOM)) ? '邀请链接已复制' : '复制失败'); });
  bind('sideRoomCode', 'click', async () => { toast(await copyText(ROOM) ? '房间号已复制' : '复制失败'); });
  bind('btnDestroy', 'click', () => { const c = $('destroyCode'); if (c) c.textContent = ROOM; openModal('modalDestroy'); });
  bind('destroyGoBtn', 'click', () => { closeModals(); destroy('manual'); });
  bind('btnHelp', 'click', () => openModal('modalHelp'));
  bind('btnNet', 'click', () => { fillTurnForm(); openModal('modalNet'); });
  bind('turnSaveBtn', 'click', saveTurnForm);
  bind('turnClearBtn', 'click', () => { saveTurn(null); fillTurnForm(); toast('已清除自定义 TURN'); });
  bind('btnScreen', 'click', startScreenShare);
  bind('btnStopScreen', 'click', stopScreenShare);
  bind('btnExitFull', 'click', () => { const f = $('fullLayer'); if (f) f.hidden = true; });
  bind('msgList', 'click', e => {
    const b = e.target.closest && e.target.closest('[data-file]');
    if (b && !b.disabled) downloadFile(b.getAttribute('data-file'));
  });
  document.querySelectorAll('.modal [data-close]').forEach(el => el.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(el => el.addEventListener('click', e => {
    if (e.target === el) closeModals();
  }));
}
function fillTurnForm(){
  const c = loadTurn() || {};
  if ($('turnUrl')) $('turnUrl').value = c.urls || '';
  if ($('turnUser')) $('turnUser').value = c.username || '';
  if ($('turnPass')) $('turnPass').value = c.credential || '';
}
function saveTurnForm(){
  const urls = ($('turnUrl') && $('turnUrl').value || '').trim();
  if (!urls) { saveTurn(null); toast('未填写，已使用默认 STUN'); closeModals(); return; }
  saveTurn({ urls, username:($('turnUser') && $('turnUser').value || '').trim(),
             credential:($('turnPass') && $('turnPass').value || '').trim() });
  toast('已保存，重新进入房间后生效');
  closeModals();
}

/* ---- Peer 实例 ---- */
function openPeer(id){
  return new Promise((resolve, reject) => {
    let peer;
    try { peer = new Peer(id, peerOptions()); }
    catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { peer.destroy(); } catch (e2) {} reject(new Error('信令连接超时')); }, 12000);
    peer.on('open', () => { clearTimeout(timer); resolve(peer); });
    peer.on('error', err => {
      clearTimeout(timer);
      if (String(err && err.type) === 'unavailable-id') reject(Object.assign(new Error('unavailable-id'), { type:'unavailable-id' }));
      else reject(err);
    });
  });
}
async function openHostPeerRetry(room){
  // 刷新恢复时绝不换码：unavailable-id 只重试等待
  const id = 'pc-' + room;
  for (let i = 0; i < 4; i++) {
    try { return await openPeer(id); }
    catch (e) {
      if (e && e.type === 'unavailable-id') { await new Promise(r => setTimeout(r, 900)); continue; }
      throw e;
    }
  }
  throw new Error('房主 ID 仍被占用，请稍后重试');
}

/* ---- 房主 ---- */
async function startHost(room, opts){
  MODE = 'host'; ROOM = room; DESTROYED = false;
  opts = opts || {};
  LAN_ON = !!opts.lanOn;
  LAN_READY = !!opts.lanReady;
  LAN_ADDR = opts.lanAddr || '';
  MY_ID = 'host'; MY_NAME = '房主';
  STORE = new MemoryStore();
  if (opts.messages) for (const m of opts.messages) STORE.add(m);
  STARTED_AT = opts.startedAt || Date.now();
  LAST_ACTIVITY = opts.lastActivity || Date.now();
  MEMBERS.clear();
  if (opts.members) for (const [k, v] of opts.members) MEMBERS.set(k, v);

  let peer;
  try { peer = await openHostPeerRetry(room); }
  catch (e) { toast('外网通道未就绪：' + e.message + '（仍可继续使用）'); peer = null; }
  PEER = peer;
  if (peer) attachPeerEvents(true);

  initRoomView();
  startWatchdog();
  startElapsed();
  saveSnapshot();
  if (LAN_ON && LAN_READY) startHostBridge();
  if (opts.restored) {
    // 会话快照恢复：文本历史全量保留，文件二进制无法跨刷新，全部标失效
    for (const m of STORE.messages) if (m.kind === 'file') m.expired = true;
    renderMessages();
    pushSystem('已恢复房间，刷新前的文件需重新发送');
  } else {
    pushSystem('房间 ' + ROOM + ' 已创建' + (LAN_ON ? '（已开启局域网接入）' : '（纯外网）'));
  }
  try { history.replaceState(null, '', location.pathname + '?host=1'); } catch (e) {}
}

/* ---- 外网访客 ---- */
async function startGuest(room){
  MODE = 'guest'; ROOM = room; DESTROYED = false;
  MY_ID = uid('g'); MY_NAME = '访客-' + MY_ID.slice(-4).toUpperCase();
  GUEST_MESSAGES = [];
  STARTED_AT = Date.now(); LAST_ACTIVITY = Date.now();
  MEMBERS.clear();
  try { PEER = await openPeer(MY_ID); attachPeerEvents(false); }
  catch (e) { guestConnectFailed(e.message); return; }
  initRoomView();
  startElapsed();
  connectToHost();
  pushSystem('正在连接房间 ' + ROOM + '…');
}
function connectToHost(){
  if (MODE !== 'guest' || !PEER || DESTROYED) return;
  const conn = PEER.connect('pc-' + ROOM, { reliable:true });
  HOST_CONN = conn;
  wireConn(conn, false);
  conn.on('open', () => {
    GRACE_DEADLINE = 0;
    sendMsg(conn, MSG.HELLO, { id:MY_ID, name:MY_NAME });
    pushSystem('已加入房间 ' + ROOM);
    try { sessionStorage.setItem('v2.join.room', ROOM); } catch (e) {}
  });
  conn.on('close', guestDisconnected);
  conn.on('error', () => {});
}
function guestConnectFailed(msg){
  gateView('gateChoices'); showGate();
  gateMsg('连接失败：' + msg + '，请确认房间号或稍后重试', 'err');
}
function guestDisconnected(){
  if (DESTROYED || MODE !== 'guest') return;
  if (!GRACE_DEADLINE) {
    GRACE_DEADLINE = Date.now() + GRACE_LIMIT;
    pushSystem('房主暂时断开，60 秒内等待重连…');
  }
  if (Date.now() >= GRACE_DEADLINE) { guestRoomClosed('房间已关闭'); return; }
  RECONNECT_TIMER = later(() => {
    if (DESTROYED || MODE !== 'guest') return;
    if (HOST_CONN && HOST_CONN.open) return;
    try { if (HOST_CONN) HOST_CONN.close(); } catch (e) {}
    connectToHost();
    guestDisconnected();
  }, 2500);
}
function guestRoomClosed(reason){
  clearGuestLocal();
  showGate(); gateView('gateChoices');
  setGateHeader('数据传输', '打开网页就能开房间，无需安装任何东西',
    '房间是临时的：关闭房主页面或 30 分钟无人通信自动销毁<br>销毁时聊天记录与文件从所有设备一并清除');
  gateMsg(reason + '，聊天记录已清除。请向房主确认新房号。', 'warn');
}

/* ================= PeerJS 事件 ================= */
function attachPeerEvents(host){
  if (!PEER) return;
  PEER.on('connection', conn => {
    if (!isHost() || DESTROYED) { try { conn.close(); } catch (e) {} return; }
    wireConn(conn, true);
  });
  PEER.on('call', onIncomingCall);
  PEER.on('error', err => {
    const t = String(err && err.type);
    if (t === 'unavailable-id' || t === 'peer-unavailable') return;
    console.warn('[peer]', err && err.message || err);
  });
  PEER.on('disconnected', () => {
    if (!DESTROYED && PEER && !PEER.destroyed) { try { PEER.reconnect(); } catch (e) {} }
  });
}
function wireConn(conn, host){
  conn.on('data', raw => onConnData(conn, raw));
  conn.on('open', () => {
    if (host) {
      CONNS.set(conn.peer, { conn, name:'设备', isLan:false });
      MEMBERS.set(conn.peer, { name:'设备', role:'guest', lastSeen:Date.now() });
    }
  });
  conn.on('close', () => {
    CONNS.delete(conn.peer);
    MEMBERS.delete(conn.peer);
    if (isHost()) { renderMembers(); broadcast(MSG.PEERS, { members:memberList() }); }
  });
  conn.on('error', () => {});
}
function memberList(){
  const out = [{ id:'host', name:'房主', role:'host' }];
  for (const [id, m] of MEMBERS) out.push({ id, name:m.name, role:m.role || 'guest' });
  return out;
}
function onConnData(conn, raw){
  if (DESTROYED) return;
  const o = parseMsg(raw);
  if (o) { handleProtocol(conn, o); return; }
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw) || (raw && raw.byteLength !== undefined)) {
    onFileChunk(conn, raw);
  }
}
function handleProtocol(conn, o){
  const d = o.d || {};
  switch (o.t) {
    case MSG.HELLO:
      if (!isHost()) return;
      MEMBERS.set(conn.peer, { name: d.name || '设备', role:'guest', lastSeen:Date.now() });
      const rec = CONNS.get(conn.peer);
      if (rec) rec.name = d.name || '设备';
      sendMsg(conn, MSG.WELCOME, { id:'host', name:'房主', members:memberList() });
      sendMsg(conn, MSG.HISTORY, { messages: STORE.messages.map(publicMessage) });
      broadcast(MSG.PEERS, { members:memberList() }, conn.peer);
      noteActivity(); renderMembers(); renderMessages();
      break;
    case MSG.WELCOME:
      MY_NAME = d.name || MY_NAME;
      if (Array.isArray(d.members)) for (const m of d.members) if (m.id !== 'host' && m.id !== MY_ID) MEMBERS.set(m.id, m);
      renderMembers();
      break;
    case MSG.HISTORY:
      if (isHost() || !Array.isArray(d.messages)) return;
      GUEST_MESSAGES = d.messages.map(publicMessage).filter(Boolean);
      renderMessages();
      break;
    case MSG.PEERS:
      if (!Array.isArray(d.members)) return;
      MEMBERS.clear();
      for (const m of d.members) if (m.id !== MY_ID && m.id !== 'host') MEMBERS.set(m.id, m);
      renderMembers();
      break;
    case MSG.TEXT: {
      const m = addTextMessage(d.from || conn.peer, d.name || '设备', String(d.text || ''), d.ts);
      renderMessages();
      if (isHost()) { broadcast(MSG.TEXT, publicMessage(m), conn.peer); bridgePush([publicMessage(m)]); }
      break;
    }
    case MSG.FILE_CARD: {
      const f = d.file || {};
      const m = addFileMessage(d.from || conn.peer, d.name || '设备', f, d.ts, false);
      renderMessages();
      if (isHost()) { broadcast(MSG.FILE_CARD, publicMessage(m), conn.peer); bridgePush([publicMessage(m)]); }
      break;
    }
    case MSG.FILE_PULL:
      if (!isHost()) return;
      serveFileTo(conn, String(d.id || ''));
      break;
    case MSG.FILE_PULL_ERR:
      toast('文件已失效：' + (d.msg || '请让对方重新发送'));
      break;
    case MSG.FILE_META:
      onFileMeta(conn, d);
      break;
    case MSG.FILE_END:
      onFileEnd(conn, d);
      break;
    case MSG.PING: sendMsg(conn, MSG.PONG, {}); break;
    case MSG.PONG: break;
    case MSG.BYE:
      CONNS.delete(conn.peer); MEMBERS.delete(conn.peer); renderMembers();
      break;
    case MSG.SCREEN_STOP:
      stopScreenShare(true);
      break;
    case MSG.ROOM_CLOSED:
      guestRoomClosed('房间已关闭');
      destroyGuestSide();
      break;
    default: break;
  }
}
function publicMessage(m){
  return {
    id:m.id, kind:m.kind, from:m.from, name:m.name, text:m.text,
    file: m.file ? { id:m.file.id, name:m.file.name, size:m.file.size, type:m.file.type } : null,
    ts:m.ts, expired: !!(m.expired || (m.kind === 'file' && isHost() && (!STORE.file(m.file.id) || !STORE.file(m.file.id).data)))
  };
}

/* ================= 文本发送 ================= */
function sendTextNow(){
  const ta = $('textInput');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  if (isHost()) {
    const m = addTextMessage('host', '房主', text);
    renderMessages();
    broadcast(MSG.TEXT, publicMessage(m));
    bridgePush([publicMessage(m)]);
  } else if (MODE === 'lan') {
    lanSendText(text);
  } else if (HOST_CONN && HOST_CONN.open) {
    const m = addTextMessage(MY_ID, MY_NAME, text);
    renderMessages();
    sendMsg(HOST_CONN, MSG.TEXT, publicMessage(m));
  } else {
    toast('尚未连接房主，请稍候');
  }
}

/* ================= 文件：分片 / 按需拉取 ================= */
function sendPickedFiles(list){
  for (const f of Array.from(list)) sendOneFile(f);
}
async function sendOneFile(file){
  const meta = { id:uid('f'), name:file.name, size:file.size, type:file.type || '' };
  if (isHost()) {
    const m = addFileMessage('host', '房主', Object.assign({}, meta, { data:file }));
    renderMessages();
    broadcast(MSG.FILE_CARD, publicMessage(m));
    bridgeUploadFile(meta.id, file);
    toast('已发送文件：' + file.name);
  } else if (MODE === 'lan') {
    await lanUploadFile(meta, file);
    toast('已发送文件：' + file.name);
  } else if (HOST_CONN && HOST_CONN.open) {
    renderQueue(meta.id, file.name, 0);
    await sendFileChunks(HOST_CONN, meta, file, true);
    renderQueueDone(meta.id);
    toast('已发送文件：' + file.name);
  } else {
    toast('尚未连接房主，请稍候');
  }
}
async function sendFileChunks(conn, meta, blob, guestUpload){
  if (!conn || !conn.open) return;
  const total = Math.ceil((blob.size || 0) / CHUNK_SIZE) || 1;
  await sendMsg(conn, MSG.FILE_META, Object.assign({}, meta, { total, upload:!!guestUpload }));
  for (let i = 0; i < total; i++) {
    const buf = await blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
    await queueConnSend(conn, buf);
    renderQueue(meta.id, meta.name, Math.round((i + 1) / total * 100));
  }
  await sendMsg(conn, MSG.FILE_END, { id:meta.id });
}
function renderQueue(id, name, pct){
  const box = $('queueList');
  if (!box) return;
  let item = box.querySelector('[data-q="' + id + '"]');
  if (!item) {
    item = document.createElement('div');
    item.className = 'qitem'; item.setAttribute('data-q', id);
    box.appendChild(item);
  }
  item.innerHTML = esc(name) + ' · ' + pct + '%<span class="qbar"><i style="width:' + pct + '%"></i></span>';
}
function renderQueueDone(id){
  later(() => {
    const item = $('queueList') && $('queueList').querySelector('[data-q="' + id + '"]');
    if (item) item.remove();
  }, 1200);
}
function onFileMeta(conn, d){
  FILE_INFLIGHT.set(conn.peer + ':' + d.id, {
    chunks:[], got:0, total:Number(d.total) || 0,
    name:d.name, size:Number(d.size) || 0, type:d.type || '', upload:!!d.upload, id:d.id, from:conn.peer
  });
}
function onFileChunk(conn, raw){
  const keys = Array.from(FILE_INFLIGHT.keys()).filter(k => k.startsWith(conn.peer + ':'));
  const key = keys[keys.length - 1];
  if (!key) return;
  const st = FILE_INFLIGHT.get(key);
  const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) :
              (ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null);
  if (!buf) return;
  st.chunks.push(buf); st.got += buf.byteLength;
  renderQueue(st.id, st.name, st.total ? Math.min(99, Math.round(st.chunks.length / st.total * 100)) : 50);
}
function onFileEnd(conn, d){
  const key = conn.peer + ':' + d.id;
  const st = FILE_INFLIGHT.get(key);
  if (!st) return;
  FILE_INFLIGHT.delete(key);
  const blob = new Blob(st.chunks, { type:st.type || 'application/octet-stream' });
  renderQueueDone(st.id);
  if (st.upload && isHost()) {
    // 访客上传：房主内存成为唯一权威，再广播文件卡给所有人
    const meta = { id:st.id, name:st.name, size:blob.size, type:st.type, data:blob };
    const m = addFileMessage(st.from, memberName(st.from), meta);
    renderMessages();
    broadcast(MSG.FILE_CARD, publicMessage(m), conn.peer);
    bridgePush([publicMessage(m)]);
    bridgeUploadFile(st.id, blob);
  } else if (!isHost()) {
    // 访客按需拉取完成：直接落盘到自己的下载目录
    triggerDownload(blob, st.name);
  }
}
function memberName(id){
  const m = MEMBERS.get(id);
  return m ? m.name : '设备';
}
function triggerDownload(blob, name){
  const u = objectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name || 'file'; a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); } catch (e) {}
  later(() => { try { a.remove(); } catch (e) {} }, 4000);
}
function downloadFile(id){
  if (MODE === 'lan') { lanDownloadFile(id); return; }
  if (isHost()) {
    const f = STORE.file(id);
    if (!f || !f.data) { toast('文件已失效，需重新发送'); return; }
    triggerDownload(f.data, f.name);
  } else if (HOST_CONN && HOST_CONN.open) {
    sendMsg(HOST_CONN, MSG.FILE_PULL, { id });
    toast('正在从房主拉取文件…');
  } else {
    toast('尚未连接房主，请稍候');
  }
}
async function serveFileTo(conn, id){
  const f = STORE.file(id);
  if (!f || !f.data) { await sendMsg(conn, MSG.FILE_PULL_ERR, { id, msg:'房主刷新后文件已失效，需重新发送' }); return; }
  await sendFileChunks(conn, { id:f.id, name:f.name, size:f.size, type:f.type }, f.data, false);
}

/* ================= 屏幕共享 ================= */
async function startScreenShare(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('当前环境不支持屏幕共享（http 局域网地址下不可用）'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:{ frameRate:30 }, audio:false });
    CALL_STATE.stream = stream;
    const card = $('screenCard'), v = $('screenVideo');
    if (card) card.hidden = false;
    if (v) { v.srcObject = stream; v.muted = true; }
    const targets = isHost() ? Array.from(CONNS.keys()) : ['pc-' + ROOM];
    for (const t of targets) {
      if (PEER && t) { try { CALL_STATE.call = PEER.call(t, stream); } catch (e) {} }
    }
    stream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare());
    toast('已开始共享屏幕');
  } catch (e) { toast('已取消或无法共享屏幕'); }
}
function stopScreenShare(silent){
  if (CALL_STATE.stream) {
    try { CALL_STATE.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    CALL_STATE.stream = null;
  }
  if (CALL_STATE.call) { try { CALL_STATE.call.close(); } catch (e) {} CALL_STATE.call = null; }
  const card = $('screenCard'); if (card) card.hidden = true;
  const full = $('fullLayer'); if (full) full.hidden = true;
  const v = $('screenVideo'); if (v) v.srcObject = null;
  if (!silent) {
    if (isHost()) broadcast(MSG.SCREEN_STOP, {});
    else if (HOST_CONN && HOST_CONN.open) sendMsg(HOST_CONN, MSG.SCREEN_STOP, {});
  }
}
function onIncomingCall(call){
  if (!PEER) return;
  try {
    call.answer();
    call.on('stream', stream => {
      const card = $('screenCard'), v = $('screenVideo');
      if (card) card.hidden = false;
      if (v) { v.srcObject = stream; v.muted = false; }
      const full = $('fullVideo');
      if (full) full.srcObject = stream;
      toast('收到对方的屏幕共享');
    });
    call.on('close', () => stopScreenShare(true));
  } catch (e) {}
}

/* ================= 生命周期 ================= */
function startWatchdog(){
  every(() => {
    if (DESTROYED || !isHost()) return;
    updateElapsed();
    if (idleExpired()) destroy('idle');
  }, 1000);
}
function startElapsed(){
  every(() => {
    if (DESTROYED) return;
    updateElapsed();
    if (MODE === 'guest' && GRACE_DEADLINE && Date.now() >= GRACE_DEADLINE &&
        (!HOST_CONN || !HOST_CONN.open)) guestRoomClosed('房间已关闭');
  }, 1000);
}
function destroyGuestSide(){
  GUEST_MESSAGES = [];
  FILE_INFLIGHT.clear();
  revokeAllObjectURLs();
  const box = $('msgList'); if (box) box.innerHTML = '';
  const q = $('queueList'); if (q) q.innerHTML = '';
  try { sessionStorage.removeItem('v2.join.room'); } catch (e) {}
  if (HOST_CONN) { try { HOST_CONN.close(); } catch (e) {} HOST_CONN = null; }
  if (PEER) { try { PEER.destroy(); } catch (e) {} PEER = null; }
  stopScreenShare(true);
  clearAllTimers();
  MEMBERS.clear(); CONNS.clear(); SEND_QUEUES.clear();
  DESTROYED = true; MODE = ''; ROOM = '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
}
function clearGuestLocal(){
  GUEST_MESSAGES = [];
  FILE_INFLIGHT.clear();
  revokeAllObjectURLs();
  const box = $('msgList'); if (box) box.innerHTML = '';
  try { sessionStorage.removeItem('v2.join.room'); } catch (e) {}
}

/* 唯一的销毁入口：手动 / 房主关页(浏览器回收) / 30 分钟超时 / 收到 ROOM_CLOSED 都走它 */
function destroy(reason){
  if (DESTROYED) return;
  DESTROYED = true;
  if (isHost()) broadcast(MSG.ROOM_CLOSED, { reason: reason || 'manual' });
  bridgeDetach();
  stopScreenShare(true);
  clearAllTimers();
  stopTimer(RECONNECT_TIMER);
  for (const [id, c] of CONNS) { try { c.conn.close(); } catch (e) {} }
  CONNS.clear(); MEMBERS.clear(); SEND_QUEUES.clear(); FILE_INFLIGHT.clear();
  if (PEER) { try { PEER.destroy(); } catch (e) {} PEER = null; }
  if (HOST_CONN) { try { HOST_CONN.close(); } catch (e) {} HOST_CONN = null; }
  if (STORE) STORE.clear();
  STORE = null;
  GUEST_MESSAGES = [];
  revokeAllObjectURLs();
  dropSnapshot();
  try { sessionStorage.removeItem('v2.join.room'); } catch (e) {}
  const ids = ['msgList','queueList','memberList','composerTip','screenVideo'];
  for (const id of ids) { const el = $(id); if (el) { el.innerHTML = ''; if (el.srcObject) el.srcObject = null; } }
  const card = $('screenCard'); if (card) card.hidden = true;
  const full = $('fullLayer'); if (full) full.hidden = true;
  closeModals();
  LAN_ON = false; LAN_READY = false; LAN_ADDR = '';
  STARTED_AT = 0; LAST_ACTIVITY = 0; ROOM = ''; MODE = '';
  showGate(); gateView('gateChoices');
  setGateHeader('数据传输', '打开网页就能开房间，无需安装任何东西',
    '房间是临时的：关闭房主页面或 30 分钟无人通信自动销毁<br>销毁时聊天记录与文件从所有设备一并清除');
  const btn = $('lanBtn'); if (btn) { btn.classList.remove('on'); btn.textContent = '开启局域网访问'; }
  applyLanVisibility(false);
  gateMsg(reason === 'idle' ? '房间 30 分钟无人通信，已自动销毁并清除全部记录' : '房间已销毁，聊天记录与文件已从所有设备清除', 'info');
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
}

/* ================= 局域网桥（房主侧） =================
 * 本机程序只在内存里过一下数据：attach / poll / push / file / detach。
 * 局域网设备不需要外网信令，断网也能收发。
 */
let BRIDGE_REV = 0;
let BRIDGE_BUSY = false;
function bridgeUrl(path){ return HOST_API + path; }
function bridgeJson(method, path, body){
  return fetch(bridgeUrl(path), {
    method,
    headers: body ? { 'Content-Type':'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache:'no-store'
  }).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
}
function startHostBridge(){
  bridgeJson('POST', '/api/bridge/attach', { room:ROOM, addr:LAN_ADDR })
    .then(() => bridgePush(STORE.messages.map(publicMessage)))
    .catch(() => {});
  every(bridgePollOnce, BRIDGE_POLL_MS);
  updateSide();
}
function bridgePush(messages){
  if (!LAN_READY || !messages || !messages.length) return;
  bridgeJson('POST', '/api/bridge/push', { room:ROOM, messages })
    .then(j => { if (j && j.rev) BRIDGE_REV = Math.max(BRIDGE_REV, j.rev); })
    .catch(() => {});
}
async function bridgePollOnce(){
  if (DESTROYED || !isHost() || !LAN_READY || BRIDGE_BUSY) return;
  BRIDGE_BUSY = true;
  try {
    const j = await bridgeJson('GET', '/api/bridge/poll?room=' + encodeURIComponent(ROOM));
    const items = (j && j.items) || [];
    for (const it of items) {
      if (it.kind === 'text') {
        const m = addTextMessage(it.id || 'lan', it.name || '局域网设备', String(it.text || ''), it.ts);
        renderMessages();
        broadcast(MSG.TEXT, publicMessage(m));
        bridgePush([publicMessage(m)]);
      } else if (it.kind === 'file') {
        try {
          const r = await fetch(bridgeUrl('/api/bridge/file/' + encodeURIComponent(it.id)), { cache:'no-store' });
          if (r.ok) {
            const blob = await r.blob();
            const meta = { id:it.id, name:it.name, size:blob.size, type:it.type || '', data:blob };
            const m = addFileMessage(it.id, it.name || '局域网设备', meta, it.ts);
            renderMessages();
            broadcast(MSG.FILE_CARD, publicMessage(m));
            bridgePush([publicMessage(m)]);
          }
        } catch (e) {}
      }
    }
    if (j && j.count != null) {
      const el = $('lanCount');
      if (el) el.textContent = '局域网设备 ' + j.count + ' 台';
    }
  } catch (e) {}
  finally { BRIDGE_BUSY = false; }
}
async function bridgeUploadFile(id, blob){
  if (!LAN_READY) return;
  try {
    await fetch(bridgeUrl('/api/bridge/file/' + encodeURIComponent(id)), {
      method:'POST',
      headers:{ 'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(blob.name || id) },
      body:blob, cache:'no-store'
    });
  } catch (e) {}
}
function bridgeDetach(){
  if (!LAN_READY || !ROOM) return;
  try { navigator.sendBeacon && navigator.sendBeacon(bridgeUrl('/api/bridge/detach'),
    new Blob([JSON.stringify({ room:ROOM })], { type:'application/json' })); }
  catch (e) {}
  fetch(bridgeUrl('/api/bridge/detach'), { method:'POST',
    headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ room:ROOM }), keepalive:true })
    .catch(() => {});
}

/* ================= 局域网设备（走 HTTP 桥，不依赖外网） ================= */
let LAN_SINCE = 0, LAN_BUSY = false, LAN_ID = '';
async function startLanGuest(room){
  MODE = 'lan'; ROOM = room; DESTROYED = false;
  LAN_ID = uid('lan'); MY_ID = LAN_ID; MY_NAME = '局域网设备-' + LAN_ID.slice(-4);
  GUEST_MESSAGES = []; STARTED_AT = Date.now(); LAST_ACTIVITY = Date.now();
  MEMBERS.clear();
  initRoomView();
  startElapsed();
  const sb = $('btnScreen'); if (sb) sb.disabled = true;
  pushSystem('正在通过本机程序加入房间 ' + ROOM + '…');
  lanGuestLoop();
}
async function lanGuestLoop(){
  if (DESTROYED || MODE !== 'lan' || LAN_BUSY) return;
  LAN_BUSY = true;
  try {
    const r = await fetch(HOST_API + '/api/bridge/messages?room=' + encodeURIComponent(ROOM) +
      '&since=' + LAN_SINCE + '&id=' + encodeURIComponent(LAN_ID), { cache:'no-store' });
    const j = await r.json();
    if (j && j.closed) { guestRoomClosed('房间已关闭'); destroyGuestSide(); LAN_BUSY = false; return; }
    if (j && Array.isArray(j.messages) && j.messages.length) {
      for (const m of j.messages) {
        if (GUEST_MESSAGES.some(x => x.id === m.id)) continue;
        GUEST_MESSAGES.push(publicMessage(m));
      }
      renderMessages();
      noteActivity();
    }
    if (j && j.rev) LAN_SINCE = Math.max(LAN_SINCE, j.rev);
  } catch (e) {}
  finally {
    LAN_BUSY = false;
    if (!DESTROYED && MODE === 'lan') later(lanGuestLoop, 350);
  }
}
function lanSendText(text){
  const m = addTextMessage(LAN_ID, MY_NAME, text);
  renderMessages();
  fetch(HOST_API + '/api/bridge/send', { method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ room:ROOM, id:m.id, from:LAN_ID, name:MY_NAME, text, ts:m.ts }) })
    .catch(() => toast('发送失败，请确认房主页面仍在'));
}
async function lanUploadFile(meta, file){
  try {
    const r = await fetch(HOST_API + '/api/bridge/file/' + encodeURIComponent(meta.id) + '?room=' + encodeURIComponent(ROOM), {
      method:'POST', headers:{ 'Content-Type':'application/octet-stream' }, body:file });
    if (!r.ok) throw new Error('upload');
    await fetch(HOST_API + '/api/bridge/send', { method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ room:ROOM, id:uid('m'), from:LAN_ID, name:MY_NAME, kind:'file',
        file:{ id:meta.id, name:meta.name, size:meta.size, type:meta.type }, ts:Date.now() }) });
  } catch (e) { toast('文件上传失败'); }
}
function lanDownloadFile(id){
  toast('正在通过本机程序拉取文件…');
  fetch(HOST_API + '/api/bridge/file/' + encodeURIComponent(id), { cache:'no-store' })
    .then(r => { if (!r.ok) throw new Error('missing'); return r.blob(); })
    .then(blob => {
      const m = messageByFileId(id);
      triggerDownload(blob, m ? m.file.name : 'file');
    })
    .catch(() => toast('文件已失效，需重新发送'));
}
