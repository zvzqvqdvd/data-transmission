/* app.js — 公共核心：常量、内存仓库、状态、工具、P2P 配置
 * 与 room.js / gate.js 拼进同一个 script 标签，共用全局作用域，靠函数提升互相调用。
 */
'use strict';

/* ---- 构建时注入 ---- */
const PAGE_BUILD  = '__PAGE_BUILD__';   // 六文件指纹，邀请链接 ?v= 破缓存
const CLIENT_URL  = '__CLIENT_URL__';   // 在线页地址
const SERVER_MODE = '__SERVER_MODE__';  // 'web'（Pages）| 'lan'（本机程序托管页，服务返回时替换）

/* ---- 固定规格 ---- */
const PROTOCOL        = 5;
const HOST_API        = 'http://127.0.0.1:8000';
const ROOM_CHARS      = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 10 位，不含易混字符
const ROOM_LEN        = 10;
const CHUNK_SIZE      = 15000;   // 必须 < PeerJS chunkedMTU 16300
const IDLE_LIMIT      = 30 * 60 * 1000;
const GRACE_LIMIT     = 60 * 1000;
const BRIDGE_POLL_MS  = 400;
const LONG_POLL_MS    = 20000;
const SNAPSHOT_KEY    = 'v2.room.snapshot';
const TURN_KEY        = 'v2.turn';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.qq.com:3478' }
];

/* 协议消息类型（JSON 载荷；文件分片直接发二进制） */
const MSG = {
  HELLO:'HELLO', WELCOME:'WELCOME', HISTORY:'HISTORY', PEERS:'PEERS',
  TEXT:'TEXT', FILE_CARD:'FILE_CARD', FILE_META:'FILE_META', FILE_END:'FILE_END',
  FILE_PULL:'FILE_PULL', FILE_PULL_ERR:'FILE_PULL_ERR',
  PING:'PING', PONG:'PONG', ROOM_CLOSED:'ROOM_CLOSED', BYE:'BYE',
  SCREEN_STOP:'SCREEN_STOP', LAN_TEXT:'LAN_TEXT'
};

/* ---- 全局状态（唯一一份，房间只有一种） ---- */
let MODE = '';                  // 'host' | 'guest' | 'lan'
let ROOM = '';
let LAN_ON = false;             // 房主：入口按钮是否开启
let LAN_READY = false;          // 房主：本机程序是否就绪
let LAN_ADDR = '';              // 程序给出的局域网地址
let MY_ID = '', MY_NAME = '';
let PEER = null;                // 房主 / 外网访客的 Peer 实例
let HOST_CONN = null;           // 访客 → 房主 的 DataConnection
const CONNS = new Map();        // 房主：id -> { conn, name, isLan }
const MEMBERS = new Map();      // id -> { name, role, lastSeen }
let STORE = null;               // 房主：MemoryStore（唯一权威）
let GUEST_MESSAGES = [];        // 访客：本地消息（销毁即清，不落盘）
let STARTED_AT = 0, LAST_ACTIVITY = 0;
let DESTROYED = false;
let GRACE_DEADLINE = 0;
let RECONNECT_TIMER = null;

const TIMERS = new Set();       // 所有定时器 id，销毁时统一清
const OBJECT_URLS = new Set();  // 所有 createObjectURL，销毁时统一 revoke
const SEND_QUEUES = new Map();  // conn -> Promise 尾，保证同一连接串行发送
const FILE_INFLIGHT = new Map();// fileId -> { chunks, got, total, name, size, type }
const CALL_STATE = { call:null, stream:null, from:'' };

/* ---- 内存仓库：房间不关闭就全量保留，绝不写磁盘 / IndexedDB ---- */
class MemoryStore {
  constructor(){
    this.messages = [];         // { id, kind, from, name, text, file, ts, expired }
    this.files = new Map();     // fileId -> { id, name, size, type, data:Blob|null }
    this.rev = 0;
  }
  add(msg){
    msg.id = msg.id || uid('m');
    msg.ts = msg.ts || Date.now();
    this.messages.push(msg);
    this.rev++;
    return msg;
  }
  putFile(meta){
    this.files.set(meta.id, {
      id:meta.id, name:meta.name, size:meta.size, type:meta.type || '',
      data: meta.data || null
    });
    return this.files.get(meta.id);
  }
  file(id){ return this.files.get(id) || null; }
  markExpired(fileId){
    const f = this.files.get(fileId);
    if (f) f.data = null;
  }
  clear(){
    for (const f of this.files.values()) f.data = null;
    this.files.clear();
    this.messages.length = 0;
    this.rev = 0;
  }
}

