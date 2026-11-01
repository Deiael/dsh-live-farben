/**
 * agent 子插件：挂在「大肥鱼直播」预设下（见 cordis.patch.yml），接上 DSH 的服务，盯着她直播的会话。
 *
 * 只有一个说话出口：她回复的正文。会话里每出现一条带正文的 assistant 消息就念一条（写出一段念一段），
 * 每条只念一次。正文里的 [表情] 标记（角色包里有的）把话切成几段，每段带着自己的表情念：说着说着可以换表情。
 * 只发工具调用、没写正文的消息很正常（她在做事），没有要念的就跳过。
 * 没有说话工具、没有 say 参数：那种「要模型自己选择用的通道」在 HiyoriAI 和 dsh-game 里都踩过坑（她会不用）。
 *
 * 身体往会话里推一件事：DSH 的 agent 句柄 followup（追加一条消息并唤醒她）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listSongs, matchSong, songRequest } from '../body/songLibrary';
import { cacheVideo, pruneVideos } from '../body/mediaCache';
import { listBooks, loadBook, saveBook } from '../body/books';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { fetchProfile, profileSummary, profileText } from '../body/biliProfile';
import { clock, infoText, searchText, subtitleText, type Subtitles, type VideoInfo, type VideoPart } from '../body/biliVideo';
import { VideoNotes } from '../body/watchAlong';
import { lookupProblem } from '../core/viewerLookup';
import { splitByMood } from '../core/moodText';import { orderTags } from '../core/orders';
import { ttsYuan, turnYuan } from '../core/cost';
import { asr, cookie, currentMoods, dataDir, dm, giftBoard, hooks, lastRoomError, library, markAgentReady, settings, show, social, videos, watchRoom } from './runtime';
import { BiliRoom } from '../body/biliRoom';
import { screenshot } from '../body/obs';
import { whoIs } from '../body/biliLogin';
import { COMMENT_GAP_MS, FAVORITE_FOLDER, MAX_COMMENT_CHARS } from '../body/social';

export const name = 'dsh-live-farben-agent';
export const inject = ['tools'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  get?(name: string): any;
  [service: string]: any;
}

/** 已经念过的消息：会话 id + 消息序号 */
const voiced = new Set<string>();

/**
 * 直播线这一轮交给游戏线了没有：从调 game_side 的那条消息起，这一轮她写的话都不念（游戏里的她会点名回观众），下一轮重新算。
 * 只看调工具的那一条的话，她先调工具、下一条才写「交过去了」时会念出来，观众就听到两边各回一遍。
 */
export class HandOffs {
  private sessions = new Set<string>();

  turnStarted(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 这条消息不念（这一轮已经交出去了）返回 true */
  unsaid(sessionId: string, event: any): boolean {
    if ((event?.data?.message?.content ?? []).some((p: any) => p?.type === 'tool-call' && p.name === 'game_side')) this.sessions.add(sessionId);
    return this.sessions.has(sessionId);
  }
}

const wordsOf = (event: any): string => (event?.data?.message?.content ?? [])
  .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
  .map((p: any) => p.text.trim()).filter(Boolean).join('\n');

/**
 * 盯着直播的会话：新的正文就念，一轮开始、结束告诉身体。
 * 有游戏线时两个会话一起盯：游戏线的话也念（嘴里排满了就少念一句），它的时刻里摘出游戏现在怎样，写给直播线
 */
const cursors = new Map<string, number>();
const handOffs = new HandOffs();
let watching = false;
/** 这场直播（她的会话，有游戏线时两个加起来）累计用掉的 token 和钱：舞台上换算成她吃了多少饭，show_stats 告诉她 */
const freshUsage = (sessionId: string) => ({ sessionId, tokens: 0, input: 0, cacheRead: 0, output: 0, yuan: 0, priced: true, model: '' });
let usage = freshUsage('');
/** 游戏线最近一个时刻里的进度、身体、背包，和她在游戏线上最近说的一句 */
let gameMoment = '';
let gameWords = '';

function countUsage(sessionId: string, event: any, broadcast = true): void {
  const u = event?.data?.usage;
  const turn = Number(u?.totalTokens);
  if (!Number.isFinite(turn) || turn <= 0) return;
  if (usage.sessionId !== sessionId) usage = freshUsage(sessionId);
  usage.tokens += turn;
  usage.input += Number(u.inputTokens) || 0;
  usage.cacheRead += Number(u.cacheReadTokens) || 0;
  usage.output += Number(u.outputTokens) || 0;
  const model = event?.data?.message?.source?.model;
  if (typeof model === 'string') usage.model = model;
  const yuan = turnYuan(model, u, Number(event?.time) || Date.now());
  if (yuan === null) usage.priced = false; else usage.yuan += yuan;
  if (broadcast) show.stage.broadcast({ type: 'usage', tokens: usage.tokens, turn, ...(usage.priced ? { yuan: Math.round(usage.yuan * 10000) / 10000 } : {}), ...(typeof model === 'string' ? { model } : {}) });
}

/** dsh-game 的时刻里摘出直播线要知道的：进度（位置、白天黑夜、血量饥饿）、身体在干什么、背包 */
export function momentSummary(text: string): string {
  const pick = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? '';
  const progress = pick(/【进度】([^\n]+)/);
  if (!progress) return '';
  const body = pick(/【说明】(身体[^\n]+)/);
  const bag = pick(/【说明】背包：([^\n]+)/).replace(/\s*等\s*(\d+)\s*种\s*$/, '……（一共 $1 种，这里只列了一部分：没列出的不等于没有）');
  // 背包整行给（以前截到 120 字，背包一满，钻石剑这些排在后面的就被截掉，她当着观众说「没有钻石剑」）
  return [progress, body, bag && `背包：${bag}`].filter(Boolean).join('；');
}

function publishGameNow(moment = false): void {
  show.setGameNow([gameMoment, gameWords && `你刚在游戏里说：「${gameWords}」`].filter(Boolean).join('；'), moment);
}

function watchSession(ctx: AgentContext, sessionId: string, line: 'live' | 'game' | 'repair'): void {
  const session = ctx.get?.('sessions')?.get?.(sessionId);
  if (!session) return;
  const total = show.currentSession ?? sessionId;
  // 刚开始盯这个会话：只管从现在起的新事件；用量从头补算（插件重启后接着播时，饭量不清零）
  if (!cursors.has(sessionId)) {
    cursors.set(sessionId, Number(session.seq));
    if (line === 'live') usage = freshUsage(sessionId);
    for (const event of (session.snapshotEvents(0) as any[]) ?? []) if (event?.type === 'assistant/message') countUsage(total, event, false);
    if (usage.tokens) show.stage.broadcast({ type: 'usage', tokens: usage.tokens, turn: 0, ...(usage.model ? { model: usage.model } : {}) });
    return;
  }
  const events = session.snapshotEvents(cursors.get(sessionId)) as any[];
  cursors.set(sessionId, Number(session.seq));
  for (const event of events) {
    if (event?.type === 'turn/start') {
      handOffs.turnStarted(sessionId);
      show.turnStarted(sessionId);
    }
    else if (event?.type === 'turn/end') show.turnEnded(sessionId);
    else if (event?.type === 'tool/result' && line === 'game') {
      const moment = wordsOf(event);
      const summary = momentSummary(moment);
      if (summary) {
        gameMoment = summary;
        show.setGameMomentFull(moment);
        publishGameNow(true);
      }
    } else if (event?.type === 'assistant/message') {
      countUsage(total, event);
      const key = `${sessionId}:${event.seq}`;
      if (voiced.has(key)) continue;
      voiced.add(key);
      const handedOff = line === 'live' && handOffs.unsaid(sessionId, event);
      let words = wordsOf(event);
      if (line === 'game') {
        const tagged = orderTags(words);
        if (tagged.marks.length) show.markOrders(tagged.marks);
        words = tagged.text;
      }
      if (!words) continue;
      // 小钢炮（维修线）：只把话放进右上角气泡，不出声、不抢鱼煲的麦
      if (line === 'repair') {
        show.repairSay(words);
        continue;
      }
      // 直播线把这件事交给了游戏线（game_side）：这条和这一轮后面写的都不念，由游戏里的她点名回观众
      if (handedOff) {
        show.unsaid(words, '交给游戏线回');
        continue;
      }
      if (line === 'game') {
        gameWords = words.replace(/\[[a-z]+\]/g, '').trim().slice(0, 80);
        publishGameNow();
      }
      // 交给嘴排队念（嘴一次念一句，按交来的先后），不在这里等念完：
      // 「这一轮结束了」要马上让导演知道，导演自己看嘴里还排着几句再决定推不推下一件
      for (const part of splitByMood(words, currentMoods())) {
        void show.say(part.text, part.mood, AbortSignal.timeout(300_000), line).catch((err) => hooks.log('warn', `念她的话出错：${(err as Error).message}`));
      }
    }
  }
}

async function watch(ctx: AgentContext): Promise<void> {
  const sessionId = show.currentSession;
  if (!sessionId || watching) return;
  watching = true;
  try {
    // 换了一场（另一个会话）：游戏线的摘要也清掉
    if (!cursors.has(sessionId)) {
      cursors.clear();
      gameMoment = '';
      gameWords = '';
    }
    watchSession(ctx, sessionId, 'live');
    const game = show.currentGameSession;
    if (game && game !== sessionId) watchSession(ctx, game, 'game');
    const repair = show.currentRepairSession;
    if (repair && repair !== sessionId) watchSession(ctx, repair, 'repair');
  } finally {
    watching = false;
  }
}

/**
 * 往她的会话里推一条消息并唤醒她；会话不在线返回 false。
 * 平时用 followup（排到下一轮：她这一轮做完再看）；now 用 steer（插进这一轮的下一步：
 * 她在玩游戏时一轮可以很长，用 followup 的话直播间的事要等她这一轮停下才看得到）
 */
async function push(ctx: AgentContext, sessionId: string, text: string, now = false): Promise<boolean> {
  const agents = ctx.get?.('agents');
  const found = agents?.get?.(sessionId);
  const agent = found?.followup ? found : found?.agent;
  if (!agent?.followup) return false;
  // 和 DSH 自己的 createUserMessage 一样：带 id、role，冻结（消息进会话后不能再改）
  const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-live-farben' } });
  if (now && agent.steer) await agent.steer(message);
  else await agent.followup(message);
  return true;
}

/** 钱数写给她看：不到一分钱就说不到一分钱 */
function money(yuan: number): string {
  return yuan < 0.01 ? '不到 1 分钱' : `${yuan.toFixed(2)} 元`;
}

/** B 站没给时长时，不指定就放这么久（秒） */
const PLAY_UNKNOWN_SEC = 600;
/** play_video 最多等舞台多久确认开始放 */
const PLAY_CONFIRM_MS = 15_000;
/** 找视频最多花这么久：超了就让她说没找到，别一直搜 */
const FIND_DEADLINE_MS = 20_000;
/** 点播视频最长 20 分钟；超过这个长度要粉丝团 10 级以上才给点 */
const MAX_VIDEO_SEC = 20 * 60;
/** 点长视频需要的粉丝团等级（严格大于） */
const LONG_VIDEO_FAN_LEVEL = 10;
/** 超长视频的提示 */
const LONG_VIDEO_NOTE = `超过 20 分钟的视频要粉丝团 ${LONG_VIDEO_FAN_LEVEL} 级以上才能点哦。`;

/** 最多等 ms，超时返回 null（调用方告诉观众没找到，别再重试） */
function withDeadline<T>(promise: Promise<T>, ms = FIND_DEADLINE_MS): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
}

