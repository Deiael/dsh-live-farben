/**
 * 插件的共享状态：宿主根插件（index.ts）和 agent 子插件（agent.ts）用同一份（同一个进程，同一个模块实例）。
 *
 *   - show：这一场直播的身体
 *   - server：舞台服务器（OBS 打开的那个地址）
 *   - settings：房间号、角色、模板……存在 DSH_HOME/dsh-live-farben/settings.json（控制台里改）
 *   - 机密（B 站 Cookie、豆包密钥）不在这里：走 DSH 的凭据服务，按名字取
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveShow, type LiveSnapshot } from '../body/show';
import { listSongs, matchSong, songRequest } from '../body/songLibrary';
import { listBooks, loadBook } from '../body/books';
import { GiftBoard } from '../body/giftBoard';
import type { PlayRequest } from '../body/player';
import { Whisper } from '../body/asr';
import { BiliAccount } from '../body/biliAccount';
import { BiliVideos } from '../body/biliVideo';
import { BiliSocial } from '../body/biliSocial';
import { VideoLibrary } from '../body/videoLibrary';
import { SocialManager } from '../body/social';
import { Broadcast } from '../body/broadcast';
import { DmManager } from '../body/dm';
import { Packs } from '../body/packs';
import { StageServer } from '../body/server';
import { canSpeak, subtitleTimeline, synthesize, type TtsAuth } from '../body/tts';
import { DEFAULT_VOICE } from '../body/voices';
import type { DistillLlm } from '../core/memory/distill';
import type { CharacterManifest, GameSource } from '../stage/protocol';
import { gameRect, videoRect } from '../stage/layout';
import { clearRoomStream, connectObs, showGameSources, showRoomStream } from '../body/obs';
import type { OwnerPace } from '../core/attention/attention';

export interface Settings {
  roomId: number | null;
  character: string;
  template: string;
  /** 空串用角色包的默认音色 */
  voice: string;
  stagePort: number;
  stageToken: string;
  /** 下播提炼观众记忆用的模型（provider/model） */
  distillModel: string;
  /** 没话题多少秒后自己找话说 */
  idleAfterSec: number;
  /** 她在玩游戏时，弹幕至少隔多少秒推给她一次（越大回得越少、玩得越多） */
  gameChatGapSec: number;
  /** 每隔多少秒顺口提醒观众点赞/关注（0 = 不提醒） */
  plugEverySec: number;
  /** 下播后把直播日记发到 B 站动态 */
  diaryToDynamic: boolean;
  /** 读书会总开关（现在关掉：不影响点播） */
  bookMode: boolean;
  /** 现在的人设：甜妹 / 御姐 / 毒舌 */
  persona: 'sweet' | 'cool' | 'sassy';
  /** 深夜电台模式：语速慢、轻声、多读观众来信 */
  radioMode: boolean;
  /** 礼物满多少元，她要说句特别的 */
  unlockYuan: number;
  /** 没人点播时自动放「冬冰 · AI中转站公寓」合集（有人点播优先） */
  autoPlay: boolean;
  /** 合集里任意一集的 BV 号（用它的页面读出整个合集的分集） */
  autoSeasonBv: string;
  /** 每天几点自动下播（HH:MM；空 = 不自动下播） */
  offAt: string;
  /** 自动下播前，多久没人点播才算「没人点」（分钟） */
  offQuietMin: number;
  /** 主人说是自己的直播间（记住常来的观众）；别的房间只旁观、不建档 */
  ownRooms: number[];
  /** 开播时真的推流到 B 站（默认关：只在本地彩排） */
  broadcast: boolean;
  /** 开播用的分区（子分区 id）；null 用 B 站给账号准备的默认分区 */
  areaId: number | null;
  /** 开播前改成这个标题；空串不改 */
  liveTitle: string;
  /** 推流协议：srt（B 站给了就用，跨境、丢包的网络上比 rtmp 稳）或 rtmp */
  pushProtocol: 'srt' | 'rtmp';
  /** 画质档位：1080p 清楚但吃显卡；720p 在核显/弱网下更稳 */
  videoQuality: '1080p' | '720p';
  /** 推流编码器：auto 按机器挑（NVIDIA → NVENC，Intel → QSV，否则 x264） */
  encoder: 'auto' | 'nvenc' | 'qsv' | 'x264';
  /** 推流码率（kbps） */
  streamKbps: number;
  /** 直播间封面图片的路径（本机文件）；空串不换 */
  liveCover: string;
  /** 装了 faster-whisper 的 Python（视频没字幕时听写用）；空串不听写 */
  asrPython: string;
  /** whisper 模型：large-v3-turbo（有显卡）、small（只有 CPU）…… */
  asrModel: string;
  /** 告示板：主人想让观众知道的。空行分页，每页第一行是标题；空串不显示告示板 */
  boardText: string;
  /** 滚动通知：画面最底下一条滚动的字，出状况时告诉观众（卡了、在修、马上回来）；空串不显示 */
  noticeText: string;
  /** 主人定的节奏（秒）：没填的项按直播间热度自动；欢迎填 off 就不欢迎新观众 */
  pace: Pace;
  /** 黑名单：主人拉黑的观众。她不欢迎、不回、不记、不看主页、不私信；别的程序（私信、运营）读这个文件也照着跳过 */
  blocked: BlockedViewer[];
}

