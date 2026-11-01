/** 曲库：songs/<id>/{audio.mp3, lyrics.lrc, meta.json} */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayRequest } from './player';

export interface SongEntry {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  tags: string[];
  lyrics: string;
}

/** 扫一遍曲库（单个歌坏了就跳过） */
export function listSongs(dir: string): SongEntry[] {
  if (!existsSync(dir)) return [];
  const out: SongEntry[] = [];
  for (const id of readdirSync(dir)) {
    const base = join(dir, id);
    const meta = join(base, 'meta.json');
    if (!existsSync(meta) || !existsSync(join(base, 'audio.mp3'))) continue;
    try {
      const j = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
      const lrc = join(base, 'lyrics.lrc');
      out.push({
        id,
        title: String(j.title ?? id),
        artist: String(j.artist ?? ''),
        durationSec: Math.max(5, Number(j.durationSec) || 0),
        tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
        lyrics: existsSync(lrc) ? readFileSync(lrc, 'utf8') : '',
      });
    } catch {
      // 这个歌的 meta.json 坏了：跳过
    }
  }
  return out;
}

/** 按歌名/歌手/标签找一首（观众说的那点关键词） */
export function matchSong(songs: SongEntry[], query: string): SongEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    songs.find(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        q.includes(s.title.toLowerCase()) ||
        (s.artist && s.artist.toLowerCase().includes(q)) ||
        s.tags.some((tag) => q.includes(tag.toLowerCase())),
    ) ?? null
  );
}

/** 曲库里的歌 → 舞台上「放歌」的请求（不显示视频、显示歌词） */
export function songRequest(song: SongEntry): PlayRequest {
  const total = song.durationSec || 240;
  return {
    bvid: `song:${song.id}`,
    title: song.title,
    up: song.artist || '点歌',
    url: '',
    fromSec: 0,
    untilSec: total,
    durationSec: total,
    src: `/song?id=${song.id}`,
    kind: 'audio',
    lyrics: song.lyrics,
  };
}
