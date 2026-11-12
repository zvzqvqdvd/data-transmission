#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""数据传输 v2 · 本机程序（全新实现）

只做四件事：
  1. 放行 8000 端口防火墙规则
  2. 看门狗：程序退出 / 崩溃后回收规则
  3. 托管同一份页面，给同 WiFi 设备一个可打开的地址
  4. 内存接入转发：局域网设备 <-> 房主页面（数据只在内存过一下）

明确不做：不生成房间码、不接收或存储任何消息与文件到磁盘、
不写聊天记录 / 接收文件目录、不发心跳、不判定房间死活、不销毁房间。

另提供 --export-page：把 web/ 六文件内联成根目录单文件 index.html。
"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8000
RULE = '数据传输v2-8000'
EXE_FILE = '数据传输.exe'
WEB_FILES = ('page.html', 'app.css', 'vendor.js', 'app.js', 'room.js', 'gate.js')
MAX_BODY = 256 * 1024 * 1024
IDLE_GC = 30 * 60
CREATE_NO_WINDOW = 0x08000000 if os.name == 'nt' else 0


def app_dir() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(getattr(sys, '_MEIPASS', Path(sys.executable).parent))
    return Path(__file__).resolve().parent


ROOT = app_dir()
OUTPUT_DIR = Path(sys.executable).parent if getattr(sys, 'frozen', False) else ROOT


# ---------------------------------------------------------------- 页面构建
def read_text(path: Path) -> str:
    with open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def read_client_url() -> str:
    for p in (ROOT / 'client_url.txt', OUTPUT_DIR / 'client_url.txt'):
        try:
            if p.exists():
                return read_text(p).strip() or 'https://zvzqvqdvd.github.io/data-transmission/'
        except OSError:
            pass
    return 'https://zvzqvqdvd.github.io/data-transmission/'


def export_page() -> Path:
    web = ROOT / 'web'
    parts = [read_text(web / n) for n in WEB_FILES]
    fingerprint = hashlib.md5(''.join(parts).encode('utf-8')).hexdigest()[:10]

    def safe_js(s: str) -> str:
        return s.replace('</script', '<\\/script')

    business_js = '\n;\n'.join(parts[3:6])
    html = parts[0]
    html = html.replace('__APP_CSS__', parts[1].replace('</style', '<\\/style'))
    html = html.replace('__VENDOR_JS__', safe_js(parts[2]))
    html = html.replace('__APP_JS__', safe_js(business_js))
    html = html.replace('__PAGE_BUILD__', fingerprint)
    html = html.replace('__CLIENT_URL__', read_client_url())
    html = html.replace('__SERVER_MODE__', 'web')

    left = [k for k in ('__APP_CSS__', '__VENDOR_JS__', '__APP_JS__',
                        '__PAGE_BUILD__', '__CLIENT_URL__', '__SERVER_MODE__') if k in html]
    if left:
        raise RuntimeError('未替换的占位符: ' + ', '.join(left))
    out = OUTPUT_DIR / 'index.html'
    with open(out, 'w', encoding='utf-8', newline='') as f:
        f.write('<!-- 构建产物，请勿直接编辑；改 web/ 后运行 python 数据传输.py --export-page -->\n')
        f.write(html)
    print('已导出 %s (%d 字节, 指纹 %s)' % (out, out.stat().st_size, fingerprint))
    return out


_PRODUCT_CACHE = {'mtime': 0.0, 'text': ''}


def product_html() -> str:
    p = OUTPUT_DIR / 'index.html'
    if not p.exists():
        p = ROOT / 'index.html'
    m = p.stat().st_mtime if p.exists() else 0.0
    if m != _PRODUCT_CACHE['mtime']:
        _PRODUCT_CACHE['text'] = read_text(p) if p.exists() else '<h1>请先运行 --export-page</h1>'
        _PRODUCT_CACHE['mtime'] = m
    # 本机程序托管给同 WiFi 设备的页面，模式标为 lan（磁盘产物仍是 web）
    return _PRODUCT_CACHE['text'].replace("const SERVER_MODE = 'web';", "const SERVER_MODE = 'lan';")