export interface BlockedViewer {
  /** B 站 UID */
  uid: string;
  name: string;
  /** 为什么拉黑（主人自己看的） */
  why: string;
  at: number;
}

export interface Pace {
  welcomeSec?: number | 'off';
  thanksSec?: number;
  followSec?: number;
  chatPicks?: number;
}

/** 控制台填的节奏 → 注意力层用的（毫秒） */
function ownerPace(p: Pace | undefined): OwnerPace {
  if (!p) return {};
  return {
    ...(p.welcomeSec === 'off' ? { welcomeOff: true } : p.welcomeSec !== undefined ? { welcomeGapMs: p.welcomeSec * 1000 } : {}),
    ...(p.thanksSec !== undefined ? { thanksGapMs: p.thanksSec * 1000 } : {}),
    ...(p.followSec !== undefined ? { followGapMs: p.followSec * 1000 } : {}),
    ...(p.chatPicks !== undefined ? { chatPicks: p.chatPicks } : {}),
  };
}

/** 告示板默认写的：观众怎么跟她玩 */
export const DEFAULT_BOARD = [
  '想看什么，跟大肥鱼说',
  '说个大概：「想看猫猫」',
  '她自己去 B 站搜、挑来放',
  '找错了告诉她，她再找',
  '',
  '还可以这样玩',
  '让她「看看我的主页」',
  '常来的观众她会记住',
  '她靠字幕听，也会看一眼画面',
  '',
  '大肥鱼是怎么玩游戏的',
  '她自己看游戏画面、想好下一步',
  '下指令给游戏里的身体去做',
  '边玩边回弹幕，没人替她玩',
].join('\n');

/** 机密的名字（DSH 凭据）。豆包的和 dsh-game 共用 */
export const SECRETS = {
  cookie: 'BILIBILI_COOKIE',
  ttsApiKey: 'DOUBAO_TTS_API_KEY',
  ttsAppId: 'DOUBAO_TTS_APP_ID',
  ttsAccessKey: 'DOUBAO_TTS_ACCESS_KEY',
} as const;

export const PRESET_ID = 'dsh-live-farben';

export const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-live-farben');

/** 插件包目录（构建产物在 lib/ 或 lib/chunks/，往上找 package.json） */
export function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name === 'dsh-live-farben') return dir;
    dir = dirname(dir);
  }
  throw new Error('dsh-live-farben: 找不到插件包目录');
}

