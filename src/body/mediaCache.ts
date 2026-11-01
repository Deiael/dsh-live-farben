/**
 * 视频本地缓存：整个下到磁盘再播，避免 B 站 CDN 边下边播时卡顿。
 * 下载限速：直播推流也在抢同一条上行，全速下载会把推流挤得一顿一顿。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 下载速度上限（字节/秒）：默认 10 Mbps 左右，给推流留余量；可用 DSH_MEDIA_BPS 覆盖 */
const MAX_BYTES_PER_SEC = Math.max(200_000, Number(process.env.DSH_MEDIA_BPS) || 1_250_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 缓存一件视频；已经有就用旧的。失败返回 null（调用方退回在线代理） */
export async function cacheVideo(dir: string, bvid: string, url: string): Promise<string | null> {
  const file = join(dir, `${bvid}.mp4`);
  if (existsSync(file) && statSync(file).size > 1024) return file;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.part`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) return null;
    const total = Number(res.headers.get('content-length') ?? 0);
    const out = createWriteStream(tmp);
    const reader = res.body.getReader();
    const started = Date.now();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        // 限速：比“按上限应该下到的位置”快，就等一下
        const shouldTake = (bytes / MAX_BYTES_PER_SEC) * 1000;
        const waited = Date.now() - started;
        if (shouldTake > waited) await sleep(Math.min(200, shouldTake - waited));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    if (!existsSync(tmp) || statSync(tmp).size < 1024) {
      if (existsSync(tmp)) unlinkSync(tmp);
      return null;
    }
    // 下了一半就断（大小对不上）的不要：宁可走在线代理，也别播半截文件
    if (total > 0 && Math.abs(statSync(tmp).size - total) > Math.max(2048, total * 0.005)) {
      unlinkSync(tmp);
      return null;
    }
    renameSync(tmp, file);
    return file;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理临时文件失败就算了
    }
    return null;
  }
}

/** 只留最近 keep 个缓存文件 */
export function pruneVideos(dir: string, keep = 20): void {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of files.slice(keep)) unlinkSync(join(dir, old.f));
  } catch {
    // 清理失败不影响播放
  }
}