# ---------------------------------------------------------------- 内存转发桥
class Bridge:
    """只在进程内存里过一下数据，绝不写磁盘。"""

    def __init__(self):
        self.lock = threading.RLock()
        self.rooms = {}          # room -> state
        self.closed = {}         # room -> 关闭时间戳（供长轮询通知设备）

    @staticmethod
    def blank():
        return {
            'messages': [],      # 公开消息列表（不含文件二进制）
            'seen': set(),       # 已收录的消息 id，用于去重
            'pending': [],       # 等设备 -> 房主 的待转项
            'files': {},         # fileId -> {'data': bytes, 'name': str, 'type': str}
            'clients': {},       # clientId -> 最后活跃时间
            'addr': '',
            'last': time.time()
        }

    def get(self, room, create=False):
        with self.lock:
            st = self.rooms.get(room)
            if not st and create:
                st = self.blank()
                self.rooms[room] = st
                self.closed.pop(room, None)
            if st:
                st['last'] = time.time()
            return st

    def attach(self, room, addr):
        st = self.get(room, True)
        with self.lock:
            st['addr'] = addr or ''
            # 房主刷新会重新 attach：保留已有历史，避免局域网设备丢消息
        return st

    def push(self, room, messages):
        st = self.get(room, True)
        with self.lock:
            for m in messages:
                mid = str(m.get('id') or '')
                if mid and mid in st['seen']:
                    continue
                if mid:
                    st['seen'].add(mid)
                st['messages'].append(m)
            return len(st['messages'])

    def send(self, room, item):
        st = self.get(room, True)
        with self.lock:
            st['pending'].append(item)

    def take_pending(self, room):
        st = self.get(room, False)
        if not st:
            return [], 0
        with self.lock:
            items = st['pending']
            st['pending'] = []
            return items, self.client_count(room)

    def client_count(self, room):
        st = self.rooms.get(room)
        if not st:
            return 0
        now = time.time()
        st['clients'] = {k: v for k, v in st['clients'].items() if now - v < 60}
        return len(st['clients'])

    def messages(self, room, since, client_id, wait=20.0):
        deadline = time.time() + wait
        while time.time() < deadline:
            with self.lock:
                if room in self.closed:
                    return {'closed': True, 'messages': [], 'rev': since, 'count': 0}
                st = self.rooms.get(room)
                if st:
                    if client_id:
                        st['clients'][client_id] = time.time()
                    total = len(st['messages'])
                    if total > since:
                        return {'closed': False, 'messages': st['messages'][since:],
                                'rev': total, 'count': self.client_count(room)}
            time.sleep(0.25)
        return {'closed': False, 'messages': [], 'rev': since,
                'count': self.client_count(room)}

    def put_file(self, room, fid, data, name, ctype):
        st = self.get(room, True)
        with self.lock:
            st['files'][fid] = {'data': data, 'name': name, 'type': ctype}
            if len(st['files']) > 64:      # 只保留最近的内存缓冲，防膨胀
                for k in list(st['files'])[:-32]:
                    st['files'].pop(k, None)

    def get_file(self, room, fid):
        for st in (self.rooms.get(room), *[s for r, s in self.rooms.items() if r != room]):
            if st and fid in st['files']:
                return st['files'][fid]
        return None

    def detach(self, room):
        with self.lock:
            self.rooms.pop(room, None)
            self.closed[room] = time.time()

    def gc(self):
        while True:
            time.sleep(60)
            now = time.time()
            with self.lock:
                for room, st in list(self.rooms.items()):
                    if now - st['last'] > IDLE_GC:
                        self.rooms.pop(room, None)
                        self.closed[room] = now
                for room, t in list(self.closed.items()):
                    if now - t > IDLE_GC:
                        self.closed.pop(room, None)


BRIDGE = Bridge()