const SETTINGS_FILE = join(dataDir, 'settings.json');

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
  } catch {
    // 第一次用
  }
  const settings: Settings = {
    roomId: null,
    character: 'dafeiyu',
    template: 'default',
    voice: '',
    stagePort: 7390,
    stageToken: '',
    distillModel: 'deepseek-official/deepseek-flash',
    idleAfterSec: 45,
    gameChatGapSec: 15,
    plugEverySec: 600,
    diaryToDynamic: false,
    bookMode: false,
    persona: 'sweet',
    radioMode: false,
    unlockYuan: 30,
    autoPlay: true,
    autoSeasonBv: 'BV1SBsf6mE3t',
    offAt: '04:00',
    offQuietMin: 20,
    ownRooms: [],
    broadcast: false,
    areaId: null,
    liveTitle: '',
    pushProtocol: 'srt',
    videoQuality: '1080p',
    encoder: 'auto',
    streamKbps: 4500,
    liveCover: '',
    asrPython: '',
    asrModel: 'large-v3-turbo',
    boardText: DEFAULT_BOARD,
    noticeText: '',
    pace: {},
    blocked: [],
    ...saved,
  };
  if (!settings.stageToken) {
    settings.stageToken = randomBytes(12).toString('base64url');
    saveSettings(settings);
  }
  return settings;
}

