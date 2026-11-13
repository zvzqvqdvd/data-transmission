// ===== store.js — 房间业务与「仓库」之间唯一的接缝 =====
// room.js / gate.js 只认 URL，不关心数据落在哪：
//   CHANNEL = 'lan'   → 本机 HTTP 服务（现状，一个字节不改）
//   CHANNEL = 'cloud' → CloudStore（内存 + IndexedDB，见 cloud.js）
// 两条路径不共享运行时状态，只在入口页分流时选定，进房后 CHANNEL 只读。
async function apiFetch(url, opts) {
  if (CHANNEL === 'cloud' && CloudStore.canHandle(url)) {
    try {
      return await CloudStore.handle(url, opts || {});
    } catch (e) {
      return cloudJSON({ ok: false, msg: String((e && e.message) || e) }, 500);
    }
  }
  return fetch(url, opts);
}