# ---------------------------------------------------------------- 防火墙 / 看门狗
def fw_add():
    if os.name != 'nt':
        return True
    cmd = ['netsh', 'advfirewall', 'firewall', 'add', 'rule', 'name=' + RULE,
           'dir=in', 'action=allow', 'protocol=TCP', 'localport=' + str(PORT), 'profile=any']
    try:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=CREATE_NO_WINDOW, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def fw_del():
    if os.name != 'nt':
        return
    try:
        subprocess.run(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', 'name=' + RULE],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=CREATE_NO_WINDOW, timeout=10)
    except Exception:
        pass


def watchdog(parent_pid):
    """独立进程：等主进程退出后回收防火墙规则。"""
    try:
        import ctypes
        k = ctypes.windll.kernel32
        handle = k.OpenProcess(0x100000, False, int(parent_pid))
        if handle:
            k.WaitForSingleObject(handle, 0xFFFFFFFF)
            k.CloseHandle(handle)
    except Exception:
        pass
    fw_del()


def spawn_watchdog():
    if os.name != 'nt':
        return
    try:
        target = sys.executable if getattr(sys, 'frozen', False) else str(Path(__file__).resolve())
        subprocess.Popen([target, '--watchdog', str(os.getpid())],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=CREATE_NO_WINDOW)
    except Exception:
        pass


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return '127.0.0.1'


# ---------------------------------------------------------------- HTTP 服务
class Handler(BaseHTTPRequestHandler):
    server_version = 'DataTransferV2/2.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-File-Name')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Max-Age', '86400')
        self.send_header('Cache-Control', 'no-store')

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _bytes(self, data, ctype='application/octet-stream', status=200, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0:
            return b''
        if n > MAX_BODY:
            raise ValueError('请求体过大')
        return self.rfile.read(n)

    def _body_json(self):
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = urllib.parse.unquote(u.path)
        q = urllib.parse.parse_qs(u.query)
        room = (q.get('room') or [''])[0]

        if p in ('/', '/index.html'):
            self._bytes(product_html().encode('utf-8'), 'text/html; charset=utf-8')
            return
        if p == '/api/host':
            self._json({'ok': True, 'ip': local_ip(), 'port': PORT,
                        'client_url': read_client_url(), 'version': 2})
            return
        if p == '/api/bridge/room':
            with BRIDGE.lock:
                rooms = list(BRIDGE.rooms.keys())
            self._json({'ok': True, 'room': rooms[0] if rooms else ''})
            return
        if p == '/api/bridge/poll':
            items, count = BRIDGE.take_pending(room)
            self._json({'ok': True, 'items': items, 'count': count})
            return
        if p == '/api/bridge/messages':
            try:
                since = max(0, int((q.get('since') or ['0'])[0]))
            except ValueError:
                since = 0
            cid = (q.get('id') or [''])[0]
            result = BRIDGE.messages(room, since, cid)
            self._json(result)
            return
        if p.startswith('/api/bridge/file/'):
            fid = p.rsplit('/', 1)[-1]
            f = BRIDGE.get_file(room, fid)
            if not f:
                self._json({'ok': False, 'msg': '文件已失效'}, 404)
                return
            self._bytes(f['data'], f['type'] or 'application/octet-stream')
            return
        if p == '/' + EXE_FILE:
            exe = OUTPUT_DIR / EXE_FILE
            if exe.exists():
                self._bytes(exe.read_bytes(), 'application/octet-stream',
                            extra={'Content-Disposition': 'attachment; filename*=UTF-8\'\'' +
                                   urllib.parse.quote(EXE_FILE)})
            else:
                self._json({'ok': False, 'msg': '本机未找到程序文件，请从在线页下载'}, 404)
            return
        self._json({'ok': False, 'msg': 'not found'}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        p = urllib.parse.unquote(u.path)
        q = urllib.parse.parse_qs(u.query)

        if p.startswith('/api/bridge/file/'):
            fid = p.rsplit('/', 1)[-1]
            room = (q.get('room') or [''])[0]
            try:
                data = self._body()
            except ValueError as e:
                self._json({'ok': False, 'msg': str(e)}, 413)
                return
            name = urllib.parse.unquote(self.headers.get('X-File-Name') or fid)
            ctype = self.headers.get('Content-Type') or 'application/octet-stream'
            with BRIDGE.lock:
                rooms = list(BRIDGE.rooms.keys())
            target = room or (rooms[0] if rooms else '')
            if not target:
                self._json({'ok': False, 'msg': '房间未就绪'}, 409)
                return
            BRIDGE.put_file(target, fid, data, name, ctype)
            self._json({'ok': True, 'id': fid, 'size': len(data)})
            return

        body = self._body_json()
        room = str(body.get('room') or '')
        if p == '/api/bridge/attach':
            BRIDGE.attach(room, str(body.get('addr') or ''))
            self._json({'ok': True})
            return
        if p == '/api/bridge/push':
            rev = BRIDGE.push(room, body.get('messages') or [])
            self._json({'ok': True, 'rev': rev})
            return
        if p == '/api/bridge/send':
            kind = body.get('kind') or 'text'
            if kind == 'file':
                f = body.get('file') or {}
                item = {'kind': 'file', 'id': str(f.get('id') or ''),
                        'name': str(body.get('name') or '局域网设备'),
                        'file': {'name': str(f.get('name') or '文件'),
                                 'size': int(f.get('size') or 0),
                                 'type': str(f.get('type') or '')},
                        'ts': int(body.get('ts') or time.time() * 1000)}
            else:
                item = {'kind': 'text', 'id': str(body.get('id') or ''),
                        'from': str(body.get('from') or ''),
                        'name': str(body.get('name') or '局域网设备'),
                        'text': str(body.get('text') or ''),
                        'ts': int(body.get('ts') or time.time() * 1000)}
            BRIDGE.send(room, item)
            self._json({'ok': True})
            return
        if p == '/api/bridge/detach':
            BRIDGE.detach(room)
            self._json({'ok': True})
            return
        self._json({'ok': False, 'msg': 'not found'}, 404)


def main():
    ap = argparse.ArgumentParser(description='数据传输 v2 本机程序')
    ap.add_argument('--export-page', action='store_true', help='把 web/ 六文件内联成 index.html')
    ap.add_argument('--watchdog', metavar='PID', help=argparse.SUPPRESS)
    ap.add_argument('--no-firewall', action='store_true', help='不修改防火墙规则（调试用）')
    args = ap.parse_args()

    if args.watchdog:
        watchdog(args.watchdog)
        return
    if args.export_page:
        export_page()
        return

    ok = True
    if not args.no_firewall:
        ok = fw_add()
        atexit.register(fw_del)
        spawn_watchdog()
    threading.Thread(target=BRIDGE.gc, daemon=True).start()

    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    srv.daemon_threads = True
    ip = local_ip()
    print('数据传输 v2 已启动')
    print('  房主页面：在线页点「创建房间」，勾选「开启局域网访问」后会自动检测本程序')
    print('  局域网地址：http://%s:%d' % (ip, PORT))
    print('  防火墙规则：%s' % ('已放行' if ok else '放行失败，请以管理员身份运行（本机回环不受影响）'))
    print('  说明：程序只在内存转发，不生成房间码、不保存消息与文件、不判定房间状态')
    print('  按 Ctrl+C 退出（退出时自动回收防火墙规则）')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        fw_del()


if __name__ == '__main__':
    main()