function saveSettings(next: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

export const settings: Settings = loadSettings();

export function updateSettings(patch: Partial<Settings>): Settings {
  Object.assign(settings, patch);
  saveSettings(settings);
  return settings;
}

/** agent 子插件接上 DSH 的服务后填这里：读机密、调模型 */
export const hooks: {
  secret: (name: string) => Promise<string>;
  /** 存一个机密（扫码登录拿到的 Cookie）；没有凭据服务时抛错 */
  setSecret: (name: string, value: string) => Promise<void>;
  push: (sessionId: string, text: string, now?: boolean) => Promise<boolean>;
  complete: ((model: string, system: string, user: string) => Promise<string>) | null;
  log: (level: 'info' | 'warn', message: string) => void;
} = {
  secret: async (name) => process.env[name] ?? '',
  setSecret: async () => { throw new Error('这个 DSH 没有凭据服务，存不了'); },
  push: async () => false,
  complete: null,
  log: (level, message) => (level === 'warn' ? console.warn : console.log)(`[dsh-live-farben] ${message}`),
};

async function ttsAuth(voice: string): Promise<TtsAuth | null> {
  const [apiKey, appId, accessKey] = await Promise.all([hooks.secret(SECRETS.ttsApiKey), hooks.secret(SECRETS.ttsAppId), hooks.secret(SECRETS.ttsAccessKey)]);
  const auth = { apiKey, appId, accessKey };
  return canSpeak(auth, voice) ? auth : null;
}

export const packs = new Packs(packageDir(), dataDir);

/** 礼物榜 + 礼物知识库（本日/本月 + 按天汇总） */
export const giftBoard = new GiftBoard(dataDir);

export function currentCharacter(): CharacterManifest | null {
  return packs.character(settings.character);
}

export function currentVoice(): string {
  return settings.voice || currentCharacter()?.voice || DEFAULT_VOICE;
}

/** 她能用的表情：角色包里有的 */
export function currentMoods(): string[] {
  const c = currentCharacter();
  const moods = c?.clips?.moods ?? c?.image?.moods ?? {};
  return ['talk', ...Object.keys(moods)];
}

const distill: DistillLlm = async (system, user) => {
  if (!hooks.complete) throw new Error('DSH 的模型服务还没接上');
  return hooks.complete(settings.distillModel, system, user);
};

export const show = new LiveShow(
  {
    push: (sessionId, text, now) => hooks.push(sessionId, text, now),
    synthesize: (text, signal, voice) => {
      if (voice) return speech(text, signal, voice);
      const ready = prepared.get(`${currentVoice()}|${text}`);
      if (ready) {
        prepared.delete(`${currentVoice()}|${text}`);
        return ready.catch(() => speech(text, signal));
      }
      return speech(text, signal);
    },
    distill,
    log: (level, message) => hooks.log(level, message),
    persist: (snapshot) => saveLive(snapshot),
    onGame: (source) => placeGame(source),
  },
  { dataDir, names: currentCharacter()?.names ?? [], idleAfterMs: () => settings.idleAfterSec * 1000, pace: () => ownerPace(settings.pace), board: () => settings.boardText, title: () => settings.liveTitle, gameChatGapMs: () => (settings.gameChatGapSec ?? 15) * 1000, plugEverySec: () => settings.plugEverySec, autoNext, bookMode: () => settings.bookMode, bookByQuery: (query) => { const books = listBooks(join(dataDir, 'books')); const found = books.find((b) => b.title.includes(query) || query.includes(b.title)); if (!found) return null; const book = loadBook(join(dataDir, 'books'), found.id); if (!book) return null; show.openBook(book); return book.title; }, songByQuery: (query) => { const hit = matchSong(listSongs(join(dataDir, 'songs')), query); return hit ? songRequest(hit) : null; }, blocked: (uid) => settings.blocked.some((b) => b.uid === uid), onDiary: (text) => { if (!settings.diaryToDynamic) return; void social.postDynamic(text).then(() => hooks.log?.('info', '直播日记已发 B 站动态')).catch((err) => hooks.log?.('warn', '直播日记发动态失败：' + (err as Error).message)); }, styleLine: () => { const p = settings.persona; const personaLine = p === 'cool' ? '现在的人设：御姐，冷静、话少、偶尔毒舌，不撒娇。' : p === 'sassy' ? '现在的人设：毒舌，嘴硬心软，爱吐槽但不伤人。' : '现在的人设：甜妹，软、黏人、爱撒娇，多用语气词。'; const radio = settings.radioMode ? ' 另外现在是深夜电台：语速慢一点、声音轻一点，多读观众来信和小故事，少用夸张语气。' : ''; return '（主持设定，这一轮也按这个来：' + personaLine + radio + '）'; }, unlockYuan: () => settings.unlockYuan, giftLog: (e) => { giftBoard.add(e); const data = giftBoard.summary(); show.stage.broadcast({ type: 'gifts', today: data.today, month: data.month }); }, stopVisit: () => { void watchRoom(null).catch(() => undefined); } },
);

/**
 * 游戏画面上 OBS：窗口画面（Minecraft 摄像机客户端）由 OBS 抓，摆在舞台的游戏位上、垫在舞台下面；
 * 网页画面舞台自己放，OBS 里不用加东西。连不上 OBS（没开、只在本机预览）就算了
 */
export function placeGame(source: GameSource | null): void {
  const template = packs.template(settings.template);
  const windowSource = source && 'window' in source ? source : null;
  void (async () => {
    let obs: Awaited<ReturnType<typeof connectObs>> | null = null;
    try {
      obs = await connectObs(false);
      await showGameSources(obs, windowSource, template ? gameRect(template) : { x: 0, y: 0, w: 1920, h: 1080 });
      hooks.log('info', windowSource ? `游戏画面上舞台：${windowSource.window}` : '游戏画面撤下');
    } catch (err) {
      hooks.log('warn', `游戏画面没能放进 OBS：${(err as Error).message}`);
    } finally {
      obs?.close();
    }
  })();
}

/** 查房：正在放的对方房间（自动收起的定时器） */
let roomTimer: NodeJS.Timeout | null = null;

/** 上一次查房失败的原因（给工具回话用，方便她告诉观众） */
export let lastRoomError = '';

/** 把 B 站直播流包一层本地代理：OBS 直接拉会 403（不带 Referer/UA） */
function roomProxy(src: string): string {
  const base = new URL(server.url);
  return `http://127.0.0.1:${base.port}/room?token=${encodeURIComponent(base.searchParams.get('token') ?? '')}&src=${encodeURIComponent(src)}`;
}

/** 把别人直播间的画面拉到 OBS 舞台上（视频位），最多放 minutes 分钟；传 null 就撤掉 */
export async function watchRoom(url: string | null, title = '', minutes = 3, room = 0): Promise<boolean> {
  lastRoomError = '';
  const template = packs.template(settings.template);
  // 和点播视频一模一样的位置和大小
  const rect = template ? videoRect(template) : { x: 0, y: 0, w: 1920, h: 1080 };
  let obs: Awaited<ReturnType<typeof connectObs>> | null = null;
  try {
    obs = await connectObs(false);
    await showRoomStream(obs, url ? roomProxy(url) : null, rect);
  } catch (err) {
    lastRoomError = (err as Error).message;
    hooks.log('warn', `查房画面没能放进 OBS：${(err as Error).message}`);
    return false;
  } finally {
    obs?.close();
  }
  if (roomTimer) clearTimeout(roomTimer);
  roomTimer = null;
  if (url) {
    // 分钟数夹在 1～10 之间：3 就是 3 分钟（之前写成 Math.max(30, …) 变成了最少 30 分钟，倒计时显示 30:00）
    const keepMinutes = Math.max(1, Math.min(10, Number(minutes) || 3));
    show.beginVisit(keepMinutes);
    show.stage.broadcast({ type: 'visit', visit: { room, title: title || '别人的直播间', until: Date.now() + keepMinutes * 60_000 } });
    show.stage.broadcast({ type: 'notice', text: `查房中：${title || '别人的直播间'}` });
    roomTimer = setTimeout(() => void watchRoom(null).catch(() => undefined), keepMinutes * 60_000);
  } else {
    if (roomTimer) clearTimeout(roomTimer);
    roomTimer = null;
    show.endVisit();
    show.stage.broadcast({ type: 'visit', visit: null });
    show.stage.broadcast({ type: 'notice', text: '' });
  }
  return true;
}

/** 告示板换了：舞台马上换（之后连上的舞台页也拿到最新的） */
export function publishBoard(): void {  show.stage.broadcast({ type: 'board', text: settings.boardText });
}
publishBoard();

/** 滚动通知换了：舞台马上换 */
export function publishNotice(): void {
  show.stage.broadcast({ type: 'notice', text: settings.noticeText ?? '' });
}
publishNotice();

async function speech(text: string, signal: AbortSignal, voice = currentVoice()): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null> {
  const auth = await ttsAuth(voice);
  if (!auth) return null;
  const { audio, words } = await synthesize(auth, voice, text, signal);
  return { audio, timeline: subtitleTimeline(text, words) };
}

/** 提前合成好的句子（念稿时先合成、念的时候直接用，句和句之间不空等）：音色|文字 → 语音 */
const prepared = new Map<string, Promise<Awaited<ReturnType<typeof speech>>>>();

/** 提前合成一句（text 是 speakable 处理过的那段）；最多留 40 句，用掉就删 */
export function prepareSpeech(text: string): void {
  const key = `${currentVoice()}|${text}`;
  if (!text || prepared.has(key)) return;
  prepared.set(key, speech(text, AbortSignal.timeout(60_000)));
  while (prepared.size > 40) prepared.delete(prepared.keys().next().value!);
}

export const server = new StageServer({
  port: settings.stagePort,
  token: settings.stageToken,
  packageDir: packageDir(),
  packs,
  stage: show.stage,
  current: () => ({ character: settings.character, template: settings.template }),
  songs: join(dataDir, 'songs'),
  mediaDir: join(dataDir, 'media'),
  scenesDir: join(dataDir, 'scenes'),
  media: {
    source: (id) => show.player.source(id),
    report: (id, state, positionSec, detail) => show.player.report(id, state, positionSec, detail),
  },
  log: (level, message) => hooks.log(level, message),
});

export async function cookie(): Promise<string> {
  // 先问 DSH 的凭据服务；插件开播前还没有 agent 会话时它可能还没装上，读不到就用凭据文件兜底
  const hit = await hooks.secret(SECRETS.cookie).catch(() => '');
  if (hit && hit.includes('=')) return hit;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const file = join(home, '.credentials.yaml');
  if (!existsSync(file)) return hit ?? '';
  try {
    const text = readFileSync(file, 'utf8');
    const at = text.indexOf('BILIBILI_COOKIE:');
    if (at < 0) return hit ?? '';
    const rest = text.slice(at + 'BILIBILI_COOKIE:'.length);
    const lines: string[] = [];
    for (const raw of rest.split(/\r?\n/)) {
      if (!raw.trim()) {
        if (lines.length) break;
        continue;
      }
      if (!/^\s/.test(raw)) break;
      lines.push(raw.trim());
    }
    const cookieText = lines.join(' ').trim();
    return cookieText.includes('=') ? cookieText : (hit ?? '');
  } catch {
    return hit ?? '';
  }
}

/** 推流到 B 站：开播拿推流码、OBS 推流、下播 */
export const broadcast = new Broadcast({
  cookie,
  stageUrl: () => server.url,
  areaId: () => settings.areaId,
  title: () => settings.liveTitle.trim() || null,
  protocol: () => settings.pushProtocol,
  quality: () => settings.videoQuality,
  encoder: () => settings.encoder,
  kbps: () => settings.streamKbps,
  cover: () => {
    const file = settings.liveCover.trim();
    if (!file || !existsSync(file)) return null;
    const ext = extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { data: new Uint8Array(readFileSync(file)), mime };
  },
  // 开播账号的直播间：记下来、标成自己的直播间（记住观众），连上它的弹幕
  onRoom: (roomId) => {
    updateSettings({ roomId, ownRooms: [...new Set([...settings.ownRooms, roomId])] });
    const status = show.status();
    if (status.roomId !== roomId || status.live.state === 'idle' || status.live.state === 'error') {
      void cookie().then((c) => show.connect(roomId, c, true));
    } else {
      show.rememberViewers = true;
    }
  },
  onStreaming: () => show.markBroadcast(),
  log: (level, message) => hooks.log(level, message),
});

// 推流看门狗：OBS 会“假推”（状态还在推、时间码不动、B 站收不到数据）。
// 每 15 秒看一次推流时长，连续 3 次（约 45 秒）没变就自动停推重推。
let lastStreamTick = { timecode: '', still: 0 };
setInterval(() => {
  try {
    const status = broadcast.status();
    if (status.phase !== 'streaming' || !status.health) {
      lastStreamTick = { timecode: '', still: 0 };
      return;
    }
    const timecode = status.health.timecode;
    if (timecode && timecode === lastStreamTick.timecode) lastStreamTick.still += 1;
    else lastStreamTick = { timecode, still: 0 };
    if (lastStreamTick.still >= 3) {
      lastStreamTick.still = 0;
      hooks.log('warn', '推流 45 秒没有新数据（假推），自动重推');
      void broadcast
        .stop()
        .catch(() => undefined)
        .then(() => broadcast.start());
    }
  } catch {
    // 看门狗自己出错不影响直播
  }
}, 15_000).unref?.();

// 插件重启后，OBS 里可能还留着上次查房没来得及撤的画面源：启动时清掉，别一直盖着舞台
setTimeout(() => void watchRoom(null).catch(() => undefined), 4000).unref?.();

// 巡检：没在串门却还有查房画面源（定时器被重启打断、流程出错），就悄悄清掉，别让它一直播下去
setInterval(() => {
  if (show.isVisiting) return;
  void (async () => {
    let obs: Awaited<ReturnType<typeof connectObs>> | null = null;
    try {
      obs = await connectObs(false);
      await clearRoomStream(obs);
    } catch {
      // OBS 没开 / 连不上：下次再说
    } finally {
      obs?.close();
    }
  })();
}, 20_000).unref?.();

// 千问健康检查：连续 3 次调不通就把 modelFallback 打开，控制台看到后把会话切到 DeepSeek
let modelDown = 0;
let modelFallback = false;
export function modelFallbackActive(): boolean {
  return modelFallback;
}
setInterval(async () => {
  try {
    const key = await hooks.secret('QWEN_API_KEY');
    if (!key) return;
    const res = await fetch('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      modelDown = 0;
      modelFallback = false;
      return;
    }
    modelDown += 1;
  } catch {
    modelDown += 1;
  }
  if (modelDown >= 3 && !modelFallback) {
    modelFallback = true;
    hooks.log('warn', '千问连续 3 次调不通，切到 DeepSeek');
  }
}, 90_000).unref?.();

/** 她给观众发私信（开播账号）：B 站「对方没关注只能发一条」等规矩在这里管 */
export const dm = new DmManager(new BiliAccount(cookie), join(dataDir, 'dm.json'));

// ── 断点续播：在播的这一场存在磁盘上，插件（DSH）重启后接着播 ──

const LIVE_FILE = join(dataDir, 'live.json');

function saveLive(snapshot: LiveSnapshot | null): void {
  try {
    if (!snapshot) rmSync(LIVE_FILE, { force: true });
    else writeFileSync(LIVE_FILE, JSON.stringify({ ...snapshot, broadcasting: broadcast.streaming }));
  } catch (err) {
    hooks.log('warn', `存不了直播状态：${(err as Error).message}`);
  }
}

/** 上次停下时还在播的那一场（没有返回 null）；读了就删，接上以后会重新存 */
/** agent 子插件（她的会话）起来、装好推消息的钩子了没有 */
let agentAttached = false;
export const agentReady = (): boolean => agentAttached;
export function markAgentReady(): void {
  agentAttached = true;
}

export function takeLive(): (LiveSnapshot & { broadcasting: boolean }) | null {
  try {
    const saved = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as LiveSnapshot & { broadcasting: boolean };
    rmSync(LIVE_FILE, { force: true });
    return saved?.sessionId ? saved : null;
  } catch {
    return null;
  }
}

/** 她点赞、看评论、发评论、看收件箱（开播账号） */
export const social = new SocialManager(new BiliSocial(cookie));

/** 直播时每隔一会儿看一眼收件箱：开播以后新来的私信、回复、@，没别的事时告诉她 */
const INBOX_EVERY_MS = 90_000;
setInterval(() => {
  if (!show.isOnAir) return;
  void social.newSince().then((lines) => { if (lines.length) show.notifyInbox(lines); }).catch(() => {});
}, INBOX_EVERY_MS).unref?.();

/** 她搜视频、看视频、在舞台上放视频（开播账号的 Cookie：AI 字幕要登录才给） */
export const videos = new BiliVideos(cookie);

/** 自动播放合集：缓存分集列表，循环往下放；有人点播会被打断 */
let autoSeason: Array<{ bvid: string; title: string }> = [];
let autoCursor = 0;
/** 最近自动播过的分集：20 分钟内不重播同一集（合集只有几集时不至于一集接一集重复） */
const autoRecent: Array<{ bvid: string; at: number }> = [];
function autoRemember(bvid: string): void {
  autoRecent.push({ bvid, at: Date.now() });
  while (autoRecent.length > 20) autoRecent.shift();
}
function autoPlayedRecently(bvid: string): boolean {
  const now = Date.now();
  return autoRecent.some((r) => r.bvid === bvid && now - r.at < 20 * 60_000);
}

async function loadAutoSeason(): Promise<Array<{ bvid: string; title: string }>> {
  if (autoSeason.length) return autoSeason;
  const bv = settings.autoSeasonBv || 'BV1SBsf6mE3t';
  const body = await videos.get<any>(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
  const season = body?.data?.ugc_season;
  const list: Array<{ bvid: string; title: string }> = [];
  for (const section of season?.sections ?? []) {
    for (const ep of section.episodes ?? []) {
      if (ep?.bvid) list.push({ bvid: String(ep.bvid), title: String(ep.title ?? '') });
    }
  }
  autoSeason = list;
  autoCursor = 0;
  return autoSeason;
}

async function autoNext(): Promise<PlayRequest | null> {
  if (!settings.autoPlay || !settings.autoSeasonBv) return null;
  const list = await loadAutoSeason();
  if (!list.length) return null;
  for (let i = 0; i < list.length; i++) {
    const item = list[autoCursor++ % list.length];
    // 20 分钟内播过的不再重复；整圈都播过了才允许从头来
    if (autoPlayedRecently(item.bvid) && i < list.length - 1) continue;
    const ref = await videos.resolve(item.bvid);
    if (!ref) continue;
    const info = await videos.info(ref);
    const part = info?.parts?.[0];
    if (!info || !part) continue;
    const total = info.durationSec || part.durationSec || 0;
    if (total > 600) continue;
    const url = await videos.playUrl(info.bvid, part.cid);
    if (!url) continue;
    autoRemember(info.bvid);
    return {
      bvid: info.bvid,
      title: info.title || item.title,
      up: info.up?.name ?? '',
      url,
      fromSec: 0,
      untilSec: total || 600,
      durationSec: total,
      auto: true,
    };
  }
  return null;
}

/** 视频没字幕时听写（本机的 faster-whisper） */
export const asr = new Whisper({
  python: () => settings.asrPython,
  model: () => settings.asrModel.trim() || 'large-v3-turbo',
  script: join(packageDir(), 'assets', 'asr', 'whisper_worker.py'),
  dataDir,
  log: (level, message) => hooks.log(level, message),
});

/** 视频库：她看过、放过的视频（详情、字幕、原视频弹幕、每次看的记录），存在 <dataDir>/videos */
export const library = new VideoLibrary(join(dataDir, 'videos'), (message) => hooks.log('warn', message));