/** 曲库没有时：去 B 站找「歌名 翻唱/伴奏」，下到本地，当现学版播 */
async function findCover(query: string): Promise<{ request: PlayRequest; title: string } | null> {
  for (const suffix of [' 翻唱', ' 伴奏', '']) {
    const found = await videos.search(`${query}${suffix}`, { order: 'views' });
    for (const hit of found?.hits ?? []) {
      if (!hit.durationSec || hit.durationSec < 45 || hit.durationSec > MAX_VIDEO_SEC) continue;
      const ref = await videos.resolve(hit.bvid);
      if (!ref) continue;
      const info = await videos.info(ref);
      const part = info?.parts?.[0];
      if (!info || !part) continue;
      const url = await videos.playUrl(info.bvid, part.cid);
      if (!url) continue;
      const cached = await cacheVideo(join(dataDir, 'media'), info.bvid, url);
      const src = cached ? `/media?id=${info.bvid}` : undefined;
      return {
        title: info.title,
        request: {
          bvid: info.bvid,
          title: info.title,
          up: info.up?.name ?? '',
          url,
          fromSec: 0,
          untilSec: info.durationSec || part.durationSec || 240,
          durationSec: info.durationSec || part.durationSec,
          ...(src ? { src } : {}),
        },
      };
    }
  }
  return null;
}

/** 「1:30」「90」→ 秒 */
function seconds(value: unknown): number {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (!text) return 0;
  return Math.max(0, text.split(':').reduce((sum, n) => sum * 60 + (Number(n) || 0), 0));
}

/** 她说的一个人：私信过她的人、直播间里的观众（名字或 UID），或者任何 UID；认不出时返回告诉她怎么改的话 */
function person(who: string): { uid: string; name: string } | string {
  const w = who.trim();
  const talker = social.findTalker(w);
  if (talker) return talker;
  const viewer = show.lookupViewer(w);
  if (viewer.kind === 'found') return { uid: viewer.uid, name: viewer.user.name };
  if (/^\d{1,20}$/.test(w)) return { uid: w, name: `UID ${w}` };
  return lookupProblem(w, viewer);
}

/** 她给的视频（BV 号、av 号、链接）和第几 P → 视频详情；认不出、找不到时返回告诉她怎么改的话 */
async function findVideo(video: unknown, part: unknown): Promise<{ info: VideoInfo; part: VideoPart } | string> {
  const text = String(video ?? '').trim();
  const ref = await videos.resolve(text);
  if (!ref) return `没认出「${text.slice(0, 40)}」是哪个视频：video 填 BV 号（BV 开头的 12 位，search_videos 的结果和 view_profile 的投稿里都有）、av 号或者视频链接。`;
  const info = await videos.info(ref);
  if (!info) return `${ref.bvid ?? `av${ref.aid}`} 打不开：可能没有这个视频、被删了，或者 B 站没返回（网络问题）。检查一下号码。`;
  const page = Math.floor(Number(part) || ref.part || 1);
  const found = info.parts.find((p) => p.page === page);
  if (!found) return `「${info.title}」只有 ${info.parts.length} P，没有 P${page}。`;
  return { info, part: found };
}

/** 视频没字幕：听 from 所在的那一段（没配语音识别、听失败返回 null，照「没有字幕」说） */
async function listen(info: VideoInfo, part: VideoPart, from: number): Promise<Subtitles | null> {
  try {
    const heard = await asr.chunk({ bvid: info.bvid, cid: part.cid, durationSec: part.durationSec }, from, () => videos.audioUrl(info.bvid, part.cid),
      (text) => show.note('listen', `Whisper「${info.title.slice(0, 12)}」${text}`));
    const sub: Subtitles | null = heard ? { kind: 'asr', lang: heard.lang, lines: heard.lines, until: heard.until, engine: settings.asrModel } : null;
    library.subtitles(info, part, sub);
    return sub;
  } catch (err) {
    hooks.log('warn', `语音识别失败（${info.bvid}）：${(err as Error).message}`);
    return null;
  }
}

/** 视频库：B 站字幕拿到就存一份 */
async function officialSubtitles(info: VideoInfo, part: VideoPart): Promise<Subtitles | null> {
  const sub = await videos.subtitles(info.bvid, part.cid);
  library.subtitles(info, part, sub);
  return sub;
}

