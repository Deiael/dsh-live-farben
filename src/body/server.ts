/**
 * 舞台服务器：插件自己开一个端口（DSH 网页版和桌面版都能用），OBS 的浏览器源直接打开它。
 *
 *   GET  /?token=…                 舞台页（按当前模板摆好挂件）
 *   GET  /stage.js /stage.css       舞台页的代码（插件包 lib/）
 *   GET  /characters/<id>/<file>   角色包、/templates/<id>/<file> 模板（见 packs.ts）
 *   GET  /events?token=…           舞台事件流（SSE）
 *   POST /said?id=…&token=…        舞台念完一句
 *   GET  /video?id=…&token=…       正在放的视频（转发 B 站 CDN，带它要的 Referer，支持 Range）
 *   POST /media?id=…&state=…&token=…  视频开始放、放完、放不出来
 *
 * 所有请求都要带 token（OBS 里填的地址自带），只监听本机。
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { StageEvent } from '../stage/protocol';
import type { Packs } from './packs';
import type { Stage } from './stage';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

export interface StageServerOptions {
  port: number;
  token: string;
  /** 插件包目录（有 lib/、stage/） */
  packageDir: string;
  packs: Packs;
  stage: Stage;
  /** 现在用哪个角色、哪个模板 */
  current(): { character: string; template: string };
  /** 曲库目录（每首歌一个子目录：audio.mp3 + lyrics.lrc + meta.json） */
  songs?: string;
  /** 视频本地缓存目录（先下载再播，避免 CDN 卡顿） */
  mediaDir?: string;
  /** 剧情场景图目录（scenes/<名字>.jpg，她换场景时用） */
  scenesDir?: string;
  /** 舞台上放的视频：id → CDN 地址；舞台的回执 */
  media?: {
    source(id: string): string | null;
    report(id: string, state: 'playing' | 'ended' | 'error', positionSec?: number, detail?: string): void;
  };
  log?(level: 'info' | 'warn', message: string): void;
}

export class StageServer {
  private server: Server | null = null;

  /** 舞台页代码的版本：lib/stage.js 的修改时间。插件更新、DSH 重启后变，开着的舞台页（OBS）看到就自己刷新 */
  private readonly build: string;

  constructor(private readonly options: StageServerOptions) {
    const script = join(options.packageDir, 'lib', 'stage.js');
    this.build = existsSync(script) ? String(Math.round(statSync(script).mtimeMs)) : '';
  }