/* ---- 会话快照：只放轻量 JSON，文件二进制不进 ---- */
function saveSnapshot(){
  if (MODE !== 'host' || !ROOM || DESTROYED) return;
  try {
    const snap = {
      room: ROOM, lanOn: LAN_ON, lanReady: LAN_READY, lanAddr: LAN_ADDR,
      startedAt: STARTED_AT, lastActivity: LAST_ACTIVITY,
      members: Array.from(MEMBERS.entries()),
      messages: STORE ? STORE.messages.map(m => ({
        id:m.id, kind:m.kind, from:m.from, name:m.name, text:m.text,
        file: m.file ? { id:m.file.id, name:m.file.name, size:m.file.size, type:m.file.type } : null,
        ts:m.ts, expired:true
      })) : []
    };
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch (e) {}
}
function readSnapshot(){
  try { return JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) || 'null'); }
  catch (e) { return null; }
}
function dropSnapshot(){
  try { sessionStorage.removeItem(SNAPSHOT_KEY); } catch (e) {}
}

/* ---- 活动时间：只有真实通信才刷新，心跳/探活/开关不算 ---- */
function noteActivity(){
  LAST_ACTIVITY = Date.now();
  saveSnapshot();
}
function idleExpired(){ return LAST_ACTIVITY > 0 && Date.now() - LAST_ACTIVITY >= IDLE_LIMIT; }