/** 原视频弹幕：拿到就进视频库 */
async function videoDanmaku(info: VideoInfo, part: VideoPart) {
  const list = await videos.danmaku(part.cid);
  library.danmaku(info, part, list);
  return list;
}

/** 视频库记一次看 / 放：哪场、点之前直播间在聊什么 */
function libraryView(how: 'watch' | 'play', fromSec: number, untilSec?: number) {
  const logName = show.logName;
  const chat = show.recentChat();
  return { how, at: Date.now(), fromSec, ...(untilSec !== undefined ? { untilSec } : {}), ...(logName ? { show: logName } : {}), ...(chat.length ? { chat } : {}) };
}

/** 调一次模型（下播提炼记忆）：不思考，只要文字 */
async function completeWithDsh(ctx: AgentContext, model: string, system: string, user: string): Promise<string> {
  const llm = ctx.get?.('llm');
  if (!llm) throw new Error('DSH 的模型服务不可用');
  const slash = model.indexOf('/');
  let out = '';
  for await (const chunk of llm.stream({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    system,
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-live-farben' } }],
    maxTokens: 3000,
    reasoningEffort: 'off',
    purpose: 'dsh-live-farben-memory',
    signal: AbortSignal.timeout(120_000),
  })) {
    if (chunk.type === 'text-delta') out += chunk.text;
  }
  return out.trim();
}