  get url(): string {
    return `http://127.0.0.1:${this.options.port}/?token=${this.options.token}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.options.log?.('warn', `舞台请求出错：${(err as Error).message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.requestTimeout = 0;
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  // ── 请求 ────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== this.options.token) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('舞台地址不对：请从 DSH 的直播控制台复制完整地址（带 token）。');
      return;
    }
    const path = url.pathname;
    if (req.method === 'POST' && path === '/said') {
      this.options.stage.said(url.searchParams.get('id') ?? '');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/media') {
      const state = url.searchParams.get('state');
      if (state === 'playing' || state === 'ended' || state === 'error') {
        if (state === 'error') this.options.log?.('warn', `舞台放视频出错：${(url.searchParams.get('detail') ?? '').slice(0, 200)}`);
        this.options.media?.report(url.searchParams.get('id') ?? '', state, Number(url.searchParams.get('at') ?? NaN), url.searchParams.get('detail') ?? undefined);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (path === '/events') return this.events(req, res, url);
    if (path === '/video') return this.video(req, res, url.searchParams.get('id') ?? '');
    if (path === '/room') return this.room(req, res, url.searchParams.get('src') ?? '');
    if (path === '/song') return this.song(res, url.searchParams.get('id') ?? '');
    if (path === '/media') return this.mediaFile(req, res, url.searchParams.get('id') ?? '');
    if (path === '/' || path === '/index.html') return this.file(res, join(this.options.packageDir, 'stage', 'index.html'));
    if (path === '/stage.js') return this.file(res, join(this.options.packageDir, 'lib', 'stage.js'));
    if (path === '/stage.css') return this.file(res, join(this.options.packageDir, 'stage', 'stage.css'));
    if (path === '/scene') return this.sceneFile(res, url.searchParams.get('id') ?? '');
    const pack = /^\/(characters|templates)\/([\w-]{1,64})\/(.+)$/.exec(path);
    if (pack) {
      const dir = this.options.packs.dir(pack[1] as 'characters' | 'templates', pack[2]);
      if (dir) return this.file(res, join(dir, decodeURIComponent(pack[3])), dir);
    }
    res.writeHead(404);
    res.end();
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: StageEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const { character, template } = this.options.current();
    const c = this.options.packs.character(character);
    const t = this.options.packs.template(template);
    if (c && t) send({ v: 1, type: 'hello', character: c, template: t, build: this.build, at: Date.now() });
    // ?preview=1：控制台里的预览，静音、不回执
    const unsubscribe = this.options.stage.subscribe(send, url.searchParams.get('preview') !== '1');
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  /** 转发视频：B 站 CDN 要 Referer；浏览器拖进度、OBS 边下边放都靠 Range */
  private async video(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const source = this.options.media?.source(id);
    if (!source) {
      res.writeHead(404);
      res.end();
      return;
    }
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    let upstream: Response;
    try {
      upstream = await fetch(source, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        signal: abort.signal,
      });
    } catch (err) {
      if (!abort.signal.aborted) this.options.log?.('warn', `视频取不到：${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
      return;
    }
    const headers: Record<string, string> = { 'content-type': upstream.headers.get('content-type') ?? 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  }

  /**
   * 查房：把别人的直播流转发给 OBS 的媒体源（OBS 自己拉 B 站会 403：不带 Referer/UA）。
   * 只认 B 站自己的 CDN，别的地方的地址一律拒绝，避免被当成开放代理。
   */
  private async room(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || !(host.endsWith('.bilivideo.com') || host.endsWith('.bilibili.com'))) {
      res.writeHead(403);
      res.end();
      return;
    }
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    try {
      const upstream = await fetch(target.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Referer: 'https://live.bilibili.com/',
        },
        signal: abort.signal,
      });
      const headers: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? 'video/x-flv',
        'cache-control': 'no-store',
        ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}),
      };
      res.writeHead(upstream.status, headers);
      if (!upstream.body) return void res.end();
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
      if (!abort.signal.aborted) this.options.log?.('warn', `查房流取不到：${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }

  /** 曲库里的歌：/song?id=<歌的目录名> */
  private song(res: ServerResponse, id: string): void {
    const dir = this.options.songs;
    if (!dir || !/^[\w-]{1,64}$/.test(id)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = join(dir, id, 'audio.mp3');
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': statSync(file).size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  }

  /** 剧情场景图：/scene?id=<名字>（scenes/<名字>.jpg|png|webp） */
  private sceneFile(res: ServerResponse, id: string): void {
    const dir = this.options.scenesDir;
    if (!dir || !/^[\w-]{1,64}$/.test(id)) {
      res.writeHead(404);
      res.end();
      return;
    }
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const file = join(dir, `${id}${ext}`);
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[ext] ?? 'image/jpeg', 'content-length': statSync(file).size, 'cache-control': 'max-age=60' });
        createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  }

  /** 本地缓存的视频：/media?id=<bvid>，支持 Range（拖进度、边放边播都靠它） */
  private mediaFile(req: IncomingMessage, res: ServerResponse, id: string): void {
    const dir = this.options.mediaDir;
    if (!dir || !/^[\w-]{1,64}$/.test(id)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = join(dir, `${id}.mp4`);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (!Number.isFinite(start) || start >= size || end < start) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
        'cache-control': 'no-store',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  }

  private file(res: ServerResponse, file: string, within?: string): void {    const resolved = normalize(file);
    // 只给包里或用户目录里的文件（防 ../ 跳出去）
    if (within && !resolved.startsWith(normalize(within) + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': extname(resolved) === '.html' || extname(resolved) === '.js' ? 'no-store' : 'max-age=3600',
    });
    res.end(readFileSync(resolved));
  }
}
