/* gate.js — 入口页：创建 / 加入 / 局域网按钮 / 检测 / 下载引导 / 启动分发
 * 界面上唯一新增：入口卡内「开启局域网访问」按钮 + 旁边一行文字（见 page.html）。
 */
'use strict';

/* ================= 局域网按钮（唯一新增交互） ================= */
function setLanButton(on){
  LAN_ON = !!on;
  const btn = $('lanBtn');
  if (btn) {
    btn.classList.toggle('on', LAN_ON);
    btn.textContent = LAN_ON ? '✓ 已开启局域网访问' : '开启局域网访问';
  }
  applyLanVisibility(LAN_ON);
}
function toggleLanButton(){
  setLanButton(!LAN_ON);
  gateMsg(LAN_ON
    ? '已开启：点「创建房间」时会检查本机程序是否运行'
    : '已关闭：将创建纯外网房间，不需要任何软件', LAN_ON ? 'info' : '');
}

/* ================= 本机程序探活（只有开启按钮后才发生） ================= */
async function fetchHostInfo(){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const r = await fetch(HOST_API + '/api/host', {
      signal:ctrl.signal, cache:'no-store', headers:{ 'Accept':'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.ok) throw new Error('bad response');
    return j;
  } finally { clearTimeout(timer); }
}

/* ================= 创建房间 ================= */
let CREATING = false;
async function gateCreate(){
  if (CREATING) return;
  if (!agreeChecked()) { agreeHintFlash(); openDiscPage(); return; }
  CREATING = true;
  const btn = $('gateCreateBtn'), label = btn && btn.querySelector('.gate-txt b');
  const prog = $('gateProg');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  if (label) label.textContent = '正在创建房间…';
  if (prog) prog.hidden = false;
  gateClearMsg();

  const needCheck = LAN_ON;
  progReset(needCheck
    ? ['检查程序', '创建房间', '外网通道']
    : ['生成房间码', '外网通道']);
  progPaint(0, 8);

  let hostInfo = null;
  try {
    if (needCheck) {
      try { hostInfo = await fetchHostInfo(); }
      catch (e) {
        CREATING = false;
        resetCreateButton();
        gateShowDl();
        return;
      }
      progPaint(1, 24);
    }

    // 房间码永远由前端生成，本机程序不参与
    const room = makeRoomCode();
    progPaint(needCheck ? 2 : 1, 68);
    progCreep(92);
    await startHost(room, {
      lanOn: LAN_ON,
      lanReady: !!(hostInfo && hostInfo.ok),
      lanAddr: hostInfo && hostInfo.ip ? ('http://' + hostInfo.ip + ':' + (hostInfo.port || 8000)) : '',
      startedAt: Date.now(),
      lastActivity: Date.now()
    });
    progDone();
    toast('房间 ' + room + ' 已创建');
  } catch (e) {
    gateMsg('创建失败：' + (e && e.message || e), 'err');
  } finally {
    CREATING = false;
    resetCreateButton();
    if (prog) later(() => { prog.hidden = true; }, 700);
  }
}
function resetCreateButton(){
  const btn = $('gateCreateBtn'), label = btn && btn.querySelector('.gate-txt b');
  if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  if (label) label.textContent = '创建房间';
  stopTimer(PROG.creep);
}
function gateClearMsg(){ gateMsg(''); }

/* ================= 下载引导页（结构与交互原样，只改标题/副标题两行文字） ================= */
let DL_STATE = '', DL_SIZE = 0, DL_ABORT = null;
let GATE_HDR = null;
const EXE_FILE = '数据传输.exe';

function gateSaveHdr(){
  if (GATE_HDR) return;
  GATE_HDR = {
    t: $('gateTitle') ? $('gateTitle').textContent : '',
    s: $('gateSub') ? $('gateSub').textContent : '',
    f: $('gateFoot') ? $('gateFoot').innerHTML : ''
  };
}
function gateRestoreHdr(){
  if (!GATE_HDR) return;
  if ($('gateTitle')) $('gateTitle').textContent = GATE_HDR.t;
  if ($('gateSub')) $('gateSub').textContent = GATE_HDR.s;
  if ($('gateFoot')) $('gateFoot').innerHTML = GATE_HDR.f;
  GATE_HDR = null;
}
function gateShowDl(){
  gateSaveHdr();
  if ($('gateTitle')) $('gateTitle').textContent = '开启局域网需要本机程序';
  if ($('gateSub')) $('gateSub').textContent = '在这台电脑上运行「数据传输.exe」放行防火墙';
  if ($('gateFoot')) $('gateFoot').innerHTML = '程序装好后回来点「重新创建」<br>关闭「开启局域网访问」可直接创建纯外网房间';
  gateView('gateDl');
  gateClearMsg();
  dlmReset();
  dlmProbeSize();
}
function gateShowChoices(){
  dlmAbort();
  gateRestoreHdr();
  gateView('gateChoices');
  gateClearMsg();
}
function dlmSizeText(t){
  const em = $('dlmSize');
  if (!em) return;
  em.textContent = t || '';
  em.style.visibility = t ? '' : 'hidden';
}
async function dlmProbeSize(){
  if (DL_SIZE) { dlmSizeText(fmtSize(DL_SIZE)); return; }
  dlmSizeText('…');
  try {
    const r = await fetch(downloadUrl(), { method:'HEAD', cache:'no-store' });
    const n = parseInt(r.headers.get('content-length') || '0', 10) || 0;
    if (n > 0) { DL_SIZE = n; dlmSizeText(fmtSize(n)); return; }
  } catch (e) {}
  dlmSizeText('');
}
function dlmReset(){
  DL_STATE = '';
  const btn = $('dlmBtn'), fill = $('dlmFill');
  if (btn) { btn.className = 'gdl-main'; btn.disabled = false; }
  if (fill) fill.style.width = '0%';
  if ($('dlmBtnText')) $('dlmBtnText').textContent = '下载 Windows 程序';
  dlmSizeText(DL_SIZE ? fmtSize(DL_SIZE) : '…');
}
function dlmPaint(got, total){
  const fill = $('dlmFill'), txt = $('dlmBtnText');
  const pct = total ? Math.min(100, Math.round(got / total * 100)) : 0;
  if (fill) fill.style.width = (total ? pct : 0) + '%';
  if (txt) txt.textContent = total ? (fmtSize(got) + ' / ' + fmtSize(total)) : ('正在缓存 ' + fmtSize(got));
  dlmSizeText(total ? pct + '%' : '…');
}
function dlmAbort(){
  if (DL_ABORT) { try { DL_ABORT.abort(); } catch (e) {} DL_ABORT = null; }
}
function dlmSave(blob){
  const u = objectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = EXE_FILE; a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); } catch (e) {}
  later(() => { try { a.remove(); } catch (e) {} }, 4000);
}
function dlmDone(size){
  DL_STATE = 'done';
  const btn = $('dlmBtn'), fill = $('dlmFill');
  if (btn) { btn.className = 'gdl-main done'; btn.disabled = false; }
  if (fill) fill.style.width = '100%';
  if ($('dlmBtnText')) $('dlmBtnText').textContent = '✓ 已保存 ' + fmtSize(size);
  dlmSizeText('完成');
}
async function dlmStart(){
  if (DL_STATE === 'busy') return;
  DL_STATE = 'busy';
  const btn = $('dlmBtn');
  if (btn) { btn.className = 'gdl-main busy'; btn.disabled = true; }
  dlmPaint(0, 0);
  DL_ABORT = new AbortController();
  let fellBack = false;
  try {
    const resp = await fetch(downloadUrl(), { signal:DL_ABORT.signal, cache:'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (!resp.body || !resp.body.getReader) throw new Error('no-stream');
    const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    if (total > 0) DL_SIZE = total;
    const reader = resp.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      dlmPaint(got, total);
    }
    const blob = new Blob(chunks, { type:'application/octet-stream' });
    dlmSave(blob);
    dlmDone(blob.size);
    gateMsg('已下载：双击运行「数据传输.exe」，回来点「重新创建」', 'info');
  } catch (e) {
    if (e && e.name === 'AbortError') { dlmReset(); return; }
    fellBack = true;
    dlmReset();
    try { window.location.href = downloadUrl(); } catch (e2) {}
  } finally {
    DL_ABORT = null;
    if (btn && !fellBack) btn.disabled = false;
  }
}
function dlmRetry(){
  gateShowChoices();
  gateMsg('正在检查本机程序…', 'info');
  later(() => { try { gateCreate(); } catch (e) {} }, 180);
}

/* ================= 加入房间 ================= */
function gateShowJoin(){
  gateSaveHdr();
  gateView('gateJoin');
  gateClearMsg();
  const box = $('gateRoom');
  if (box) later(() => { box.focus(); box.select(); }, 60);
}
function gateJoin(){
  if (!agreeChecked()) { agreeHintFlash(); openDiscPage(); return; }
  const box = $('gateRoom');
  const room = normalizeRoom(box && box.value);
  if (room.length !== ROOM_LEN) { gateMsg('请输入 10 位房间码', 'warn'); return; }
  gateClearMsg();
  if (SERVER_MODE === 'lan') startLanGuest(room);
  else startGuest(room);
}

/* ================= 入口页事件 ================= */
function bindGateUI(){
  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  bind('gateCreateBtn', gateCreate);
  bind('gateJoinBtn', gateShowJoin);
  bind('joinBackBtn', gateShowChoices);
  bind('joinGoBtn', gateJoin);
  bind('lanBtn', toggleLanButton);
  bind('dlmBtn', dlmStart);
  bind('dlBackBtn', gateShowChoices);
  bind('dlRetryBtn', dlmRetry);
  bind('discLink', e => { e.preventDefault(); openDiscPage(); });
  bind('discCloseBtn', closeDiscPage);
  const room = $('gateRoom');
  if (room) room.addEventListener('keydown', e => { if (e.key === 'Enter') gateJoin(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
}

/* ================= 刷新恢复（房主） ================= */
async function resumeHost(snap){
  if (!snap || !snap.room || snap.room.length !== ROOM_LEN) { dropSnapshot(); showGate(); return false; }
  let hostInfo = null;
  if (snap.lanOn) {
    try { hostInfo = await fetchHostInfo(); }
    catch (e) { toast('本机程序未运行，局域网接入暂不可用（房间本身不受影响）'); }
  }
  await startHost(snap.room, {
    restored: true,
    lanOn: !!snap.lanOn,
    lanReady: !!(snap.lanOn && hostInfo),
    lanAddr: hostInfo && hostInfo.ip ? ('http://' + hostInfo.ip + ':' + (hostInfo.port || 8000)) : (snap.lanAddr || ''),
    startedAt: snap.startedAt || Date.now(),
    lastActivity: snap.lastActivity || Date.now(),
    members: snap.members || [],
    messages: snap.messages || []
  });
  setLanButton(!!snap.lanOn);
  return true;
}

/* ================= 启动分发 ================= */
async function boot(){
  bindGateUI();
  applyLanVisibility(false);
  const q = new URLSearchParams(location.search);
  const roomParam = q.get('room');

  if (SERVER_MODE === 'lan') {
    // 本机程序托管的页面：同 WiFi 设备走 HTTP 桥，不需要外网信令
    if (roomParam) { startLanGuest(normalizeRoom(roomParam)); return; }
    showGate(); gateView('gateChoices');
    setGateHeader('数据传输 · 局域网', '输入房主页面上的房间码，加入同一个房间',
      '本页面由本机程序托管，只在内存中转发数据<br>房间销毁后历史消息与文件在各端一并清除');
    const lb = $('lanBtn'); if (lb) lb.hidden = true;
    return;
  }
  if (roomParam) {
    const room = normalizeRoom(roomParam);
    if (room.length === ROOM_LEN) { startGuest(room); return; }
  }
  if (q.get('host') === '1') {
    const snap = readSnapshot();
    if (snap && await resumeHost(snap)) return;
    dropSnapshot();
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    showGate(); gateView('gateChoices');
    gateMsg('房间已结束，点「创建房间」开一个新房间。', 'info');
    return;
  }
  showGate(); gateView('gateChoices');
  try {
    const saved = sessionStorage.getItem('v2.join.room');
    if (saved) gateMsg('上次加入的房间：' + saved + '（可向房主确认后重新输入）', 'info');
  } catch (e) {}
}

/* 唯一的启动入口 */
boot();