export function apply(ctx: AgentContext): void {
  hooks.secret = async (name) => {
    const credentials = ctx.get?.('credentials');
    const hit = credentials ? await credentials.resolve(name).catch(() => undefined) : undefined;
    return hit?.value ?? process.env[name] ?? '';
  };
  hooks.setSecret = async (name, value) => {
    const credentials = ctx.get?.('credentials');
    if (!credentials?.set) throw new Error('这个 DSH 没有凭据服务，存不了');
    await credentials.set(name, value);
  };
  hooks.complete = (model, system, user) => completeWithDsh(ctx, model, system, user);
  hooks.push = (sessionId, text, now) => push(ctx, sessionId, text, now);
  markAgentReady();
  // 警告也打到 stderr：DSH 网页版的日志只在内存里，服务器上看 web.log 才找得到
  if (ctx.logger) hooks.log = (level, message) => {
    ctx.logger[level]?.(`dsh-live-farben: ${message}`);
    if (level === 'warn') console.warn(`[dsh-live-farben] ${message}`);
  };

  ctx.effect(() => {
    const timer = setInterval(() => void watch(ctx).catch((err) => hooks.log('warn', `盯会话出错：${(err as Error).message}`)), 300);
    return () => clearInterval(timer);
  }, 'dsh-live-farben session watch');

  // 看观众的 B 站主页（公开信息）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'view_profile',
    description: '看一个 B 站个人主页：等级、签名、粉丝和关注数、最近投稿、置顶视频、代表作、空间公告、有没有直播间、头像图片的网址。'
      + '可以看观众的，也可以看你自己开播账号的。只看得到主页上公开的东西。要几秒钟。',
    parameters: {
      who: { type: 'string', required: true, description: '观众的名字（照消息里写的）或 UID；看你自己开播账号的主页填「自己」' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '');
      if (who.trim() === '自己') {
        const me = await whoIs(await cookie());
        if (!me) return '开播账号现在没登录，看不了自己的主页。';
        show.toolCall('view_profile', me.name, '在看自己的主页');
        const profile = await fetchProfile(String(me.uid), await cookie());
        return profile ? `你自己的开播账号（${me.name}，UID ${me.uid}）：
${profileText(profile)}` : '没打开自己的主页（B 站没返回，可能是网络问题）。';
      }
      const viewer = show.lookupViewer(who);
      if (viewer.kind !== 'found') return lookupProblem(who, viewer);
      if (show.isBlocked(viewer.uid)) return `${viewer.user.name} 在主人的黑名单上，不和他来往，主页也不看。`;
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} 说过不想被记住，他的主页就不看了。`;
      show.toolCall('view_profile', viewer.how === 'unseen-uid' ? `UID ${viewer.uid}` : viewer.user.name, viewer.how === 'unseen-uid' ? `在看 UID ${viewer.uid} 的主页` : `在看${viewer.user.name}的主页`);
      const profile = await fetchProfile(viewer.uid, await cookie());
      if (!profile) return viewer.how === 'unseen-uid' ? `UID ${viewer.uid} 打不开：可能没有这个用户，检查一下数字。` : `没打开 ${viewer.user.name} 的主页（B 站没返回，可能是网络问题）。`;
      const marks = [
        viewer.user.guardLevel ? ['', '总督', '提督', '舰长'][viewer.user.guardLevel] : '',
        viewer.user.medal?.ofThisRoom ? `粉丝牌${viewer.user.medal.level}级` : '',
        viewer.user.isAdmin ? '房管' : '',
      ].filter(Boolean).join('，');
      show.rememberProfile(viewer.uid, profileSummary(profile));
      // 按名字的一部分找到的：告诉她是谁，对不上可以换 UID 再查
      const note = viewer.how === 'partial' ? `（按「${who}」找到的是 ${profile.name}；不是他的话，用 UID 再查）\n` : '';
      return note + profileText(profile, marks || undefined);
    },
  })), 'view_profile tool');

  // 私信观众（开播账号发）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'send_dm',
    description: '用开播账号给一个人发一条 B 站私信（文字）：直播间里的观众、私信过你的人，或者任何 B 站用户（填 UID）。'
      + 'B 站规定：对方没关注开播账号、也没回过私信时，只能发一条，要等他关注或回复才能再发；结果里会告诉你他关注了没有。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（照消息里写的）或 UID' },
      text: { type: 'string', required: true, description: '私信内容（2000 字节以内）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      if (show.isBlocked(who.uid)) return `${who.name} 在主人的黑名单上，不给他发私信。`;
      if (show.optedOut(who.uid)) return `${who.name} 说过不想被记住，就不私信他了。`;
      show.toolCall('send_dm', `→ ${who.name}`, `在给${who.name}发私信`);
      const result = await dm.send(who, String(args.text ?? ''));
      if (result.ok) show.noteDm(who.name, String(args.text ?? ''));
      return result.text;
    },
  })), 'send_dm tool');

  // 点赞：视频或者一条评论
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'like',
    description: '用开播账号点赞：给一个 B 站视频（video），或者给一条评论（comment，read_comments / check_inbox 里方括号的编号）。',
    parameters: {
      video: { type: 'string', description: 'BV 号、av 号或视频链接' },
      comment: { type: 'string', description: '评论编号' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const comment = String(args.comment ?? '').trim();
      if (comment) {
        show.toolCall('like', `评论 ${comment}`, '在给评论点赞');
        return social.likeComment(comment);
      }
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      show.toolCall('like', `「${found.info.title.slice(0, 16)}」`, '在点赞');
      return social.likeVideo(found.info.aid, found.info.title);
    },
  })), 'like tool');

  // 看评论区
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_comments',
    description: '看一个 B 站视频的评论区：每条带编号（回复、点赞用）、名字、点赞数、楼里的几条回复。可以按热门或最新，可以翻页。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      sort: { type: 'string', enum: ['hot', 'new'], description: 'hot 热门（默认）、new 最新' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      const { info } = found;
      show.toolCall('read_comments', `「${info.title.slice(0, 16)}」`, `在看「${info.title.slice(0, 16)}」的评论区`);
      return social.readComments({ type: 1, oid: String(info.aid), title: info.title }, args.sort === 'new' ? 'new' : 'hot', Math.max(1, Math.floor(Number(args.page) || 1)));
    },
  })), 'read_comments tool');

  // 发评论
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'post_comment',
    description: '用开播账号发一条 B 站评论：发在视频下面（video），或者回复某一条评论（reply_to，read_comments / check_inbox 里方括号的编号）。'
      + `评论公开挂在那里，大家都看得到是这个账号发的。两条之间隔 ${COMMENT_GAP_MS / 1000} 秒（发太快 B 站会风控）。`,
    parameters: {
      text: { type: 'string', required: true, description: `评论内容（${MAX_COMMENT_CHARS} 字以内）` },
      video: { type: 'string', description: '发在哪个视频下面：BV 号、av 号或视频链接' },
      reply_to: { type: 'string', description: '回复哪一条评论：评论编号' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const replyTo = String(args.reply_to ?? '').trim() || undefined;
      let thread = null;
      if (!replyTo) {
        const found = await findVideo(args.video, undefined);
        if (typeof found === 'string') return found;
        thread = { type: 1, oid: String(found.info.aid), title: found.info.title };
      }
      show.toolCall('post_comment', replyTo ? `回复 ${replyTo}` : `「${thread!.title.slice(0, 16)}」`, '在发评论');
      const result = await social.postComment(thread, String(args.text ?? ''), replyTo);
      if (result.ok) show.noteComment(String(args.text ?? ''), thread?.title ?? replyTo ?? '');
      return result.text;
    },
  })), 'post_comment tool');

  // 收件箱
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'check_inbox',
    description: '看开播账号的收件箱：最近的私信会话（谁、未读几条、最后一句），和别人在评论区回复你、@ 你的。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('check_inbox', '', '在看私信和评论回复');
      return social.inbox();
    },
  })), 'check_inbox tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_dm',
    description: '看你和一个人最近的私信往来（他说了什么、你回了什么）。他发来的图片会带着图片网址，游戏里的 picture 能用。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（check_inbox 里的）或 UID' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '').trim();
      const talker = social.findTalker(who) ?? (/^\d{1,20}$/.test(who) ? { uid: who, name: `UID ${who}` } : null);
      if (!talker) {
        const viewer = show.lookupViewer(who);
        if (viewer.kind !== 'found') return `不知道「${who}」是谁：先 check_inbox 看看私信列表，用那里的名字或 UID。`;
        show.toolCall('read_dm', viewer.user.name, `在看和${viewer.user.name}的私信`);
        return social.conversation(viewer.uid, viewer.user.name);
      }
      show.toolCall('read_dm', talker.name, `在看和${talker.name}的私信`);
      return social.conversation(talker.uid, talker.name);
    },
  })), 'read_dm tool');

  const text = (value: string) => [{ type: 'text' as const, text: value }];
  const stringOut = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => text(value) };

  // 看一眼直播画面：OBS 截一张观众看到的画面，作为图片给她（DSH 存进附件，下一步她就能看）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'look',
    description: '看一眼直播画面：截一张观众现在看到的直播画面给你。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          text: { type: 'string' as const, required: true },
          image: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' as const, required: true },
              mediaType: { type: 'string' as const, required: true },
              bytes: { type: 'integer' as const, required: true },
              width: { type: 'integer' as const, required: true },
              height: { type: 'integer' as const, required: true },
              name: { type: 'string' as const },
            },
          },
        },
      },
      render: (_args: unknown, value: { text: string; image?: Record<string, unknown> }) => [
        { type: 'text' as const, text: value.text },
        ...(value.image ? [{ type: 'image' as const, attachment: value.image as never }] : []),
      ],
    },
    async execute(_args, exec: any) {
      show.toolCall('look', '', '在看直播画面');
      const attachments = ctx.get?.('attachments');
      const llm = ctx.get?.('llm');
      const routed = exec?.agent?.session?.requestHeader?.()?.config;
      const provider = routed?.provider ?? exec?.agent?.options?.provider;
      const model = routed?.model ?? exec?.agent?.options?.model;
      const info = llm && provider && model ? await llm.resolveModelInfo(provider, model, exec?.signal).catch(() => null) : null;
      if (!attachments || !info?.inputModalities?.includes('image')) return { text: '现在用的模型不能看图，这次看不了画面。' };
      let data: Uint8Array;
      try {
        data = await screenshot();
      } catch (err) {
        hooks.log('warn', `look 截图失败：${(err as Error).message}`);
        return { text: '画面没截到（直播电脑上的 OBS 没连上），过一会儿再看。' };
      }
      const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: 'look.jpg' });
      const at = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19);
      return {
        text: `直播画面，${at}：`,
        image: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) },
      };
    },
  })), 'look tool');

  // 这场的数据：播了多久、用了多少 token、大概花了多少钱
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'show_stats',
    description: '看这场直播的数据：播了多久、你用了多少 token、大概花了多少钱（模型和配音）、念了多少字。',
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall('show_stats', '', '在看这场的账');
      const s = show.stats();
      const tts = ttsYuan(s.spokenChars);
      const minutes = Math.round(s.liveMs / 60_000);
      const lines = [
        `这场播了 ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`}。`,
        `你用了 ${usage.tokens.toLocaleString('en-US')} token（缓存命中 ${usage.cacheRead.toLocaleString('en-US')}，没命中的输入 ${usage.input.toLocaleString('en-US')}，输出 ${usage.output.toLocaleString('en-US')}）。`,
        usage.priced
          ? `模型大概花了 ${money(usage.yuan)}（缓存命中很便宜；工作日白天高峰价，其余时间半价）。`
          : '这个模型的价钱这里不知道，只能报 token。',
        `念了大约 ${s.spokenChars} 个字，配音大概 ${money(tts)}（3 元一万字）。`,
      ];
      return lines.join('\n');
    },
  })), 'show_stats tool');

  // 关注、取关
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'follow',
    description: '用开播账号关注一个人（比如回关新粉丝），或者取关。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（直播间里、私信里的）或 UID' },
      unfollow: { type: 'boolean', description: 'true 是取关，默认关注' },
    },
    output: stringOut,
    async execute(args) {
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      const follow = args.unfollow !== true;
      show.toolCall('follow', `${follow ? '' : '取关 '}${who.name}`, follow ? `在关注${who.name}` : `在取关${who.name}`);
      return social.follow(who.uid, who.name, follow);
    },
  })), 'follow tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'my_fans',
    description: '看开播账号最新的粉丝：谁、什么时候关注的、你回关了没有。',
    parameters: { page: { type: 'number', description: '第几页，默认 1' } },
    output: stringOut,
    async execute(args) {
      show.toolCall('my_fans', '', '在看新粉丝');
      return social.fans(Math.max(1, Math.floor(Number(args.page) || 1)));
    },
  })), 'my_fans tool');

  // 删评论（自己发的，或者自己视频下面别人的）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'delete_comment',
    description: '删掉一条评论：你自己发的（post_comment 给的编号），或者开播账号自己视频下面别人的（read_comments / check_inbox 里的编号）。',
    parameters: { comment: { type: 'string', required: true, description: '评论编号' } },
    output: stringOut,
    async execute(args) {
      const rpid = String(args.comment ?? '').trim();
      show.toolCall('delete_comment', rpid, '在删评论');
      return social.deleteComment(rpid);
    },
  })), 'delete_comment tool');

  // 发动态
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'post_dynamic',
    description: '用开播账号发一条 B 站文字动态（标注为 AI 生成），关注这个账号的人首页都看得到。',
    parameters: { text: { type: 'string', required: true, description: '动态内容' } },
    output: stringOut,
    async execute(args) {
      show.toolCall('post_dynamic', String(args.text ?? '').slice(0, 16), '在发动态');
      const result = await social.postDynamic(String(args.text ?? ''));
      if (result.ok) show.noteDynamic(String(args.text ?? ''));
      return result.text;
    },
  })), 'post_dynamic tool');

  // 收藏、投币
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'favorite',
    description: `把一个 B 站视频收进你自己的收藏夹「${FAVORITE_FOLDER}」（开播账号上，主人原有的收藏夹不动）。`,
    parameters: { video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' } },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      show.toolCall('favorite', `「${found.info.title.slice(0, 16)}」`, '在收藏');
      return social.favorite(found.info.aid, found.info.title);
    },
  })), 'favorite tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coin',
    description: '用开播账号给一个 B 站视频投币（1 个或 2 个，一个视频最多投 2 个），可以顺便点赞。硬币是账号自己的。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      count: { type: 'number', description: '投几个：1 或 2，默认 1' },
      like: { type: 'boolean', description: '顺便点赞，默认 true' },
    },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      const count = Number(args.count) === 2 ? 2 : 1;
      show.toolCall('coin', `「${found.info.title.slice(0, 16)}」×${count}`, '在投币');
      return social.coin(found.info.aid, found.info.title, count, args.like !== false);
    },
  })), 'coin tool');

  // 直播间：禁言、解禁、改标题
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mute',
    description: '在你的直播间禁言一个人（这段时间他发不了弹幕）。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（弹幕里的）或 UID' },
      hours: { type: 'number', description: '禁言多少小时，默认 1' },
    },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      const hours = Math.max(1, Math.min(720, Math.floor(Number(args.hours) || 1)));
      show.toolCall('mute', `${who.name} ${hours}h`, `在禁言${who.name}`);
      return social.mute(roomId, who.uid, who.name, hours);
    },
  })), 'mute tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'unmute',
    description: '解开直播间里一个人的禁言（名字或 UID）；名字对不上时会列出现在被禁言的人。',
    parameters: { who: { type: 'string', required: true, description: '名字或 UID' } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      show.toolCall('unmute', String(args.who ?? ''), '在解禁言');
      return social.unmute(roomId, String(args.who ?? ''));
    },
  })), 'unmute tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'set_live_title',
    description: '改你直播间的标题（40 字以内），推荐页和搜索里显示的就是它。',
    parameters: { title: { type: 'string', required: true, description: '新标题' } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      const title = String(args.title ?? '').trim().slice(0, 40);
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      if (!title) return '标题是空的。';
      show.toolCall('set_live_title', title.slice(0, 16), '在改直播间标题');
      try {
        await new BiliRoom(await cookie()).update(roomId, { title });
        return `直播间标题改成了「${title}」。`;
      } catch (err) {
        return `改标题没成功：${(err as Error).message}`;
      }
    },
  })), 'set_live_title tool');

  // 搜 B 站视频
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'search_videos',
    description: '搜 B 站视频，返回一页候选（BV 号、标题、UP 主、时长、播放量、发布日期、标签、简介、封面图网址）。封面图网址游戏里的 picture 也能用：观众要画某个角色、某样东西时，可以搜它的视频、挑一张封面就是它的。'
      + '可以只搜某位 UP 主的投稿（up），可以按最新或播放最多排（order），可以翻页（page）。'
      + '超过 20 秒还没结果就别再搜了：直接跟观众说没找到，等他们换个关键词或给 BV 号。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词（观众说的大概意思就行）；只看某位 UP 主最新的投稿时可以留空' },
      up: { type: 'string', description: 'UP 主的名字或 UID：只在他的投稿里找' },
      order: { type: 'string', enum: ['relevance', 'newest', 'views'], description: 'relevance 相关度（默认）、newest 最新、views 播放最多（填了 up 时按发布时间）' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      const up = String(args.up ?? '').trim() || undefined;
      if (!query && !up) return 'query 和 up 至少填一个。';
      const order = (['relevance', 'newest', 'views'] as const).find((o) => o === args.order);
      const options = { up, order, page: Number(args.page) || 1 };
      show.toolCall('search_videos', query ? `「${query}」` : `UP ${up}`, `在搜视频：${query || up}`);
      asr.warm();
      const result = await withDeadline(videos.search(query, options));
      if (!result) return '搜索超过 20 秒还没结果：直接跟观众说没找到，别反复搜同一个词，等他们换个关键词或给 BV 号。';
      return searchText(query, result, options);
    },
  })), 'search_videos tool');

  // 点歌：从本地曲库找一首，舞台上放音频 + 歌词
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sing_song',
    description: '观众点歌时用：先看本地曲库，有就放（带歌词）；曲库没有就去 B 站找翻唱/伴奏版，下载到本地当现学版播。都没有就老实说不会，别自己编。',
    parameters: {
      query: { type: 'string', required: true, description: '歌名或歌手（观众说的大概意思）' },
      by: { type: 'string', description: '谁点的（观众名字）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) return 'query 必填。';
      const who = String(args.by ?? '').trim().slice(0, 20) || '她';
      const hit = matchSong(listSongs(join(dataDir, 'songs')), query);
      if (hit) {
        const queued = show.queueSong(songRequest(hit), who);
        return queued.queued ? `「${hit.title}」排进点歌队列了，第 ${queued.position} 位，前面放完就唱。` : `开始唱「${hit.title}」了。`;
      }
      // 曲库没有：去 B 站找翻唱/伴奏版，下到本地当“现学版”播
      const cover = await withDeadline(findCover(query), 20_000);
      if (!cover) return `曲库里没有「${query}」，B 站也没找到能放的翻唱：跟观众说这首还不会、等学了再唱，别乱编。`;
      const queued = show.queueVideo(cover.request, undefined, undefined, who);
      return queued.queued
        ? `曲库没有「${query}」，我找了个 B 站翻唱版「${cover.title}」，排进队列第 ${queued.position} 位。`
        : `曲库没有「${query}」，我找了个 B 站翻唱版「${cover.title}」，现在放。`;
    },
  })), 'sing_song tool');

  // 观众同意优先播放：把 ta 排在队列里的点播挪到下一个
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'priority_play',
    description: '把某位观众排在点播队列里的视频插到下一个（ta 同意「优先播放」时用）。长视频的粉丝团观众才用得上。',
    parameters: {
      by: { type: 'string', required: true, description: '同意优先播放的观众名字' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.by ?? '').trim();
      if (!who) return 'by 填观众名字。';
      const title = show.promoteQueued(who);
      return title ? `「${title}」已经插到下一个，放完现在这个就放它。` : `队列里没找到 ${who} 的点播：可能已经放上了，或者 ta 还没点。`;
    },
  })), 'priority_play tool');

  // 查点播排队：某人排第几
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'queue_status',
    description: '查点播队列：某个观众点的视频排在第几位，或者整条队列现在什么顺序。观众问「我第几个」时用。',
    parameters: {
      by: { type: 'string', description: '观众名字；不填就看整条队列' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const by = String(args.by ?? '').trim();
      return show.queueStatus(by);
    },
  })), 'queue_status tool');

  // 礼物榜（本日 / 本月）+ 礼物知识库
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'gift_board',
    description: '看礼物榜：本日或本月，谁送得最多、送了什么。period 填 today 或 month（默认 today）。',
    parameters: {
      period: { type: 'string', description: 'today 或 month，默认 today' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const period = String(args.period ?? 'today').toLowerCase() === 'month' ? 'month' : 'today';
      const data = giftBoard.summary();
      const list = period === 'month' ? data.month : data.today;
      if (!list.length) return period === 'month' ? '这个月还没人送礼物呢。' : '今天还没人送礼物呢。';
      const lines = list.map((p, i) => `${i + 1}. ${p.name}：${p.gifts.map((g) => `${g.gift}×${g.count}`).join('、')}，约 ${p.total.toFixed(0)} 元`);
      return `${period === 'month' ? '本月' : '本日'}礼物榜（${list.length} 人）：\n${lines.join('\n')}`;
    },
  })), 'gift_board tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'gift_memory',
    description: '查礼物知识库：某个人送过什么（长期），或者最近几天谁送了什么礼物。name 填人名；不填就返回最近几天的汇总。',
    parameters: {
      name: { type: 'string', description: '观众名字；不填就看最近的礼物记录' },
      days: { type: 'number', description: '不填 name 时看最近几天的汇总，默认 7' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const name = String(args.name ?? '').trim();
      if (name) {
        const note = giftBoard.personNote(name);
        return note ?? `礼物记录里没找到「${name}」送过什么。`;
      }
      const days = Math.max(1, Math.min(60, Number(args.days) || 7));
      const notes = giftBoard.dayNotes(days);
      if (!notes.length) return '最近还没有礼物记录。';
      return `最近 ${notes.length} 天的礼物记录：\n${notes.map((n) => n.text).join('\n')}`;
    },
  })), 'gift_memory tool');

  // 捉迷藏：影遁藏到某个组件后面，观众 10 秒投票找她
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hide_and_seek',
    description: '玩捉迷藏：影遁藏到舞台某个组件后面，开 10 秒投票让观众猜。观众说「捉迷藏」或者你想玩时用。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      const result = show.startHideGame();
      return result.ok ? result.text : result.text;
    },
  })), 'hide_and_seek tool');

  // 查房：看别人直播间在播什么
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'visit_room',
    description: '去别人的 B 站直播间串门：看房间标题、主播、分区、人气、关注数和最近几条弹幕，再回来跟大家点评。',
    parameters: {
      room: { type: 'string', required: true, description: '对方直播间房间号（或直播间链接）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const raw = String(args.room ?? '').trim();
      const m = /live\.bilibili\.com\/(\d{5,9})/.exec(raw);
      const id = m?.[1] ?? raw.replace(/[^0-9]/g, '');
      if (!id) return '房间号不对，给我对方的直播间房间号。';
      const jar = await cookie().catch(() => '');
      const headers = { 'User-Agent': 'Mozilla/5.0', Referer: `https://live.bilibili.com/${id}`, ...(jar ? { Cookie: jar } : {}) };
      try {
        const info = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`, { headers, signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<any>);
        if (info.code !== 0) return `房间 ${id} 打不开：${info.message ?? info.code}`;
        const d = info.data ?? {};
        let anchor = '';
        let tags = '';
        try {
          const more = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${id}`, { headers, signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<any>);
          anchor = more?.data?.anchor_info?.base_info?.uname ?? '';
          tags = more?.data?.room_info?.tags ?? '';
        } catch { /* 主播名取不到就算了 */ }
        let chats = '';
        try {
          const hist = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${id}&room_type=0`, { headers, signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<any>);
          chats = (hist?.data?.room ?? []).slice(-5).map((c: any) => `${c.nickname}：${c.text}`).join('\n');
        } catch { /* 弹幕取不到就算了 */ }
        const live = d.live_status === 1 ? '正在直播' : '没在播';
        // 对方在播就把画面拉上舞台（最多 3 分钟自动撤）；拉不到就只报数据
        let onStage = false;
        if (d.live_status === 1) {
          try {
            const pu = await fetch(
              `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${id}&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=web&ptype=8`,
              { headers, signal: AbortSignal.timeout(15_000) },
            ).then((r) => r.json() as Promise<any>);
            // HLS（ts）最稳：OBS 媒体源直接放，不用带 Referer；FLV 拿不到头会 403
            let flv = '';
            let hls = '';
            for (const s of pu?.data?.playurl_info?.playurl?.stream ?? []) {
              for (const f of s.format ?? []) {
                for (const c of f.codec ?? []) {
                  const ui = (c.url_info ?? [])[0];
                  if (!ui?.host) continue;
                  const url = `${ui.host}${c.base_url}${ui.extra ?? ''}`;
                  if (f.format_name === 'ts' && !hls) hls = url;
                  if (f.format_name === 'flv' && !flv) flv = url;
                }
              }
            }
            // 走本地代理转 FLV：HLS 的 m3u8 分片是相对路径，代理起来麻烦；FLV 一路流最好转
            const src = flv || hls;
            if (src) onStage = await watchRoom(src, String(d.title ?? ''), 3, Number(id));
          } catch { /* 画面拉不到就只报数据 */ }
        }
        return [
          `查房 ${id}${anchor ? `（主播：${anchor}）` : ''}`,
          `${live}；标题「${d.title ?? ''}」`,
          `分区：${d.area_name ?? ''}${tags ? `（${tags}）` : ''}；人气 ${d.online ?? 0}；关注 ${d.attention ?? 0}`,
          chats ? `最近弹幕：\n${chats}` : '',
          onStage ? '（对方画面已经放到舞台上了，最多 3 分钟自动撤：跟大家说一声「去串个门」再点评。）' : '',
          !onStage && live === '正在直播' ? `（对方在播，但画面没拉上${lastRoomError ? `：${lastRoomError}` : '：没拿到播放地址'}——跟观众说一声画面没拉上，别硬说在串门。）` : '',
          !onStage && live === '没在播' ? '（对方没在播，就跟观众说扑空了）' : '',
        ].filter(Boolean).join('\n');
      } catch (err) {
        return `去 ${id} 查房失败了：${(err as Error).message}`;
      }
    },
  })), 'visit_room tool');

  // 共创连续剧：开一章、收一章、看进度
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'story_begin',
    description: '开一章「观众共创连续剧」：给标题、一个问题、两个选项；观众弹幕发 1 或 2 投票，票数实时显示在舞台。跨场保留。',
    parameters: {
      title: { type: 'string', required: true, description: '这一章的标题（简短）' },
      question: { type: 'string', required: true, description: '给观众的选择题（一句话）' },
      a: { type: 'string', required: true, description: '选项 1（发 1 选它）' },
      b: { type: 'string', required: true, description: '选项 2（发 2 选它）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const row = show.beginStory(
        String(args.title ?? '').slice(0, 20) || '新的一章',
        String(args.question ?? '').slice(0, 40),
        String(args.a ?? '').slice(0, 20),
        String(args.b ?? '').slice(0, 20),
      );
      return `第 ${row.chapter} 章「${row.title}」开好了：1 = ${row.option_a}，2 = ${row.option_b}。跟大家说发 1 或 2 投票。`;
    },
  })), 'story_begin tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'story_finish',
    description: '结束当前这一章：选哪个分支、这一章发生了什么小结。票数会被记录，下一章接着演。',
    parameters: {
      choice: { type: 'string', enum: ['a', 'b'], required: true, description: '选中的分支' },
      summary: { type: 'string', required: true, description: '这一章的小结（发生什么、观众怎么选的）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const choice = args.choice === 'b' ? 'b' : 'a';
      const row = show.finishStory(choice, String(args.summary ?? '').slice(0, 200));
      if (!row) return '现在没有进行中的剧情：先用 story_begin 开一章。';
      return `第 ${row.chapter} 章结束了（票数 1:${row.votes_a} / 2:${row.votes_b}），选的是 ${choice === 'a' ? row.option_a : row.option_b}。`;
    },
  })), 'story_finish tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'story_status',
    description: '看现在这一章剧情的进度（标题、选项、票数）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      const s = show.currentStory;
      if (!s) return '现在没有进行中的剧情。';
      return `第 ${s.chapter} 章「${s.title}」：${s.question}｜1 = ${s.option_a}（${s.votes_a} 票）｜2 = ${s.option_b}（${s.votes_b} 票）${s.resolved_at ? '（已结束）' : ''}`;
    },
  })), 'story_status tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'set_scene',
    description: '剧情换场景：把舞台整屏背景换成 scenes 里的一张图（名字 = ~/.dsh/dsh-live-farben/scenes/<名字>.jpg）。name 留空就回到模板默认背景。',
    parameters: {
      name: { type: 'string', description: '场景名，比如 street / night；留空回默认背景' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const name = String(args.name ?? '').trim();
      show.setScene(name || null);
      return name ? `舞台背景换成「${name}」了。` : '舞台背景回到默认了。';
    },
  })), 'set_scene tool');

  // ── 读书会：书架、开书、朗读 ───────────────────────

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'book_list',
    description: '看书架上有哪些书（只列书名）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      const books = listBooks(join(dataDir, 'books'));
      if (!books.length) return '书架是空的：让主人往 books/ 目录放书（每本一个文件夹，meta.json + book.txt）。';
      return `书架上有 ${books.length} 本：${books.map((b, i) => `${i + 1}. ${b.title}`).join('；')}`;
    },
  })), 'book_list tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'book_open',
    description: '打开一本书开始读（接着上次的进度；跨场保留）。book 填书名或书名的一部分。',
    parameters: {
      book: { type: 'string', required: true, description: '书名（或一部分）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      if (!settings.bookMode) return '读书会现在是关闭的：别开书，也别提读书会。';
      const query = String(args.book ?? '').trim();
      const books = listBooks(join(dataDir, 'books'));
      const found = books.find((b) => b.title.includes(query) || query.includes(b.title)) ?? books[0];
      if (!found) return '书架上没有书：让主人先往 books/ 目录放书。';
      const book = loadBook(join(dataDir, 'books'), found.id);
      if (!book) return `「${found.title}」打不开（book.txt 可能坏了）。`;
      const opened = show.openBook(book);
      return `打开《${opened.chapterTitle ? book.title : book.title}》：共 ${opened.total} 章，现在从第 ${opened.chapter + 1} 章开始（上次读到第 ${opened.para + 1} 段）。跟大家说一声，然后就可以 book_read 读了。`;
    },
  })), 'book_open tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'book_read',
    description: '读接下来的几段书（默认 1 段）。返回原文——把原文当成你的话说出来（这是朗读），读完停下来跟观众聊几句。',
    parameters: {
      count: { type: 'number', description: '读几段，默认 1；一般一次 1～2 段' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      if (!settings.bookMode) return '读书会现在是关闭的。';
      if (!show.currentBook) return '现在没在读书：先用 book_open 打开一本。';
      const count = Math.max(1, Math.min(3, Number(args.count) || 1));
      const text = show.readParagraphs(count);
      if (!text) return '这本书读完了：跟大家说读完了，问问要不要换一本。';
      const now = show.currentBook;
      return `${text}\n\n（以上是原文，直接念给观众听；念完可以聊两句。进度：第 ${(now?.chapter ?? 0) + 1} 章 ${now?.chapterTitle ?? ''}）`;
    },
  })), 'book_read tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'book_jump',
    description: '跳到某一章的开头继续读。',
    parameters: {
      chapter: { type: 'number', required: true, description: '第几章（从 1 开始）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      if (!settings.bookMode) return '读书会现在是关闭的。';
      if (!show.currentBook) return '现在没在读书。';
      const ok = show.bookJump(Math.max(0, (Number(args.chapter) || 1) - 1));
      if (!ok) return '跳章失败。';
      const now = show.currentBook;
      return `跳到第 ${(now?.chapter ?? 0) + 1} 章「${now?.chapterTitle ?? ''}」，本书共 ${now?.total ?? 0} 章。`;
    },
  })), 'book_jump tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'book_close',
    description: '收起读书会，舞台回到平常。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.closeBook();
      return '读书会收起来了。';
    },
  })), 'book_close tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'book_find',
    description: '去公版书库找一本完整的书并放进书架。目前支持 Project Gutenberg（英文公版书）；中文公版书源暂时连不上，找不到就让主人手动放。',
    parameters: {
      query: { type: 'string', required: true, description: '书名或关键词（英文效果最好）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      if (!settings.bookMode) return '读书会现在是关闭的，不用去找书。';
      const query = String(args.query ?? '').trim();
      if (!query) return 'query 必填。';
      try {
        const search = await fetch(`https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (dsh-live-farben)' },
          signal: AbortSignal.timeout(20_000),
        });
        const html = await search.text();
        const id = /\/ebooks\/(\d+)/.exec(html)?.[1];
        if (!id) return `公版书库里没搜到「${query}」：跟观众说找不到，或者让主人手动放书。`;
        const titleMatch = /<span class="title">([^<]+)<\/span>/.exec(html);
        const title = (titleMatch?.[1] ?? query).trim();
        const txt = await fetch(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (dsh-live-farben)' },
          signal: AbortSignal.timeout(60_000),
        });
        if (!txt.ok) return `找到了《${title}》但正文下载失败（${txt.status}），换一本吧。`;
        const raw = await txt.text();
        const bookId = `gut-${id}`;
        const chapters = [{ title: '正文', text: raw.slice(0, 400_000) }];
        saveBook(join(dataDir, 'books'), { id: bookId, title, chapters });
        return `找到了《${title}》（Project Gutenberg #${id}），已经放进书架（id=${bookId}）。用 book_open(book="${title}") 打开就能读。`;
      } catch (err) {
        return `去公版书库找书失败：${(err as Error).message}。跟观众说这次没找到，让主人手动放书也行。`;
      }
    },
  })), 'book_find tool');

  // ── 通用投票：开播主题、选书、继续/换章/讨论 ──

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'poll_start',
    description: '开一个投票：观众弹幕发 1/2/3 投票，舞台显示票数和倒计时，到点自动结算并把结果告诉你。',
    parameters: {
      question: { type: 'string', required: true, description: '问题（一句话）' },
      options: { type: 'string', required: true, description: '选项，用「/」或逗号分隔，最多 4 个' },
      seconds: { type: 'number', description: '投多久，默认 60 秒' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const options = String(args.options ?? '').split(/[\/,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
      if (!options.length) return 'options 至少要有一个选项。';
      const poll = show.startPoll(String(args.question ?? '').slice(0, 40), options, Number(args.seconds) || 60);
      return `投票开好了：「${poll.question}」${options.map((o, i) => `${i + 1}=${o}`).join('，')}，${Math.round((poll.endsAt - Date.now()) / 1000)} 秒后结算。跟大家说发数字投票。`;
    },
  })), 'poll_start tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'poll_result',
    description: '看当前/上一次投票的结果和票数。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      return show.pollResult ?? '现在没有投票。';
    },
  })), 'poll_result tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'opening_vote',
    description: '开场投票：让观众选今天先干什么（点播视频 / 随便聊聊）。开播第一件事就调它。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.startPoll('今天先来点什么？', ['点播视频', '随便聊聊'], 60);
      return '开场投票开好了：1 = 点播视频，2 = 随便聊聊，60 秒。跟大家说发 1 或 2；结果出来我会告诉你。';
    },
  })), 'opening_vote tool');

  // 看一个视频：详情和字幕
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'watch_video',
    description: '看一个 B 站视频：详情（标题、UP 主、时长、播放点赞投币收藏、标签、简介、分 P）和带时间的字幕。'
      + '字幕一次给一段，长的用 from 接着往后看；视频没有字幕时会听一遍、把说的话写下来（要几秒到十几秒）。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      part: { type: 'number', description: '多 P 视频的第几 P，默认 1' },
      from: { type: 'number', description: '从第几秒的字幕开始看（接着看时填上次给的数）；填了就只给字幕' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await withDeadline(findVideo(args.video, args.part));
      if (!found) return '查了 20 秒还没查到：直接跟观众说没找到，别反复试同一个视频。';
      if (typeof found === 'string') return found;
      const { info, part } = found;
      const from = seconds(args.from);
      show.toolCall('watch_video', `「${info.title.slice(0, 16)}」`, `在看「${info.title.slice(0, 20)}」`);
      library.view(info, part, libraryView('watch', from));
      if (!library.hasDanmaku(info, part)) void videoDanmaku(info, part).catch(() => {});
      const sub = (await officialSubtitles(info, part)) ?? (await listen(info, part, from));
      const partArg = part.page > 1 ? `, part=${part.page}` : '';
      const subtitle = subtitleText(info, part, sub, from, partArg);
      const noLogin = !sub && !(await videos.loggedIn()) ? '（开播账号没登录：B 站的 AI 字幕要登录才给）' : '';
      if (from > 0) return `「${info.title}」${part.page > 1 ? `P${part.page} ` : ''}从 ${clock(from)} 起：\n${subtitle}${noLogin}`;
      return `${infoText(info, part)}\n\n${subtitle}${noLogin}`;
    },
  })), 'watch_video tool');

  // 在舞台上放视频
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'play_video',
    description: '在直播间的舞台上放一个 B 站视频给大家看：舞台换成看视频的布局，放完换回来，放完了会告诉你。'
      + '默认从头放到结尾，可以指定从哪里开始、放多久。'
      + '这个工具马上返回（你回一句「我去找」就行），找视频、拿播放地址都在后台做，所以别等它——说完继续回别的弹幕、聊别的，找到/放上了会另外告诉你。'
      + '找超过 20 秒还没结果就不用再找了：直接说没找到，等观众换个关键词或给 BV 号。'
      + '放的时候你照常说话、回弹幕，你说话时视频声音会自动调小。正在放的不会被换掉：会排进点播队列，放完自动接着放，舞台上的排队栏会显示。'
      + '舞台只在这个工具被调用时开始放：你说「我放一下」只是念给大家听，视频要靠这次调用才出现在舞台上。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      part: { type: 'number', description: '多 P 视频的第几 P，默认 1' },
      from: { type: 'string', description: '从哪里开始放：秒数或「分:秒」，默认 0' },
      seconds: { type: 'number', description: '放多少秒，不填就放到结尾' },
      by: { type: 'string', description: '点这个视频的观众名字（观众点的就填他，你自己找的就别填）' },
      jump: { type: 'boolean', description: '插队：舰长/提督/总督或者醒目留言点的，填 true，下一个就放它；普通弹幕别填' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const text = String(args.video ?? '').trim();
      if (!text) return '给我一个 BV 号、av 号或视频链接。';
      const who = String(args.by ?? '').trim().slice(0, 20) || '她自己';
      // 找视频、拿播放地址都要等 B 站接口：别把她卡在这儿，工具立刻返回，剩下的后台做
      void (async () => {
        try {
          const found = await withDeadline(findVideo(args.video, args.part));
          if (!found) {
            show.notifyInbox([`找「${text.slice(0, 20)}」超过 20 秒还没结果：跟观众说没找到，别再继续搜，等他们换个名字或给 BV 号。`]);
            return;
          }
          if (typeof found === 'string') { show.notifyInbox([found]); return; }
          const { info, part } = found;
          if (part.durationSec && part.durationSec > MAX_VIDEO_SEC) {
            const level = show.medalLevel(who);
            if (level <= LONG_VIDEO_FAN_LEVEL) {
              show.notifyInbox([`「${info.title}」有 ${Math.round(part.durationSec / 60)} 分钟，超过 20 分钟了——${LONG_VIDEO_NOTE}（${who} 现在${level ? `是粉丝牌 ${level} 级` : '还没有粉丝牌'}，播不了）`]);
              return;
            }
            show.notifyInbox([`「${info.title}」有 ${Math.round(part.durationSec / 60)} 分钟，粉丝团 ${level} 级可以点：已经排上了。问一句 ta 要不要优先播放，ta 同意就用 priority_play(by="${who}") 插到下一个。`]);
          }
          const from = Math.floor(seconds(args.from));
          if (part.durationSec && from >= part.durationSec) {
            show.notifyInbox([`「${info.title}」一共只有 ${clock(part.durationSec)}，从 ${clock(from)} 开始就没有了。`]);
            return;
          }
          const asked = Number(args.seconds) > 0 ? Math.max(5, Number(args.seconds)) : null;
          const end = part.durationSec || from + (asked ?? PLAY_UNKNOWN_SEC);
          const until = asked ? Math.min(end, from + asked) : end;
          const url = await withDeadline(videos.playUrl(info.bvid, part.cid), 40_000);
          if (!url) {
            show.notifyInbox([`「${info.title}」的播放地址 40 秒没取到（可能网络慢、付费或地区限制）：跟观众说这个放不了，换一个。`]);
            return;
          }
          // 先试着整段下到本地（卡了就退回在线播放，不能因为下载把点播卡住）
          show.notifyInbox([`「${info.title}」正在拉到本地，拉好就放（这样不会卡）。`]);
          const cached = await withDeadline(cacheVideo(join(dataDir, 'media'), info.bvid, url), 25_000);
          if (cached) pruneVideos(join(dataDir, 'media'));
          const localSrc = cached ? `/media?id=${info.bvid}` : undefined;
          show.toolCall('play_video', `「${info.title.slice(0, 16)}」`);
          // 边看边聊：后台拿这段的字幕（没有就边放边听写）和原视频弹幕
          const notes = new VideoNotes(from, until, {
            subtitles: () => officialSubtitles(info, part),
            listen: (at) => listen(info, part, at),
            danmaku: () => videoDanmaku(info, part),
          }, (message) => hooks.log('warn', message));
          const view = library.view(info, part, libraryView('play', from, until));
          const queued = show.queueVideo({ bvid: info.bvid, title: info.title, up: info.up.name, url, fromSec: from, untilSec: until, durationSec: part.durationSec, ...(localSrc ? { src: localSrc } : {}) }, notes,
            (end) => library.finish(info, part, view, { playedSec: end.playedSec, end: end.how, said: end.said }), who, args.jump === true);
          if (queued.queued) {
            show.notifyInbox([`「${info.title}」已经排进点播队列，第 ${queued.position} 位（${who} 点的），放完前面的就接它；到它了会告诉你。`]);
            return;
          }
          const { video, replaced } = queued;
          const outcome = show.stage.watchers ? await show.player.waitStart(video.id, PLAY_CONFIRM_MS) : 'playing';
          if (outcome === 'error') {
            show.notifyInbox([`「${info.title}」没放出来（舞台加载不了这个视频${video.error ? `：${video.error}` : ''}），可以换一个。`]);
            return;
          }
          const lines = [
            outcome === 'pending'
              ? `舞台还在加载「${info.title}」（UP ${info.up.name}，${clock(from)}–${clock(until)}），放得出来就接着放，放不出来会告诉你。`
              : `舞台上已经在放「${info.title}」（UP ${info.up.name}），${clock(from)}–${clock(until)}，共 ${clock(until - from)}。`,
          ];
          if (replaced) lines.push(`（换掉了正在放的「${replaced.title}」）`);
          show.notifyInbox(lines);
        } catch (err) {
          hooks.log('warn', `点播失败：${(err as Error).message}`);
          show.notifyInbox([`点播「${text.slice(0, 20)}」没成：${(err as Error).message}`]);
        }
      })();
      return `收到，我去找「${text.slice(0, 20)}」，找到就放；放上了再跟你说一声。`;
    },
  })), 'play_video tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stop_video',
    description: '停下舞台上正在放的视频，舞台换回聊天的布局。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('stop_video', '');
      const stopped = show.stopVideo();
      if (!stopped) return '现在没在放视频。';
      return `停了「${stopped.video.title}」（放了 ${clock(stopped.playedSec)}），舞台换回了聊天的布局。`;
    },
  })), 'stop_video tool');

  // 游戏线：另一个会话里的她专门玩游戏，这条线把话交给她
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_side',
    description: '观众或主人想让你在游戏里做什么、或者你要答应游戏里的事：写下怎么做，交给游戏里的你。他们的原话会一起交过去，由游戏里的你点名回他、再去做；从调这个工具的那条消息起，这一轮你写的话都不会念出来（调之前写的会念）。',
    parameters: {
      message: { type: 'string', required: true, description: '游戏里接下来怎么做，比如「开 Minecraft 接着玩，目标一身钻石装备」「天黑了，先挖洞躲起来」' },
      who: { type: 'string', description: '这是哪位观众点的单（名字，几位用顿号隔开）：记进点单队列、观众在点单栏里看得到；这件事里只有一位观众时可以不填' },
    },
    output: stringOut,
    async execute(args) {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) return '没写接下来怎么玩。';
      show.toolCall('game_side', message.slice(0, 40));
      if (!show.toGameLine(message, typeof args.who === 'string' ? args.who : '')) return '这场直播没开游戏（开播时没准备游戏），玩不了。';
      return '交过去了：游戏里的你会回他、去做。这一轮接下来写的话不会念出来。';
    },
  })), 'game_side tool');

  // 查游戏里现在的完整情况（游戏线最近一个时刻的全文）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_state',
    description: '查你在游戏里现在的完整情况：位置、血量、饥饿、完整背包、身体在做什么、刚发生了什么。观众问游戏里的细节时先查一下再回。',
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall('game_state', '', '在看游戏里的情况');
      const state = show.gameState();
      return state ? `（${state.ageSec} 秒前，游戏里最近一个时刻）\n${state.text}` : '游戏现在没开。';
    },
  })), 'game_state tool');
}
