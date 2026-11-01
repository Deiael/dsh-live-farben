/** 礼物榜 + 礼物知识库：本日 / 本月排行，按天汇总成可检索的记忆 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GiftEntry {
  at: number;
  uid: string;
  name: string;
  gift: string;
  count: number;
  yuan: number;
}

export interface GiftPerson {
  name: string;
  total: number;
  gifts: Array<{ gift: string; count: number }>;
}

export interface GiftBoardData {
  today: GiftPerson[];
  month: GiftPerson[];
}

const KEEP_DAYS = 180;

export class GiftBoard {
  private entries: GiftEntry[] = [];

  constructor(private readonly dir: string) {
    this.load();
  }

  private file(): string {
    return join(this.dir, 'gift-log.json');
  }

  private memoryFile(): string {
    return join(this.dir, 'gift-memory.json');
  }

  private load(): void {
    try {
      if (!existsSync(this.file())) return;
      const data = JSON.parse(readFileSync(this.file(), 'utf8')) as GiftEntry[];
      if (Array.isArray(data)) this.entries = data.filter((e) => e && Number.isFinite(e.at));
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      const cutoff = Date.now() - KEEP_DAYS * 86400_000;
      this.entries = this.entries.filter((e) => e.at >= cutoff).slice(-6000);
      writeFileSync(this.file(), JSON.stringify(this.entries), 'utf8');
    } catch {
      // 写不进去不影响直播
    }
  }

  add(entry: Omit<GiftEntry, 'at'> & { at?: number }): void {
    this.entries.push({ ...entry, at: entry.at ?? Date.now() });
    this.save();
    this.saveMemory();
  }

  summary(now = Date.now()): GiftBoardData {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const pick = (from: number) => this.entries.filter((e) => e.at >= from);
    return { today: aggregate(pick(dayStart.getTime())), month: aggregate(pick(monthStart.getTime())) };
  }

  /** 按天汇总成一段话（知识库），按天倒序 */
  dayNotes(days = 30): Array<{ day: string; text: string }> {
    const groups = new Map<string, GiftEntry[]>();
    for (const e of this.entries) {
      const d = new Date(e.at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, Math.max(1, Math.min(180, days)))
      .map(([day, list]) => {
        const people = aggregate(list);
        const total = people.reduce((n, p) => n + p.total, 0);
        const parts = people.map((p) => `${p.name}送${p.gifts.map((g) => `${g.gift}×${g.count}`).join('、')}（${p.total.toFixed(0)}元）`);
        return { day, text: `${day}：${parts.join('；')}。共 ${people.length} 人，约 ${total.toFixed(0)} 元。` };
      });
  }

  /** 某个人的送礼画像（长期） */
  personNote(name: string): string | null {
    const key = name.trim();
    if (!key) return null;
    const mine = this.entries.filter((e) => e.name.includes(key) || key.includes(e.name));
    if (!mine.length) return null;
    const people = aggregate(mine);
    const p = people[0];
    const total = mine.reduce((n, e) => n + e.yuan * Math.max(1, e.count), 0);
    const first = new Date(Math.min(...mine.map((e) => e.at)));
    const last = new Date(Math.max(...mine.map((e) => e.at)));
    const fmt = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${p.name}：从 ${fmt(first)} 到 ${fmt(last)} 共送过 ${p.gifts.map((g) => `${g.gift}×${g.count}`).join('、')}，累计约 ${total.toFixed(0)} 元。`;
  }

  /** 把按天汇总写成知识库文件，方便以后接向量检索 */
  private saveMemory(): void {
    try {
      writeFileSync(this.memoryFile(), JSON.stringify(this.dayNotes(120)), 'utf8');
    } catch {
      // 写不进去不影响直播
    }
  }
}

function aggregate(entries: GiftEntry[]): GiftPerson[] {
  const byUid = new Map<string, GiftPerson>();
  for (const e of entries) {
    const key = e.uid || e.name;
    const person = byUid.get(key) ?? { name: e.name, total: 0, gifts: [] };
    person.total += e.yuan * Math.max(1, e.count);
    const gift = person.gifts.find((g) => g.gift === e.gift);
    if (gift) gift.count += Math.max(1, e.count);
    else person.gifts.push({ gift: e.gift, count: Math.max(1, e.count) });
    byUid.set(key, person);
  }
  return [...byUid.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((p) => ({ ...p, gifts: p.gifts.sort((a, b) => b.count - a.count).slice(0, 3) }));
}
