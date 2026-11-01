/** 书架：books/<id>/{meta.json, book.txt}，按「第X章/第X回」切章节 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BookChapter {
  title: string;
  text: string;
}

export interface Book {
  id: string;
  title: string;
  chapters: BookChapter[];
}

const CHAPTER_RE = /^(?:第[0-9一二三四五六七八九十百千零两]+[回章节卷篇]|Chapter\s+\d+|CHAPTER\s+\d+)[^\n]{0,40}$/;

/** 把整本书切成章节；没有章节标记就整本当一章 */
export function splitChapters(raw: string): BookChapter[] {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const chapters: BookChapter[] = [];
  let title = '正文';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) chapters.push({ title, text: body });
    buf = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (t && t.length <= 60 && CHAPTER_RE.test(t)) {
      flush();
      title = t;
      continue;
    }
    buf.push(line);
  }
  flush();
  return chapters.length ? chapters : [{ title: '正文', text }];
}

/** 书架里所有书（只读 meta.json，不读正文） */
export function listBooks(dir: string): Array<{ id: string; title: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; title: string }> = [];
  for (const id of readdirSync(dir)) {
    const meta = join(dir, id, 'meta.json');
    const txt = join(dir, id, 'book.txt');
    if (!existsSync(meta) || !existsSync(txt)) continue;
    try {
      const j = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
      out.push({ id, title: String(j.title ?? id) });
    } catch {
      // 坏书跳过
    }
  }
  return out;
}

/** 读一本书（含章节）：优先 book.txt；没有就读 book.epub */
export function loadBook(dir: string, id: string): Book | null {
  const base = join(dir, id);
  const meta = join(base, 'meta.json');
  const txt = join(base, 'book.txt');
  const epub = join(base, 'book.epub');
  if (!existsSync(meta) || (!existsSync(txt) && !existsSync(epub))) return null;
  try {
    const j = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
    const title = String(j.title ?? id);
    let raw: string;
    if (existsSync(txt)) {
      raw = readFileSync(txt, 'utf8');
      // 正文可能是 UTF-8 或 GBK 存的：出现大量替换符就按 GBK 再试
      if ((raw.match(/\uFFFD/g) ?? []).length > 20) {
        try {
          raw = new TextDecoder('gbk').decode(readFileSync(txt));
        } catch {
          // 没有 gbk 解码器就用原来的
        }
      }
    } else {
      raw = readEpubText(epub);
      if (!raw.trim()) return null;
    }
    const chapters = splitChapters(raw);
    if (!chapters.length) return null;
    return { id, title, chapters };
  } catch {
    return null;
  }
}

/** epub → 纯文本（用 PowerShell 解压，Windows 上够用） */
function readEpubText(file: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-book-'));
  try {
    const zip = join(tmp, 'b.zip');
    copyFileSync(file, zip);
    const out = join(tmp, 'out');
    spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { timeout: 60_000 });
    const files = walk(out)
      .filter((f) => /\.(x?html?|htm)$/i.test(f))
      .sort();
    return files.map((f) => stripHtml(readFileSync(f, 'utf8'))).join('\n\n');
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉就算了
    }
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else out.push(p);
    } catch {
      // 跳过
    }
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 保存一本书：books/<id>/meta.json + book.txt */export function saveBook(dir: string, book: Book): void {
  const base = join(dir, book.id);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'meta.json'), JSON.stringify({ title: book.title }, null, 2), 'utf8');
  writeFileSync(join(base, 'book.txt'), book.chapters.map((c) => `${c.title}\n\n${c.text}`).join('\n\n'), 'utf8');
}