/* ---- 通用工具 ---- */
function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function uid(p){ return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
function fmtSize(n){
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtClock(ts){
  const d = new Date(ts);
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function fmtElapsed(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
}
function extOf(name){
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
}
function makeRoomCode(){
  const a = new Uint8Array(ROOM_LEN);
  (window.crypto || window.msCrypto).getRandomValues(a);
  let s = '';
  for (let i = 0; i < ROOM_LEN; i++) s += ROOM_CHARS[a[i] % ROOM_CHARS.length];
  return s;
}
function normalizeRoom(s){
  return String(s || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, ROOM_LEN);
}
function inviteUrl(room){
  return CLIENT_URL.replace(/\/*$/, '/') + '?room=' + encodeURIComponent(room) + '&v=' + PAGE_BUILD;
}
function lanInviteUrl(room, addr){
  return String(addr || '').replace(/\/*$/, '/') + '?room=' + encodeURIComponent(room) + '&v=' + PAGE_BUILD;
}
function downloadUrl(){
  return CLIENT_URL.replace(/\/*$/, '/') + encodeURIComponent('数据传输.exe');
}

/* ---- 资源登记（销毁时彻底清） ---- */
function later(fn, ms){
  const id = setTimeout(() => { TIMERS.delete(id); fn(); }, ms);
  TIMERS.add(id);
  return id;
}
function every(fn, ms){
  const id = setInterval(fn, ms);
  TIMERS.add(id);
  return id;
}
function stopTimer(id){
  if (!id) return;
  clearTimeout(id); clearInterval(id); TIMERS.delete(id);
}
function clearAllTimers(){
  for (const id of TIMERS) { clearTimeout(id); clearInterval(id); }
  TIMERS.clear();
}
function objectURL(blob){
  const u = URL.createObjectURL(blob);
  OBJECT_URLS.add(u);
  return u;
}
function revokeAllObjectURLs(){
  for (const u of OBJECT_URLS) { try { URL.revokeObjectURL(u); } catch (e) {} }
  OBJECT_URLS.clear();
}

/* ---- 提示与视图 ---- */
let TOAST_TIMER = null;
function toast(text){
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('on');
  stopTimer(TOAST_TIMER);
  TOAST_TIMER = later(() => el.classList.remove('on'), 2200);
}
function gateMsg(text, kind){
  const el = $('gateMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'gate-msg' + (kind ? ' ' + kind : '');
}
function gateView(id){
  for (const v of ['gateChoices', 'gateJoin', 'gateDl']) {
    const el = $(v);
    if (el) el.classList.toggle('on', v === id);
  }
}
function setGateHeader(title, sub, foot){
  const t = $('gateTitle'), s = $('gateSub'), f = $('gateFoot');
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
  if (f) f.innerHTML = foot;
}
function showGate(){
  const g = $('gateView'), h = $('hostView');
  if (g) g.classList.add('show');
  if (h) h.classList.remove('show');
}
function showRoom(){
  const g = $('gateView'), h = $('hostView');
  if (g) g.classList.remove('show');
  if (h) h.classList.add('show');
}
function openModal(id){ const el = $(id); if (el) el.classList.add('on'); }
function closeModals(){ document.querySelectorAll('.modal.on').forEach(el => el.classList.remove('on')); }
function qrInto(el, text){
  if (!el || !window.qrcode) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (e) { el.textContent = ''; }
}
async function copyText(text){
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ---- ICE / TURN ---- */
function loadTurn(){
  try { return JSON.parse(localStorage.getItem(TURN_KEY) || 'null'); }
  catch (e) { return null; }
}
function saveTurn(cfg){
  try {
    if (cfg && cfg.urls) localStorage.setItem(TURN_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(TURN_KEY);
  } catch (e) {}
}
function iceServers(){
  const custom = loadTurn();
  return custom && custom.urls ? ICE_SERVERS.concat([custom]) : ICE_SERVERS.slice();
}
function peerOptions(){
  return { debug: 0, config: { iceServers: iceServers() } };
}

/* ---- 同一连接串行发送（PeerJS 大数据必须排队） ---- */
function queueConnSend(conn, payload){
  if (!conn || !conn.open) return Promise.resolve(false);
  const prev = SEND_QUEUES.get(conn) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => new Promise(resolve => {
    if (!conn.open) return resolve(false);
    try { conn.send(payload); resolve(true); }
    catch (e) { resolve(false); }
  }));
  SEND_QUEUES.set(conn, next);
  return next;
}
function sendMsg(conn, type, data){
  return queueConnSend(conn, JSON.stringify({ p:PROTOCOL, t:type, d:data || {} }));
}
function parseMsg(raw){
  if (typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return (o && o.p === PROTOCOL && o.t) ? o : null;
  } catch (e) { return null; }
}
function broadcast(type, data, exceptId){
  for (const [id, c] of CONNS) {
    if (id !== exceptId && c.conn && c.conn.open) sendMsg(c.conn, type, data);
  }
}

/* ---- 创建进度（只画在「创建房间」按钮里） ---- */
const PROG = { steps:[], pct:0, creep:null };
function progReset(steps){
  stopTimer(PROG.creep);
  PROG.steps = steps || []; PROG.pct = 0;
  progPaint(-1, 0);
}
function progPaint(active, pct, allDone){
  PROG.pct = Math.max(PROG.pct, Math.min(100, pct || 0));
  const t = $('gateProgText'), p = $('gateProgPct'), f = $('gateProgFill'), bar = $('gateProgBar');
  if (!t || !p || !f) return;
  t.innerHTML = PROG.steps.map((s, i) => {
    const st = allDone || i < active ? 'gp-done' : (i === active ? 'gp-now' : 'gp-wait');
    const mark = st === 'gp-done' ? '✓' : (st === 'gp-now' ? '›' : '·');
    return '<span class="' + st + '">' + mark + ' ' + esc(s) + '</span>';
  }).join('<span class="gp-sep">·</span>');
  p.textContent = PROG.pct + '%';
  f.style.width = PROG.pct + '%';
  if (bar) bar.setAttribute('aria-valuenow', String(PROG.pct));
}
function progCreep(to){
  stopTimer(PROG.creep);
  PROG.creep = every(() => {
    if (PROG.pct >= to) { stopTimer(PROG.creep); return; }
    PROG.pct++;
    const p = $('gateProgPct'), f = $('gateProgFill');
    if (p) p.textContent = PROG.pct + '%';
    if (f) f.style.width = PROG.pct + '%';
  }, 130);
}
function progDone(){ stopTimer(PROG.creep); progPaint(PROG.steps.length, 100, true); }

/* ---- 免责声明 ---- */
function agreeChecked(){ const c = $('agreeCheck'); return !c || c.checked; }
function agreeHintFlash(){
  gateMsg('请先勾选《免责声明》再继续', 'warn');
  const c = $('agreeCheck');
  if (c) { c.focus(); }
}
function openDiscPage(){ const d = $('discPage'); if (d) d.classList.add('on'); }
function closeDiscPage(){ const d = $('discPage'); if (d) d.classList.remove('on'); }

/* ---- 局域网信息显示范围：未开启时帮助/弹窗里也不出现 ---- */
function applyLanVisibility(on){
  document.querySelectorAll('[data-lan-only]').forEach(el => { el.hidden = !on; });
  const card = $('lanCard');
  if (card) card.hidden = !(on && LAN_READY);
}
