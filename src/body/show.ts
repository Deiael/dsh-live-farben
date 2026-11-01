/**
 * 一场直播的身体：连着直播间、看着注意力层，把「现在该说的事」交给大脑，把大脑写的话念出来。
 *
 *   一场直播 = 大脑的一个会话，完整保留历史。身体在她空下来时（上一轮结束、话也念完了）挑出下一件事，
 *   作为一条消息推进这个会话；她回复的正文就是说出口的话，写出一段念一段（见 dsh/agent.ts）。
 *   节奏全归身体管：她在想、在说的时候不推新的；主人的话、开场、谢幕排在弹幕前面。
 *
 * 不碰 DSH：推消息、TTS、提炼用的模型、记录目录都由插件从外面给（ShowHooks）。
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LiveAttention, type OwnerPace } from '../core/attention/attention';
import { setHerNames } from '../core/attention/features';
import type { Topic, TopicBody } from '../core/attention/topics';
import { LiveHub } from '../core/hub';
import type { LiveEvent, LiveStatus, LiveUser } from '../core/live';
import { distillStream, type DistillLlm } from '../core/memory/distill';
import { LiveMemory } from '../core/memory/memory';
import { LiveMemoryStore, type StoryRow } from '../core/memory/store';
import { OrderBook, type OrderBookData, type OrderState } from '../core/orders';
import { cleanName, cleanText } from '../core/safety';
import { speakable } from '../core/speakable';
import { topicText } from '../core/topicText';
import { lookupViewer, type ViewerLookup } from '../core/viewerLookup';
import type { BrainState, GameSource, GameStatus, StageLiveEvent, StageUser } from '../stage/protocol';
import { gameStatusOf } from './gameStatus';
import { Player, type PlayRequest } from './player';
import type { Book } from './books';
import type { VideoNotes } from './watchAlong';
import { Stage } from './stage';

/** 一个视频不放了：怎么结束的、放了多少秒、这期间她说了什么 */
export interface VideoEnd {
  how: string;
  playedSec: number;
  said: string[];
}

export interface ShowHooks {
  /**
   * 把一件事作为一条消息推进她的会话（唤醒她）；会话不在线返回 false。
   * now：插进她这一轮的下一步（她在玩游戏、一轮没完时）；不然排到下一轮
   */
  push(sessionId: string, text: string, now?: boolean): Promise<boolean>;
  /** 合成一句话的语音（mp3）和逐字时间；没配密钥或失败返回 null（只有字幕，按字数走） */
  /** voice：嘉宾用自己的音色；不给就是她的 */
  synthesize(text: string, signal: AbortSignal, voice?: string): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null>;
  /** 下播后提炼观众记忆用的模型 */
  distill?: DistillLlm;
  log?(level: 'info' | 'warn', message: string): void;
  /** 存下正在播的这一场（插件重启后接着播用）；null：这场结束了 */
  persist?(snapshot: LiveSnapshot | null): void;
  /** 游戏画面上舞台、撤下（OBS 抓游戏窗口、叠 HUD） */
  onGame?(source: GameSource | null): void;
}

/** 正在播的一场：插件重启后接着播要的东西 */
export interface LiveSnapshot {
  sessionId: string;
  roomId: number | null;
  /** 观众记忆里这一场的 id（不记的房间为 null） */
  streamId: number | null;
  logFile: string | null;
  /** 最后一次存的时间（算断了多久） */
  at: number;
  /** 这场什么时候开播的 */
  startedAt?: number;
  /** 到停下时她念了多少字 */
  spokenChars?: number;
  /** 停下时她在直播里玩着游戏（插件重启时游戏那局也跟着断了） */
  playing?: boolean;
  /** 游戏线：专门玩游戏的那个会话（和直播线同时跑，见 docs/game-line.md） */
  gameSessionId?: string;
  /** 小钢炮（维修工）的会话：只回气泡，不出声 */
  repairSessionId?: string;
  /** 点单队列（插件重启后接着排） */
  orders?: OrderBookData;
}

export interface ShowOptions {
  /** 数据目录：记忆库、每场的记录 */
  dataDir: string;
  /** 观众叫她时用的名字 */
  names: string[];
  /** 没话题时多久开始自己找话说（控制台设置，改了马上生效） */
  idleAfterMs?: () => number;
  /** 主人定的节奏：欢迎、谢礼物、谢关注的间隔，一次回几位（控制台设置，改了马上生效） */
  pace?: () => OwnerPace;
  /** 告示板上写的（开场时告诉她，观众看得到什么） */
  board?: () => string;
  /** 这场直播的标题（开场时告诉她今天做什么） */
  title?: () => string;
  /** 她在玩游戏时，两次把直播间的事推给她至少隔多少毫秒（控制台设置，改了马上生效） */
  gameChatGapMs?: () => number;
  /** 主人拉黑的观众（控制台设置，改了马上生效）：他的进场、弹幕、礼物她都看不到 */
  blocked?: (uid: string) => boolean;
  /** 每隔多少秒顺口提醒一次「点点赞、点点关注」（0 = 不提醒；控制台设置，改了马上生效） */
  plugEverySec?: () => number;
  /** 没人点播时，自动挑一个合集里的视频来放；没得放返回 null */
  autoNext?: () => Promise<PlayRequest | null>;
  /** 弹幕里有人说「点歌 xxx」：按关键词找曲库，找到就自动排队 */
  songByQuery?: (query: string) => PlayRequest | null;
  /** 弹幕里有人说「读 xxx」：书架上找得到就直接打开，返回书名 */
  bookByQuery?: (query: string) => string | null;
  /** 读书会总开关（关掉时点书/开书都不生效，不影响点播） */
  bookMode?: () => boolean;
  /** 下播日记写好了：可以发 B 站动态（设置里开） */
  onDiary?: (text: string) => void;
  /** 现在的人设/电台风格：每轮推给她时附一句 */
  styleLine?: () => string;
  /** 礼物满多少元要说句特别的 */
  unlockYuan?: () => number;
  /** 收到礼物：记进礼物榜（本日/本月） */
  giftLog?: (entry: { uid: string; name: string; gift: string; count: number; yuan: number }) => void;
  /** 有人点播、要开始放视频时：先把串门画面撤掉（串门和点播只能有一个） */
  stopVisit?: () => void;
}

/** 她说过的一句话（控制台显示、下播提炼用） */
export interface SpokenLine {
  text: string;
  mood: string;
  at: number;
}

export interface ShowStatus {
  live: LiveStatus;
  onAir: boolean;
  brain: BrainState;
  /** 正在直播的那个会话 */
  brainSession: string | null;
  heat: string;
  audience: boolean;
  pending: Record<string, number>;
  lines: SpokenLine[];
  stageWatchers: number;
  /** 当前连着的房间号（没连为 null） */
  roomId: number | null;
}

const TICK_MS = 200;
/** 推了一件事以后，她这一轮最多等多久（模型卡住时不让直播停住） */
const TURN_MAX_MS = 3 * 60_000;
/** 推道别以后最多等多久就收工 */
const ENDING_GRACE_MS = 90_000;
const RECENT_LINES = 40;
/** 道别时给她看刚才说的最后几句：多久以内的、最多几句 */
const JUST_SAID_MS = 2 * 60_000;
const JUST_SAID_LINES = 4;
/** 合成一段语音最多等多久（超时再试一次，还不行就只出字幕） */
const SYNTH_TIMEOUT_MS = 15_000;
/** 在播时多久存一次这一场（插件重启后按它算断了多久） */
const PERSIST_EVERY_MS = 20_000;
/** 边看边聊：放视频时她安静了这么久（离上次「视频这会儿」也这么久），就告诉她视频这段在说什么 */
const WATCH_GAP_MS = 20_000;
/** 一次最多告诉她多长一段 */
const WATCH_WINDOW_SEC = 45;
/** 视频里不到这么多秒的一段不值得说 */
const WATCH_MIN_SEC = 8;
/** 她在玩游戏时，两次把直播间的事推给她至少隔多久（弹幕攒成一批一起回，别让游戏走不动；30 秒时回复太稀） */
const GAME_PUSH_GAP_MS = 15_000;
/** 她在玩游戏、这一轮停下了、话也说完了，等这么久直播间还没事，就叫她接着玩 */
const GAME_WAKE_MS = 6_000;
/** 她在玩游戏时，欢迎新观众至少隔这么久（攒成一句一起欢迎） */
const GAME_WELCOME_GAP_MS = 90_000;
/** 点播视频最长 20 分钟；超过这个长度要粉丝团 10 级以上才能点 */
const MAX_VIDEO_SEC = 20 * 60;
/** 点长视频需要的粉丝团等级（严格大于这个等级） */
const LONG_VIDEO_FAN_LEVEL = 10;
/** 她在玩游戏时，一次推给她的弹幕至少可以有几位观众的（攒了一阵的弹幕一句话一起回） */
const GAME_CHAT_PICKS = 3;
/** 游戏线这么久没有游戏里的时刻，就当游戏没在玩了（不再叫她） */
const GAME_MOMENT_FRESH_MS = 5 * 60_000;
/** 一件事里观众、主人的原话（交给游戏线时附上）；不是弹幕和主人的话返回 '' */
function originalWords(topic: Topic | null): string {
  if (!topic) return '';
  if (topic.kind === 'chat') return topic.picks.map((p) => `${p.event.user.name}：${p.text}`).join('\n');
  if (topic.kind === 'owner') return `${topic.who ?? '主人'}：${topic.text}`;
  return '';
}

/** 插件重启、游戏线还在把游戏开回来时，给直播线看的游戏情况 */
const GAME_RESTARTING = '插件刚重启了一下，游戏也跟着断了，正在重新开（还没回到游戏里）';
const GAME_LINE_RESUMED = '直播插件刚重启了一下，游戏那局也跟着断了：用 game_start 重新开，存档还在，接着玩。';
const GAME_LINE_END = '直播结束了，这局就停在这里：这一轮到这儿结束，不用再调游戏工具，也不用再说话。';
/** 她在玩游戏时，嘴里还排着这么多句没念完，就先不推新的弹幕 */
const GAME_MOUTH_BACKLOG = 2;
/** 控制台「模拟观众」的用户 id 前缀 */
export const SIMULATED_PREFIX = 'sim-';

/** 开场时告诉她现在几号、几点（服务器在北京时间）：她只知道日期的话，下午开播也会说「晚上好」 */
function whenNow(d: Date): string {
  const h = d.getHours();
  const part = h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
  return `${d.getMonth() + 1}月${d.getDate()}日${part} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class LiveShow {
  readonly hub = new LiveHub();
  readonly stage = new Stage();
  /** 舞台上放视频（她用 play_video）：放完了告诉她 */
  readonly player = new Player(this.stage, (video, how, playedSec) => {
    this.record({ type: 'video', bvid: video.bvid, title: video.title, how, playedSec: Math.round(playedSec) });
    this.endWatch(how, playedSec);
    if (this.onAir && !this.ending && !video.answered) this.priority.push({ kind: 'video', title: video.title, how, playedSec });
    this.nextInQueue();
  });
  private attention: LiveAttention;
  private memory: LiveMemory;
  private onAir = false;
  private ending = false;
  private endingTimer: NodeJS.Timeout | null = null;
  private brain: BrainState = 'off';
  private brainSession: string | null = null;
  /**
   * 游戏线：另一个会话里的她，专门玩游戏（直播线回直播间，两边的请求同时跑、互不等待）。
   * 有游戏线时，直播间的事（主人的话也是）只推给直播线；游戏线这一轮停下就叫她接着玩
   */
  private gameSession: string | null = null;
  /** 小钢炮（维修工）的会话：它只回气泡，不出声 */
  private repairSession: string | null = null;
  private gameTurnRunning = false;
  private gameTurnEndedAt = 0;
  private gamePushing = false;
  /** 要交给游戏线的话（直播线定下的事、续播），导演一条一条送 */
  private gameMail: string[] = [];
  /** 游戏那边现在怎样（游戏线最近一个时刻的进度和身体在干什么）：写进给直播线的每件事里 */
  private gameNow = '';
  /**
   * 插件重启前在玩游戏、游戏线还没回到游戏里：快照照样记着在玩（再重启一次也不会忘），
   * 给直播线的事里写着游戏断了、正在重开（不然她会照着记忆接着讲游戏）
   */
  private resumingGame = false;
  /** 送不到游戏线（它的会话不在线）上次报警的时间 */
  private gameLineWarnedAt = 0;
  /** 游戏线最近一次有游戏里的时刻（game_continue / game_act 的结果）是什么时候 */
  private gameMomentAt = 0;
  /** 嘴里排着的话里有几句是游戏线的（直播线推下一件事时不等这些） */
  private queuedGame = 0;
  /** 直播线正在回的那件事（交给游戏线时附上里面观众、主人的原话） */
  private lastTopic: Topic | null = null;
  /** 点单队列：只有这一份（见 core/orders） */
  private orders = new OrderBook();
  /** 游戏线最近一个时刻的全文（直播线用 game_state 查） */
  private gameMomentFull = '';
  /** 她这一轮还在进行（推了一件事、或者主人在会话里直接跟她说话） */
  private turnRunning = false;
  private turnSince = 0;
  private pushing = false;
  /** 道别已经推给她了：这一轮结束、话念完就收工 */
  private endingPushed = false;
  /** 边看边聊：正在放的视频里有什么、上次告诉她看到了哪一秒、什么时候告诉的 */
  private watch: { id: string; notes: VideoNotes; seenSec: number; toldAt: number } | null = null;
  /** 正在放的视频放完 / 停下 / 被换掉时告诉谁（视频库记她放的时候说了什么）；saidFrom：开始放时她说到第几句 */
  private playing: { id: string; saidFrom: number; done: (end: VideoEnd) => void } | null = null;
  /** 点播排队：正在放的时候有人点，先排着，放完自动接下一个 */
  private videoQueue: Array<{ id: string; request: PlayRequest; notes?: VideoNotes; done?: (end: VideoEnd) => void; who: string }> = [];
  /** 点歌排队：和点播分开排，轮到时唱（舞台上显示歌词） */
  private songQueue: Array<{ id: string; request: PlayRequest; who: string }> = [];
  private queueSeq = 0;
  /** 现在在放的视频是谁点的 */
  private playingWho = '';
  /** 开播账号新收到的私信、回复（没别的事要回时告诉她） */
  private inbox: string[] = [];
  /** 她在直播里玩的游戏（dsh-game 给的画面来源）；null：没在玩 */
  private game: GameSource | null = null;
  private gamePushedAt = 0;
  private turnEndedAt = 0;
  /** 上一次提醒观众点赞/关注是什么时候 */
  private lastPlugAt = 0;
  /** 上一次把常客榜推给舞台是什么时候 */
  private regularsAt = 0;
  /** 共创连续剧：现在这一章（跨场保留） */
  private story: StoryRow | null = null;
  /** 读书会：上次提醒她接着读是什么时候 */
  private readPromptAt = 0;
  /** 查房：上次去别人直播间是什么时候（防刷） */
  private lastVisitAt = 0;
  /** 捉迷藏：藏到了哪个组件（下标）、下次能玩的时间 */
  private hideTarget = -1;
  private hideNextAt = 0;
  /** 正在串门：串门和点播只能有一个，串门期间不接队列里的下一个 */
  private visiting = false;
  /** 串门截止时间（ms）：到点自己结束，不依赖外面的定时器 */
  private visitUntil = 0;
  /** 读书会：正在读的书和位置（章节、段落） */
  private reading: { book: Book; chapter: number; para: number } | null = null;
  /** 小钢炮（维修工）：最近几条对话、忙碌到什么时候、恢复待机的定时器 */
  private repairMessages: Array<{ id: string; text: string; at: number }> = [];
  private repairBusyUntil = 0;
  private repairTimer: NodeJS.Timeout | null = null;
  /** 通用投票：开播主题、选书、继续/换章/讨论 */
  private poll: {
    question: string;
    options: string[];
    votes: number[];
    voters: Map<string, number>;
    endsAt: number;
    done: boolean;
    timer: NodeJS.Timeout | null;
  } | null = null;
  /** 自动播放合集：上一次尝试的时间 / 是否正在取 */
  private autoTriedAt = 0;
  private autoBusy = false;
  /** 最近一次观众点播的时间（凌晨自动下播用：刚有人点就先不下播） */
  private lastRequestAt = 0;
  /** game_continue 在等：直播间有事推给她时叫醒它（liveBody.attention） */
  private attentionWaiters = new Set<() => void>();
  private director: NodeJS.Timeout | null = null;
  private seq = 0;
  /** 排在弹幕前面的事：主人的话、开场、谢幕 */
  private priority: TopicBody[] = [];
  private speaking = 0;
  /** 她写好、还没念完的话（包括排着队等嘴的）：导演看这个决定要不要推下一件 */
  private queued = 0;
  private lines: SpokenLine[] = [];
  private herLines: string[] = [];
  private logFile: string | null = null;
  private roomTimer: NodeJS.Timeout | null = null;
  private lastRoom = '';
  private roomId: number | null = null;
  private unsubscribe: (() => void) | null = null;
  /** 记住这个直播间的观众：只有主人说这是自己的直播间才记（连别人的直播间旁观时不建档） */
  rememberViewers = false;
  /** 这一场记不记（开播时按 rememberViewers 定下来） */
  private memoryStream = false;

  constructor(private readonly hooks: ShowHooks, private readonly options: ShowOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.memory = new LiveMemory(new LiveMemoryStore(join(options.dataDir, 'live-memory.db')));
    this.attention = this.freshAttention();
    setHerNames(options.names);
  }

  private freshAttention(): LiveAttention {
    const a = new LiveAttention(Date.now());
    if (this.options.idleAfterMs) a.idleAfterMs = this.options.idleAfterMs();
    return a;
  }

  setNames(names: string[]): void {
    this.options.names = names;
    setHerNames(names);
  }

  // ── 直播间连接 ─────────────────────────────────────

  connect(roomId: number, cookie: string, rememberViewers = false): LiveStatus {
    this.rememberViewers = rememberViewers;
    this.unsubscribe?.();
    const status = this.hub.connect({ platform: 'bilibili', roomId, cookie });
    this.roomId = roomId;
    this.unsubscribe = this.hub.subscribe((event, isUpdate) => this.observe(event, isUpdate));
    if (!this.roomTimer) this.roomTimer = setInterval(() => this.syncRoom(), 1000);
    return status;
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.hub.disconnect();
    this.roomId = null;
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.roomTimer = null;
  }

  /** 测试用：不连直播间也能往里塞事件（控制台的「模拟观众」） */
  inject(event: LiveEvent): void {
    // 先订阅再塞：反过来的话，没连直播间时塞的第一条事件谁也收不到（彩排里第一位进场的观众没被欢迎）
    if (!this.unsubscribe) this.unsubscribe = this.hub.subscribe((e, isUpdate) => this.observe(e, isUpdate));
    this.hub.ingest(event);
  }

  private observe(event: LiveEvent, isUpdate: boolean): void {
    if (this.isBlocked(event.user.id)) return;
    const now = Date.now();
    this.attention.observe(event, isUpdate, now);
    // 只记自己直播间的观众（主人在控制台勾了的）；模拟观众（控制台彩排）不记
    if (this.onAir && this.memoryStream && !event.user.id.startsWith(SIMULATED_PREFIX)) this.memory.observe(event, isUpdate, now);
    const shown = toStage(event);
    if (shown) this.stage.broadcast({ type: 'live', event: shown, isUpdate });
    if (this.onAir) this.recordViewer(event, isUpdate);
    // 大额礼物：额外提醒她用一句特别的话谢人家
    if (this.onAir && !isUpdate && event.kind === 'gift' && event.valueYuan >= (this.options.unlockYuan?.() ?? 30)) {
      this.inbox.push(`有人送了大礼（¥${Math.round(event.valueYuan)}）：用一句特别的话谢谢他，顺口问问他有没有想让你做的小事。`);
    }
    this.maybeAutoSong(event, isUpdate);
    this.maybeAutoBook(event, isUpdate);
    this.maybeRepair(event, isUpdate);
    this.maybeVisit(event, isUpdate);
    this.maybeDiscover(event, isUpdate);
    this.maybeVote(event, isUpdate);
  }

  /** 弹幕说「捉迷藏」：提醒她开局 */
  private maybeDiscover(event: LiveEvent, isUpdate: boolean): void {
    if (!this.onAir || this.ending || isUpdate || event.kind !== 'chat') return;
    if (!/捉迷藏/.test(String(event.text ?? ''))) return;
    if (Date.now() < this.hideNextAt) return;
    const who = cleanName(event.user.name) || '观众';
    this.inbox.push(`${who} 想玩捉迷藏：调 hide_and_seek 开局，然后让大家发数字投票猜你在哪（10 秒）。`);
    this.note('捉迷藏', `${who} 发起了捉迷藏`);
  }

  /** 弹幕发别人的房间号（5 位以上）：去查房看看对方在播什么 */
  private maybeVisit(event: LiveEvent, isUpdate: boolean): void {
    if (!this.onAir || this.ending || isUpdate || event.kind !== 'chat') return;
    const text = String(event.text ?? '').trim();
    // 直播间链接、纯房间号、或者「串门/查房/去看看 12345678」都认（房间号 5～12 位）
    const url = /live\.bilibili\.com\/(\d{5,12})/.exec(text);
    const bare = /^\s*(?:房间号?|查房|串门|去看看)?\s*[:：]?\s*(\d{5,12})\s*$/.exec(text);
    const keyword = /(?:房间号?|查房|串门|去看看)[^\d]{0,8}(\d{5,12})/.exec(text);
    const id = url?.[1] ?? bare?.[1] ?? keyword?.[1];
    if (!id) return;
    const now = Date.now();
    if (now - this.lastVisitAt < 20_000) return;
    this.lastVisitAt = now;
    const who = cleanName(event.user.name) || '观众';
    this.inbox.push(`${who} 让你去查房（房间号 ${id}）：用 visit_room 看看对方在播什么、标题人气怎么样，再跟大家点评两句。`);
    this.note('查房', `${who} 让去房间 ${id}`);
  }

  /** 观众 @ 小钢炮：它接维修活（文字气泡，不出声） */
  private maybeRepair(event: LiveEvent, isUpdate: boolean): void {
    if (!this.onAir || this.ending || isUpdate || event.kind !== 'chat') return;
    const text = String(event.text ?? '').trim();
    if (!/小钢炮|钢炮/.test(text)) return;
    const who = cleanName(event.user.name) || '观众';
    // 有独立会话就交给小钢炮本人回（语气、追问都更自然），它的话只进气泡
    if (this.repairSession) {
      this.repairBusyUntil = Date.now() + 20_000;
      this.publishRepair();
      this.repairMessages.push({ id: `r-${Date.now()}-${this.repairMessages.length}`, text: `${who}：小钢炮正在看……`, at: Date.now() });
      this.repairMessages = this.repairMessages.slice(-4);
      this.publishRepair();
      void this.hooks
        .push(this.repairSession, `直播间里 ${who} 说：${text}\n你是「小钢炮」，直播间里负责维修的机器人。用一两句话回应：先接住他的话，再给一个具体的排查方向或下一步；别用表情标记，别报名字。`, false)
        .catch(() => false);
      return;
    }
    const reply = this.repairAnswer(text);
    this.repairMessages.push({ id: `r-${Date.now()}-${this.repairMessages.length}`, text: `${who}：${reply}`, at: Date.now() });
    this.repairMessages = this.repairMessages.slice(-4);
    this.repairBusyUntil = Date.now() + 6000;
    this.publishRepair();
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = setTimeout(() => this.publishRepair(), 6500);
    this.note('维修', `${who} 找小钢炮：${text.slice(0, 24)}`);
  }

  /** 小钢炮按症状给一句人话（先玩梗后给建议） */
  private repairAnswer(text: string): string {
    if (/卡|掉帧|延迟|一顿|卡顿|网/.test(text)) return '先看丢帧：OBS 状态栏丢帧超过 5% 就是上行不够——插网线，码率压到 1500，别硬撑 2000。';
    if (/没声|无声|声音|爆音|回声|重复/.test(text)) return '声音先拆三处：OBS 音频混合器有没有跳、舞台源是不是被静音、采样率统一 48k；回声多半是同一条音源被放了两遍。';
    if (/黑屏|花屏|画面|绿屏/.test(text)) return '黑屏先看采集源窗口还在不在；花屏多半是编码器参数太猛，换 QSV 的 balanced 档。';
    if (/崩|闪退|打不开|报错/.test(text)) return '闪退先清 %APPDATA%\\obs-studio\\.sentinel；插件报错把日志发我，我按报错代码给你拆。';
    if (/修|坏|炸|漏|断|烧/.test(text)) return '报型号、症状、什么时候开始的——我按三步拆：先断电，再复位，最后换件。';
    return '有东西要修？说清楚：什么设备、什么症状、刚才动了什么，我一个个拆。';
  }

  /** 把它的对话推上舞台（右上角气泡） */
  private publishRepair(): void {
    this.stage.broadcast({
      type: 'repair',
      messages: this.repairMessages,
      busy: Date.now() < this.repairBusyUntil,
    });
  }

  /** 弹幕里说「读 xx」：书架上找得到就直接打开（接着上次进度） */
  private maybeAutoBook(event: LiveEvent, isUpdate: boolean): void {
    if (!this.options.bookMode?.()) return;
    if (!this.onAir || this.ending || isUpdate || !this.options.bookByQuery) return;
    if (event.kind !== 'chat') return;
    const text = String(event.text ?? '').trim();
    const m = /(?:读书会|读一下|读读|想读|读)\s*《?([^\s，,。！!？?》]{1,30})》?/.exec(text);
    if (!m) return;
    const title = this.options.bookByQuery(m[1].trim());
    if (!title) return;
    const who = cleanName(event.user.name) || '观众';
    this.inbox.push(`${who} 想读《${title}》，我已经把书打开、跳到上次读到的位置了——接着读就行。`);
    this.note('读书', `${who} 点了《${title}》`);
  }

  /** 共创连续剧投票：弹幕发 1/2 或 A/B 就算一票（同一章每人只算一次） */
  private maybeVote(event: LiveEvent, isUpdate: boolean): void {
    if (!this.onAir || this.ending || isUpdate || event.kind !== 'chat') return;
    const chatText = String(event.text ?? '').trim();
    // 通用投票（开播主题、选书、继续/换章/讨论）：发 1/2/3 就算一票
    const poll = this.poll;
    if (poll && !poll.done) {
      const n = Number(chatText);
      if (Number.isInteger(n) && n >= 1 && n <= poll.options.length) {
        if (poll.voters.has(event.user.id)) return;
        poll.voters.set(event.user.id, n - 1);
        poll.votes[n - 1] += 1;
        this.publishPoll();
        return;
      }
    }
    const story = this.story;
    if (!story || story.resolved_at) return;
    const text = chatText.toLowerCase();
    const pick = /^(1|选1|a|选a)$/.test(text) ? 'a' : /^(2|选2|b|选b)$/.test(text) ? 'b' : null;
    if (!pick) return;
    const row = this.memory.store.voteStory(story.id, event.user.id, pick);
    if (!row) return;
    this.story = row;
    this.publishStory();
  }

  /** 把这一章的进度推上舞台（剧情事件 + 底部滚动通知，任何模板都看得到） */
  publishStory(): void {
    const story = this.story;
    if (!story) return;
    this.stage.broadcast({
      type: 'story',
      story: {
        id: story.id,
        chapter: story.chapter,
        title: story.title,
        question: story.question,
        a: story.option_a,
        b: story.option_b,
        votesA: story.votes_a,
        votesB: story.votes_b,
        chosen: story.chosen,
        summary: story.summary,
      },
    });
    const line = story.resolved_at
      ? `第 ${story.chapter} 章「${story.title}」定下了：${story.chosen === 'a' ? story.option_a : story.option_b}`
      : `第 ${story.chapter} 章「${story.title}」｜${story.question}｜1 = ${story.option_a}（${story.votes_a}） 2 = ${story.option_b}（${story.votes_b}）`;
    this.stage.broadcast({ type: 'notice', text: line, at: Date.now() });
  }

  /** 弹幕里带「点歌」就直接排进点歌队列，不用等她判断 */
  private maybeAutoSong(event: LiveEvent, isUpdate: boolean): void {
    if (!this.onAir || this.ending || isUpdate || !this.options.songByQuery) return;
    if (event.kind !== 'chat') return;
    const text = String(event.text ?? '').trim();
    const m = /(?:点歌|想听|来一首|来首|唱一首|唱个|唱首)[：:\s]*([^\s，,。！!？?]{1,40})/.exec(text);
    if (!m) return;
    const query = m[1].trim();
    if (!query) return;
    const request = this.options.songByQuery(query);
    if (!request) return;
    const who = cleanName(event.user.name) || '观众';
    const result = this.queueSong(request, who);
    const where = result.queued ? `第 ${result.position} 位` : '马上唱';
    this.notifyInbox([`${who} 点了「${request.title}」，已经自动排进点歌队列（${where}）——不用再调 sing_song，直接回应一下就好。`]);
  }

  /**
   * 观众的原话和礼物，按 uid 原样记进这场的记录：下播后的私信、复盘只读这个，不从她的台词或推给她的提示里猜。
   * 礼物连击会用同一个 id 再来几次（数量、钱数是累计的）：读的时候每个 id 取最后一条
   */
  private recordViewer(event: LiveEvent, isUpdate: boolean): void {
    const who = { uid: event.user.id, user: cleanName(event.user.name) };
    if (event.kind === 'gift') {
      if (event.valueYuan > 0) {
        this.record({ type: 'event', kind: 'gift', id: event.id, ...who, gift: cleanName(event.giftName), count: event.count, yuan: event.valueYuan });
        this.options.giftLog?.({ uid: event.user.id, name: who.user, gift: cleanName(event.giftName), count: event.count, yuan: event.valueYuan });
      }
      return;
    }
    if (isUpdate) return;
    if (event.kind === 'chat') this.record({ type: 'event', kind: 'chat', ...who, text: cleanText(event.text) });
    else if (event.kind === 'superchat') this.record({ type: 'event', kind: 'superchat', ...who, yuan: event.valueYuan, text: cleanText(event.text) });
    else if (event.kind === 'membership') this.record({ type: 'event', kind: 'membership', ...who, level: event.levelName, count: event.count, yuan: event.valueYuan });
  }

  /** 在线人数、主播身份、开没开播：跟着直播间走 */
  private syncRoom(): void {
    const status = this.hub.status();
    this.attention.setOnline(status.stats.online);
    this.attention.setAnchorId(status.room?.anchorId);
    // 直播间没开播（主人在测试）：没人在看也照常演
    this.attention.setRehearsal(status.stats.live !== true);
    const room = JSON.stringify([status.stats.online, status.room?.title, this.onAir]);
    if (room !== this.lastRoom) {
      this.lastRoom = room;
      this.stage.broadcast({ type: 'room', online: status.stats.online, title: status.room?.title, onAir: this.onAir });
    }
  }

  // ── 开播、下播 ─────────────────────────────────────

  /** 开播：sessionId 是她直播用的会话（控制台刚开好的），身体先推开场 */
  goLive(sessionId: string, gameSessionId?: string, repairSessionId?: string): void {
    this.brainSession = sessionId;
    this.gameSession = gameSessionId ?? null;
    this.repairSession = repairSessionId ?? null;
    if (this.onAir) return;
    this.resetGameLine();
    this.onAir = true;
    this.ending = false;
    this.endingPushed = false;
    this.turnRunning = false;
    this.attention = this.freshAttention();
    this.liveSince = Date.now();
    this.lastPlugAt = this.liveSince;
    this.regularsAt = 0;
    try {
      this.story = this.memory.store.currentStory();
    } catch {
      this.story = null;
    }
    if (this.story) {
      this.publishStory();
      this.inbox.push(
        `上一场留下的剧情还没结束：第 ${this.story.chapter} 章「${this.story.title}」，${this.story.question}（1 = ${this.story.option_a}，${this.story.votes_a} 票；2 = ${this.story.option_b}，${this.story.votes_b} 票）。开场时顺口提一句接着演，让观众继续投票。`,
      );
    }
    this.spoken = 0;
    // 别人的直播间（旁观、试播）不留任何记忆：不建档，也不写这场的回顾
    this.memoryStream = this.rememberViewers;
    if (this.memoryStream) this.memory.begin(Date.now());
    this.priority = [{ kind: 'opening' }];
    this.inbox = [];
    this.lines = [];
    this.orders = new OrderBook();
    this.publishOrders(false);
    this.videoQueue = [];
    this.songQueue = [];
    this.playingWho = '';
    this.publishQueue();
    this.herLines = [];
    this.openLog();
    this.setBrain('listening');
    this.syncRoom();
    if (!this.director) this.director = setInterval(() => void this.direct(), TICK_MS);
    this.persistLive();
  }

  /** 插件重启后接着播（同一个会话、同一场记忆和记录）：先告诉她断了多久 */
  resumeLive(snapshot: LiveSnapshot, now = Date.now()): void {
    if (this.onAir) return;
    this.brainSession = snapshot.sessionId;
    this.gameSession = snapshot.gameSessionId ?? null;
    this.repairSession = snapshot.repairSessionId ?? null;
    this.resetGameLine();
    // 有游戏线时，游戏那局由游戏线开回来；直播线只知道断了多久
    const playing = !!snapshot.playing && !this.gameSession;
    if (snapshot.playing && this.gameSession) {
      this.gameMail.push(GAME_LINE_RESUMED);
      this.resumingGame = true;
    }
    this.onAir = true;
    this.ending = false;
    this.endingPushed = false;
    this.turnRunning = false;
    this.attention = this.freshAttention();
    this.memoryStream = snapshot.streamId !== null;
    if (snapshot.streamId !== null) this.memory.resume(snapshot.streamId);
    this.liveSince = snapshot.startedAt ?? snapshot.at;
    this.spoken = snapshot.spokenChars ?? 0;
    this.orders = new OrderBook(snapshot.orders);
    this.publishOrders(false);
    this.priority = [{ kind: 'resumed', gapSec: Math.max(1, Math.round((now - snapshot.at) / 1000)), ...(playing ? { playing: true } : {}) }];
    this.inbox = [];
    this.logFile = snapshot.logFile;
    this.record({ type: 'resume', gapMs: now - snapshot.at });
    this.setBrain('listening');
    this.syncRoom();
    if (!this.director) this.director = setInterval(() => void this.direct(), TICK_MS);
    this.persistLive();
  }

  /** 一场没收尾就停了、又太久没接上（不是正常的重启）：把它记成结束，观众记忆照常提炼 */
  closeStale(snapshot: LiveSnapshot): void {
    if (snapshot.streamId === null || !this.hooks.distill) return;
    this.memory.resume(snapshot.streamId);
    const streamId = this.memory.end(snapshot.at);
    if (streamId === null) return;
    void distillStream(this.memory.store, streamId, { herLines: [], name: this.options.names[0] ?? '' }, this.hooks.distill, Date.now())
      .then((r) => this.hooks.log?.('info', `上一场直播的记忆提炼完：${r.viewers} 位观众`))
      .catch((err) => this.hooks.log?.('warn', `上一场直播的记忆提炼失败：${(err as Error).message}`));
  }

  private persistedAt = 0;
  private persistLive(now = Date.now()): void {
    if (!this.onAir || !this.brainSession) return;
    this.persistedAt = now;
    this.hooks.persist?.({ sessionId: this.brainSession, roomId: this.roomId, streamId: this.memoryStream ? this.memory.currentStream : null, logFile: this.logFile, at: now, startedAt: this.liveSince, spokenChars: this.spoken, ...(this.gameOn || this.resumingGame ? { playing: true } : {}), ...(this.gameSession ? { gameSessionId: this.gameSession } : {}), ...(this.repairSession ? { repairSessionId: this.repairSession } : {}), ...(this.orders.open().length || this.orders.shown().length ? { orders: this.orders.toJSON() } : {}) });
  }

  private liveSince = 0;
  private spoken = 0;

  /** 这场播了多久、她念了多少字 */
  stats(now = Date.now()): { liveMs: number; spokenChars: number } {
    return { liveMs: this.onAir ? now - this.liveSince : 0, spokenChars: this.spoken };
  }

  /** 下播：先让她道别，说完（或等太久）就收工 */
  endLive(): void {
    if (!this.onAir || this.ending) return;
    this.ending = true;
    this.priority.unshift({ kind: 'ending', summary: '' });
    this.endingTimer = setTimeout(() => this.finish(), ENDING_GRACE_MS);
  }

  private finish(): void {
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = null;
    if (this.poll?.timer) clearTimeout(this.poll.timer);
    this.poll = null;
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = null;
    this.repairMessages = [];
    this.repairBusyUntil = 0;
    this.reading = null;
    this.readPromptAt = 0;
    if (!this.onAir) return;
    this.stopVideo('off');
    this.videoQueue = [];
    this.songQueue = [];
    this.playingWho = '';
    this.publishQueue();
    this.onAir = false;
    this.ending = false;
    this.endingPushed = false;
    this.priority = [];
    // 游戏线收手：这一轮结束，不再叫她
    if (this.gameSession) {
      void this.hooks.push(this.gameSession, GAME_LINE_END, this.gameTurnRunning).catch(() => false).then(() => {
        for (const wake of [...this.attentionWaiters]) wake();
      });
    }
    this.resetGameLine();
    if (this.director) clearInterval(this.director);
    this.director = null;
    this.setBrain('off');
    this.syncRoom();
    const streamId = this.memoryStream ? this.memory.end(Date.now()) : null;
    this.memoryStream = false;
    this.hooks.persist?.(null);
    this.record({ type: 'end' });
    this.logFile = null;
    this.writeDiary();
    if (streamId !== null && this.hooks.distill) {
      const herLines = this.herLines.slice();
      void distillStream(this.memory.store, streamId, { herLines, name: this.options.names[0] ?? '' }, this.hooks.distill, Date.now())
        .then((r) => this.hooks.log?.('info', `直播记忆提炼完：${r.viewers} 位观众，回顾 ${r.recap.length} 条`))
        .catch((err) => this.hooks.log?.('warn', `直播记忆提炼失败：${(err as Error).message}`));
    }
  }

  /** 剧情换场景：src 是场景名（scenes/<名字>.jpg），null 回到模板背景 */
  setScene(name: string | null): void {
    const clean = name ? String(name).trim().slice(0, 64) : '';
    this.stage.broadcast({ type: 'scene', src: clean ? `/scene?id=${encodeURIComponent(clean)}` : null });
  }

  /** 打开一本书：接着上次的进度（跨场保留） */
  openBook(book: Book): { chapter: number; chapterTitle: string; para: number; total: number } {
    // 读书会关着：不切换布局、不停视频，返回空进度
    if (!this.options.bookMode?.()) return { chapter: 0, chapterTitle: '', para: 0, total: book.chapters.length };
    // 读书会优先：把正在放的视频停掉，舞台中间换成书页
    if (this.player.current) this.stopVideo('replaced');
    const saved = this.memory.store.getBookProgress(book.id);
    const chapter = Math.min(Math.max(0, saved?.chapter ?? 0), book.chapters.length - 1);
    const para = Math.max(0, saved?.para ?? 0);
    this.reading = { book, chapter, para };
    this.readPromptAt = Date.now();
    this.publishBook();
    return { chapter, chapterTitle: book.chapters[chapter]?.title ?? '', para, total: book.chapters.length };
  }

  /** 读接下来的几段（返回正文；读到底返回 null） */
  readParagraphs(count = 1): string | null {
    const reading = this.reading;
    if (!reading) return null;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const chapter = reading.book.chapters[reading.chapter];
      if (!chapter) break;
      const paras = chapter.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      // 第一段如果就是章节标题（很多 txt 会这样），跳过它，别把标题当正文念
      if (reading.para === 0 && paras[0] === chapter.title && paras.length > 1) reading.para = 1;
      if (reading.para >= paras.length) {
        if (reading.chapter + 1 >= reading.book.chapters.length) break;
        reading.chapter += 1;
        reading.para = 0;
        continue;
      }
      out.push(paras[reading.para]);
      reading.para += 1;
    }
    this.memory.store.saveBookProgress(reading.book.id, reading.chapter, reading.para, Date.now());
    this.publishBook();
    return out.join('\n') || null;
  }

  /** 跳到某一章开头 */
  bookJump(chapter: number): boolean {
    const reading = this.reading;
    if (!reading) return false;
    const index = Math.min(Math.max(0, Math.floor(chapter)), reading.book.chapters.length - 1);
    reading.chapter = index;
    reading.para = 0;
    this.memory.store.saveBookProgress(reading.book.id, index, 0, Date.now());
    this.publishBook();
    return true;
  }

  /** 收起读书会 */
  closeBook(): void {
    this.reading = null;
    this.stage.broadcast({ type: 'book', book: null });
  }

  /** 现在读的书（工具/状态用） */
  get currentBook(): { title: string; chapter: number; chapterTitle: string; para: number; total: number } | null {
    const r = this.reading;
    if (!r) return null;
    return { title: r.book.title, chapter: r.chapter, chapterTitle: r.book.chapters[r.chapter]?.title ?? '', para: r.para, total: r.book.chapters.length };
  }

  // ── 捉迷藏 ────────────────────────────────

  /** 发起捉迷藏：随机躲到某个组件后面，10 秒投票，到点判输赢 */
  startHideGame(): { ok: boolean; text: string } {
    const now = Date.now();
    if (now < this.hideNextAt) return { ok: false, text: '刚玩过，等一会儿再玩吧。' };
    const options = ['弹幕栏', '点播排队', '礼物榜', '小钢炮', '终端', '常客榜'];
    this.hideTarget = Math.floor(Math.random() * options.length);
    this.hideNextAt = now + 5 * 60_000;
    this.stage.broadcast({ type: 'hide', phase: 'hide' });
    this.startPoll('她躲到哪儿了？', options, 10);
    setTimeout(() => this.finishHideGame(options), 11_500);
    return { ok: true, text: `躲好了（答案是第 ${this.hideTarget + 1} 个「${options[this.hideTarget]}」，别告诉观众）。` };
  }

  private finishHideGame(options: string[]): void {
    this.stage.broadcast({ type: 'hide', phase: 'reveal' });
    setTimeout(() => this.stage.broadcast({ type: 'hide', phase: 'end' }), 5000);
    const poll = this.poll;
    if (!poll || !poll.done) return;
    const max = Math.max(...poll.votes);
    const winners = poll.votes.map((v, i) => (v === max && v > 0 ? i : -1)).filter((i) => i >= 0);
    const hit = poll.votes[this.hideTarget] === max && max > 0 && winners.includes(this.hideTarget);
    if (hit) {
      const names = [...poll.voters.entries()]
        .filter(([, choice]) => choice === this.hideTarget)
        .slice(0, 3)
        .map(([uid]) => {
          const found = this.lookupViewer(uid);
          return found.kind === 'found' ? String(found.user.name) : '';
        })
        .filter(Boolean);
      this.inbox.push(`被找到了！念出这句：「哇！被找到了～」然后夸选对的：${names.join('、') || '猜对的那几位'}，说他们眼力真好。`);
    } else {
      this.inbox.push(`没人猜对（她躲在「${options[this.hideTarget]}」后面）。念：「惩罚！」然后直接切下一个点播。`);
      if (this.player.current) this.stopVideo('replaced');
    }
  }

  // ── 通用投票（开播主题 / 选书 / 继续·换章·讨论）──

  /** 开一个投票：观众发 1/2/3 选；到点自动结算，结果进收件箱 */
  startPoll(question: string, options: string[], seconds = 60): { question: string; options: string[]; endsAt: number } {
    if (this.poll?.timer) clearTimeout(this.poll.timer);
    const clean = options.map((o) => String(o).slice(0, 20)).filter(Boolean).slice(0, 4);
    const poll = {
      question: String(question).slice(0, 40),
      options: clean,
      votes: clean.map(() => 0),
      voters: new Map<string, number>(),
      endsAt: Date.now() + Math.max(10, Math.min(300, seconds)) * 1000,
      done: false,
      timer: null as NodeJS.Timeout | null,
    };
    this.poll = poll;
    poll.timer = setTimeout(() => this.endPoll(), Math.max(10, Math.min(300, seconds)) * 1000);
    this.publishPoll();
    this.note('投票', `${poll.question}（${clean.map((o, i) => `${i + 1}=${o}`).join(' / ')}）`);
    return { question: poll.question, options: poll.options, endsAt: poll.endsAt };
  }

  /** 提前结束投票 */
  endPoll(): void {
    const poll = this.poll;
    if (!poll || poll.done) return;
    poll.done = true;
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
    this.publishPoll();
    const max = Math.max(...poll.votes);
    const winners = poll.options.filter((_, i) => poll.votes[i] === max && max > 0);
    const result = max > 0 ? winners.join('、') : '没人投票';
    const detail = poll.options.map((o, i) => `${o} ${poll.votes[i]} 票`).join('；');
    this.inbox.push(`投票结束：「${poll.question}」结果——${result}（${detail}）。按这个结果继续。`);
    this.note('投票结果', `${result}（${detail}）`);
  }

  /** 现在/上一次投票的结果（工具读） */
  get pollResult(): string | null {
    const poll = this.poll;
    if (!poll) return null;
    const detail = poll.options.map((o, i) => `${i + 1}=${o}（${poll.votes[i]} 票）`).join('；');
    if (!poll.done) return `投票进行中：「${poll.question}」${detail}`;
    const max = Math.max(...poll.votes);
    const winners = poll.options.filter((_, i) => poll.votes[i] === max && max > 0);
    return `投票已结束：「${poll.question}」赢家是 ${max > 0 ? winners.join('、') : '没人投票'}（${detail}）`;
  }

  private publishPoll(): void {
    const poll = this.poll;
    if (!poll) return;
    this.stage.broadcast({
      type: 'poll',
      poll: {
        question: poll.question,
        options: poll.options,
        votes: poll.votes,
        endsAt: poll.endsAt,
        done: poll.done,
      },
    });
    // 没有投票挂件的模板：底部滚动通知也显示一份
    const line = poll.options.map((o, i) => `${i + 1}=${o}（${poll.votes[i]}）`).join('  ');
    this.stage.broadcast({ type: 'notice', text: `${poll.question}${poll.done ? '（已结束）' : ''}：${line}`, at: Date.now() });
  }

  private publishBook(): void {
    const r = this.reading;
    if (!r) return;
    const chapter = r.book.chapters[r.chapter];
    const paras = chapter?.text.split(/\n+/).map((p) => p.trim()).filter(Boolean) ?? [];
    this.stage.broadcast({
      type: 'book',
      book: {
        id: r.book.id,
        title: r.book.title,
        chapter: r.chapter,
        chapterTitle: chapter?.title ?? '',
        para: r.para,
        paragraphs: paras.length,
        total: r.book.chapters.length,
        text: paras[Math.min(r.para, Math.max(0, paras.length - 1))] ?? '',
      },
    });
  }

  /** 开一章新剧情（观众共创连续剧）：观众发 1 / 2 投票 */
  beginStory(title: string, question: string, a: string, b: string): StoryRow {
    const last = this.memory.store.lastStory();
    const chapter = (last?.chapter ?? 0) + 1;
    this.story = this.memory.store.openStory(chapter, title, question, a, b, Date.now());
    this.publishStory();
    this.note('剧情', `第 ${chapter} 章「${title}」开始，发 1/2 投票`);
    return this.story;
  }

  /** 结束这一章：选中的分支 + 小结 */
  finishStory(chosen: 'a' | 'b', summary: string): StoryRow | null {
    const story = this.story;
    if (!story) return null;
    this.memory.store.resolveStory(story.id, chosen, summary, Date.now());
    this.story = { ...story, resolved_at: Date.now(), chosen, summary };
    this.publishStory();
    this.note('剧情', `第 ${story.chapter} 章结束：${chosen === 'a' ? story.option_a : story.option_b}`);
    return this.story;
  }

  /** 现在这一章（工具读状态用） */
  get currentStory(): StoryRow | null {
    return this.story;
  }

  /** 下播写日记 + 切片文案（本地 markdown；开了的话再发 B 站动态） */
  private writeDiary(): void {
    try {
      const now = Date.now();
      const mins = Math.max(1, Math.round((now - this.liveSince) / 60000));
      const regulars = this.memory.regulars(5);
      const lines = this.herLines.map((l) => l.text).filter(Boolean);
      const d = new Date(now);
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // 高光：带情绪的词优先，其次长一点的（切片文案用）
      const score = (t: string) => (/(哈|笑|！|!|？|\?)/.test(t) ? 2 : 0) + Math.min(3, Math.floor(t.length / 30));
      const highlights = [...lines].sort((a, b) => score(b) - score(a)).slice(0, 3);
      const md = [
        `# ${stamp} 直播日记`,
        '',
        `- 时长：约 ${mins} 分钟`,
        `- 常客：${regulars.length ? regulars.map((r) => `${r.name}（${r.title}）`).join('、') : '还没有'}`,
        '',
        '## 她今天说过的话',
        ...(lines.length ? lines.slice(-8).map((t) => `> ${t}`) : ['> （今天没说什么）']),
        '',
        '## 切片候选',
        ...(highlights.length ? highlights.map((t, i) => `${i + 1}. ${t}`) : ['1. （今天没有明显高光）']),
        '',
      ].join('\n');
      const dir = join(this.options.dataDir, 'diary');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${stamp}.md`), md, 'utf8');
      const post = [
        `【直播切片】${stamp}`,
        `今天播了 ${mins} 分钟。`,
        ...highlights.map((t) => `「${t.slice(0, 40)}」`),
        '#大肥鱼 #AI主播 #直播切片',
      ].join('\n');
      this.options.onDiary?.(post.slice(0, 900));
    } catch {
      // 写日记失败不影响下播
    }
  }

  /** 主人（或 who：主人那边别的人，比如帮忙管直播的经理）在控制台跟她说话 */
  ownerSay(text: string, who?: string): void {
    const said = text.trim();
    if (!said) return;
    // 主人的话只给直播线（回一次）；里面要游戏里做的事，她用 game_side 定下来
    this.priority.push({ kind: 'owner', text: said, ...(who?.trim() ? { who: who.trim() } : {}) });
  }

  /** 直播线把话交给游戏线（开游戏、观众给游戏出的主意、让它收手）；没开游戏线返回 false */
  toGameLine(text: string, who = '', now = Date.now()): boolean {
    if (!this.onAir || !this.gameSession || !text.trim()) return false;
    // 直播线交接的那条消息不念：由游戏里的她点名回观众（原话由程序附上，不靠直播线转述），再去做
    const said = originalWords(this.lastTopic);
    // 观众点的单：按原话记进点单队列（同一个人同一句只记一次）
    const made = this.ordersFrom(who, now);
    this.gameMail.push([
      ...(said ? ['直播间里的原话：', said] : []),
      `你在直播间定下：${text.trim()}`,
      ...(made.length ? [`记进了点单队列：${made.map((o) => `#${o.id} ${o.who}`).join('、')}。开始做、做完、不做时，在那句话前面写 [开工#单号]、[完成#单号]、[不做#单号]（不念出来，观众在点单栏里看得到）。`] : []),
      said ? '你还没回他：在这里用一句话点名回他，再去做。' : '去做就行，边做边说你在做什么。',
    ].join('\n'));
    if (made.length) this.publishOrders();
    return true;
  }

  /** 这次交给游戏线的事是谁点的单：直播线写了名字就按名字找，没写、这件事里又只有一位观众就是他 */
  private ordersFrom(who: string, now: number) {
    const picks = this.lastTopic?.kind === 'chat' ? this.lastTopic.picks : [];
    const names = who.split(/[、,，\s]+/).map((n) => n.trim()).filter(Boolean);
    const chosen = names.length
      ? picks.filter((p) => names.some((n) => p.event.user.name === n || p.event.user.name.includes(n) || n.includes(p.event.user.name)))
      : picks.length === 1 ? picks : [];
    return chosen.map((p) => this.orders.findOpen(p.event.user.id, p.text) ?? this.orders.add(cleanName(p.event.user.name), cleanText(p.text), now, p.event.user.id || undefined));
  }

  /** 游戏线说的话里写了单子标记：改状态 */
  markOrders(marks: Array<{ id: number; state: OrderState }>, now = Date.now()): void {
    let changed = false;
    for (const m of marks) changed = this.orders.mark(m.id, m.state, now) || changed;
    if (changed) this.publishOrders();
  }

  /** 主人在控制台改点单：改一单的状态，或者清空 */
  ownerOrders(action: { id?: number; state?: OrderState; clear?: boolean }, now = Date.now()): boolean {
    if (action.clear) this.orders.clear();
    else if (!action.id || !action.state || !this.orders.mark(action.id, action.state, now)) return false;
    this.publishOrders();
    return true;
  }

  /** 舞台上的点单栏跟着队列走；改了就存一下（插件重启后接着排） */
  private publishOrders(persist = true): void {
    this.stage.broadcast({ type: 'orders', items: this.orders.shown().map(({ id, who, text, state }) => ({ id, who, text, state })) });
    if (persist) this.persistLive();
  }

  /** 直播线交给游戏线回的那条消息：不念，只记在直播记录里 */
  unsaid(text: string, why: string): void {
    this.record({ type: 'unsaid', line: 'live', why, text });
  }

  /** 游戏线最近一个时刻的全文和是多久以前的（直播线用 game_state 查）；游戏没开返回 null */
  gameState(now = Date.now()): { text: string; ageSec: number } | null {
    if (!this.gameSession || !this.gameOn || !this.gameMomentFull) return null;
    return { text: this.gameMomentFull, ageSec: Math.max(1, Math.round((now - this.gameMomentAt) / 1000)) };
  }

  setGameMomentFull(text: string): void {
    this.gameMomentFull = text.trim();
  }

  /** 主人只跟游戏里的她说（长图纸、坐标清单这类只关游戏的事）：直接送到游戏线，不经过直播线、不截短；没开游戏线返回 false */
  ownerToGame(text: string): boolean {
    if (!this.onAir || !this.gameSession || !text.trim()) return false;
    this.gameMail.push(`主人跟你说（游戏上的事）：\n${text.trim()}`);
    return true;
  }

  get currentGameSession(): string | null {
    return this.gameSession;
  }

  get currentRepairSession(): string | null {
    return this.repairSession;
  }

  /** 开始串门：串门期间不接队列里的下一个（串门和点播只能有一个） */
  beginVisit(minutes = 3): void {
    this.visiting = true;
    // 自己记一个截止时间：就算外面的定时器丢了（DSH 重启、流程出错），到点也会自己结束
    this.visitUntil = Date.now() + Math.max(1, minutes) * 60_000 + 15_000;
    if (this.player.current) this.stopVideo('replaced');
  }

  /** 串门结束：队列接着放 */
  endVisit(): void {
    if (!this.visiting) return;
    this.visiting = false;
    this.visitUntil = 0;
    this.nextInQueue();
  }

  /** 串门到点了没有（导演每轮看一眼，超时就收掉，别一直挡着队列） */
  private visitExpired(now: number): boolean {
    return this.visiting && this.visitUntil > 0 && now > this.visitUntil;
  }

  get isVisiting(): boolean {
    return this.visiting;
  }

  /** 小钢炮说了一句：只进右上角气泡，不出声 */
  repairSay(text: string): void {
    const clean = String(text ?? '').replace(/\[[a-z]+\]/gi, '').trim();
    if (!clean) return;
    this.repairMessages.push({ id: `r-${Date.now()}-${this.repairMessages.length}`, text: clean, at: Date.now() });
    this.repairMessages = this.repairMessages.slice(-4);
    this.repairBusyUntil = 0;
    this.publishRepair();
    this.note('维修', `小钢炮：${clean.slice(0, 30)}`);
  }

  /** 游戏那边现在怎样（盯游戏线的会话时从它最近一个时刻里摘出来） */
  setGameNow(text: string, moment = false): void {
    this.gameNow = text.trim();
    if (moment) {
      this.gameMomentAt = Date.now();
      this.resumingGame = false;
    }
    // 游戏画面上那一行「她在干嘛」：只在变了的时候发
    const status = gameStatusOf(this.gameNow);
    if (status && JSON.stringify(status) !== JSON.stringify(this.gameStatus)) {
      this.gameStatus = status;
      this.stage.broadcast({ type: 'gameStatus', status });
    }
  }

  private gameStatus: GameStatus | null = null;

  /**
   * 在玩游戏：舞台上有游戏画面，或者游戏线最近还有游戏里的时刻
   * （没开摄像机、摄像机挂了时舞台上没画面，游戏照样在玩，照样要叫她接着玩）
   */
  private get gameOn(): boolean {
    return !!this.game || (!!this.gameSession && Date.now() - this.gameMomentAt < GAME_MOMENT_FRESH_MS);
  }

  private resetGameLine(): void {
    this.gameTurnRunning = false;
    this.gameTurnEndedAt = 0;
    this.gamePushing = false;
    this.gameMail = [];
    this.gameNow = '';
    this.gameMomentAt = 0;
    this.resumingGame = false;
    this.gameMomentFull = '';
  }

  /** 游戏线：有话就送；这一轮停下了、过一会儿就叫她接着玩（不等嘴，也不等直播线） */
  private async directGameLine(now: number): Promise<void> {
    if (!this.gameSession || this.gamePushing || this.ending) return;
    const mail = this.gameMail.shift();
    let text = mail;
    if (!text) {
      if (!this.gameOn || this.gameTurnRunning || now - this.gameTurnEndedAt < GAME_WAKE_MS) return;
      text = topicText({ kind: 'game', id: `g-${now}`, priority: 1, heat: this.attention.heat(now), createdAt: now }, { inGame: true });
      this.record({ type: 'topic', seq: ++this.seq, kind: 'game', line: 'game' });
    }
    const running = this.gameTurnRunning;
    this.gamePushing = true;
    try {
      const ok = await this.hooks.push(this.gameSession, text, running);
      if (!ok) {
        if (mail) this.gameMail.unshift(mail);
        if (now - this.gameLineWarnedAt > 60_000) {
          this.gameLineWarnedAt = now;
          this.hooks.log?.('warn', `游戏线的会话不在线（${this.gameSession}），要交给它的话送不出去`);
        }
        return;
      }
      if (!running) {
        this.gameTurnRunning = true;
        this.gameTurnEndedAt = now;
      }
      // 插进她这一轮的话：叫醒在等的 game_continue（有游戏线时只有游戏线在等），不然要等游戏里下一件事才看得到
      else for (const wake of [...this.attentionWaiters]) wake();
    } finally {
      this.gamePushing = false;
    }
  }

  // ── 导演：她空下来就推下一件事 ─────────────────────

  private async direct(): Promise<void> {
    if (this.onAir && Date.now() - this.persistedAt > PERSIST_EVERY_MS) this.persistLive();
    if (!this.onAir || !this.brainSession) return;
    const now = Date.now();
    // 在玩游戏（舞台上有画面，或者游戏线还在玩、摄像机没开或挂了）：欢迎攒着说，一次弹幕多带几位
    const gameOn = this.gameOn;
    // 控制台改的节奏马上生效：每一拍都按现在的设置来
    if (this.options.pace) this.attention.owner = this.options.pace();
    if (this.options.idleAfterMs) this.attention.idleAfterMs = this.options.idleAfterMs();
    this.attention.welcomeGapMs = gameOn ? GAME_WELCOME_GAP_MS : 0;
    this.attention.minChatPicks = gameOn ? GAME_CHAT_PICKS : 0;
    if (this.gameSession) void this.directGameLine(now);
    this.maybeRemindPlug(now);
    this.maybePromptReading(now);
    // 串门到点自己结束：撤掉画面、接着放队列（外面的定时器丢了也不怕）
    if (this.visitExpired(now)) {
      this.options.stopVisit?.();
      this.endVisit();
    }
    this.publishRegulars(now);
    void this.maybeAutoPlay(now);
    if (this.pushing) return;
    // 她在玩游戏、这一轮还没完（在 game_continue 里等、在做事）：直播间的事照样推给她，插进她这一轮的下一步
    // （有游戏线时游戏在另一个会话里，直播线照平常一件一件来）
    if (this.turnRunning && this.game && !this.gameSession) return this.directGame(now);
    // 道别要等两条线的话都念完：游戏线刚说的（常常就是收尾的话）要写进道别里，她才不会再说一遍
    if (this.queued - (this.ending && !this.endingPushed ? 0 : this.queuedGame) > 0) return;
    if (this.turnRunning) {
      if (now - this.turnSince < TURN_MAX_MS) return;
      this.hooks.log?.('warn', `她这一轮超过 ${TURN_MAX_MS / 1000} 秒还没结束，接着往下推`);
      this.turnRunning = false;
    }
    // 道别说完了：收工
    if (this.endingPushed) return this.finish();
    const topic = this.gameOn ? (this.gameSession ? this.takeLive(now) : this.takeInGame(now)) : this.take(now);
    if (!topic) return;
    await this.deliver(topic, now);
  }

  /** 她在玩游戏、一轮没完：有弹幕、礼物、主人说话就推给她（隔开一点），推了就叫醒在等的 game_continue */
  private async directGame(now: number): Promise<void> {
    if (now - this.gamePushedAt < (this.options.gameChatGapMs?.() ?? GAME_PUSH_GAP_MS)) return;
    // 嘴跟不上：她写好的话还排着好几句没念，先不推新的，弹幕攒着等她说完一起给（不然观众听到的回应越来越晚）
    if (this.queued >= GAME_MOUTH_BACKLOG) return;
    const topic = this.takeLive(now);
    if (!topic) return;
    if (!(await this.deliver(topic, now, true))) return;
    this.gamePushedAt = Date.now();
    for (const wake of [...this.attentionWaiters]) wake();
  }

  /** 直播间里真的有事：主人的话、开场、谢幕，和注意力层挑的弹幕、礼物（不含「没人说话，自己找话说」） */
  private takeLive(now: number): Topic | null {
    const body = this.priority.shift();
    if (body) return { ...body, id: `p-${now}`, priority: 200, heat: this.attention.heat(now), createdAt: now };
    const topic = this.attention.next(now);
    return topic && topic.kind !== 'idle' ? topic : null;
  }

  /** 在玩游戏、这一轮停下了：直播间有事先回；没事、又安静了一会儿，叫她接着玩（不另找话题、不推视频和收件箱） */
  private takeInGame(now: number): Topic | null {
    const topic = this.takeLive(now);
    if (topic) return topic;
    if (now - this.turnEndedAt < GAME_WAKE_MS || this.attention.silentMs(now) < GAME_WAKE_MS) return null;
    return { kind: 'game', id: `g-${now}`, priority: 1, heat: this.attention.heat(now), createdAt: now };
  }

  /** 隔一会儿把常客榜推给舞台（好感度最高的几位） */
  private publishRegulars(now: number): void {
    if (!this.onAir) return;
    if (this.regularsAt && now - this.regularsAt < 60_000) return;
    this.regularsAt = now;
    try {
      const items = this.memory.regulars(5);
      this.stage.broadcast({ type: 'regulars', items, at: now });
    } catch {
      // 记忆库读失败不影响直播
    }
  }

  /** 隔一段时间顺口提醒一次点赞/关注：放进收件箱，等她不忙时自然地说，不打断正在回的人 */
  private maybeRemindPlug(now: number): void {
    const every = this.options.plugEverySec?.() ?? 600;
    if (!every || every <= 0 || this.ending) return;
    if (!this.lastPlugAt) {
      this.lastPlugAt = now;
      return;
    }
    if (now - this.lastPlugAt < every * 1000) return;
    this.lastPlugAt = now;
    const minutes = Math.max(1, Math.round((now - this.liveSince) / 60000));
    this.inbox.push(`开播已经 ${minutes} 分钟了：顺口提醒大家点点赞、点点关注、转发一下直播间（一句话，自然点，不要像念广告；这轮别反复提）。`);
  }

  /** 没人点播、舞台空着：自动放合集里的视频（观众点播会打断它） */
  /** 读书会：她停下来十几秒，就提醒她接着读下一段（不然念完一段就干等） */
  private maybePromptReading(now: number): void {
    if (!this.reading || !this.onAir || this.ending) return;
    const last = this.lines[this.lines.length - 1]?.at ?? 0;
    if (now - last < 12_000) return;
    if (now - this.readPromptAt < 20_000) return;
    this.readPromptAt = now;
    this.inbox.push('读书会还在继续：用 book_read 读下一段（1 段就好），念完停下来跟大家聊两句；没人说话就顺着往下读。');
  }

  private async maybeAutoPlay(now: number): Promise<void> {    if (!this.options.autoNext || this.ending || this.pushing || this.autoBusy) return;
    if (this.player.current || this.videoQueue.length || this.songQueue.length || this.watch) return;
    if (now - this.autoTriedAt < 6000) return;
    this.autoBusy = true;
    this.autoTriedAt = now;
    try {
      const request = await this.options.autoNext();
      // 正在串门：轮播先别开，等串门结束（不然一开场就把串门画面顶掉）
      if (!request || this.ending || this.player.current || this.videoQueue.length || this.visiting) return;
      this.playingWho = '';
      this.playVideo(request, undefined, undefined, undefined);
      this.publishQueue();
    } catch {
      // 自动播放失败就下次再来，不影响直播
    } finally {
      this.autoBusy = false;
    }
  }

  /** 把一件事推进她的会话；推成了返回 true */
  private async deliver(topic: Topic, now: number, midTurn = false): Promise<boolean> {
    this.seq += 1;
    const focus = focusOf(topic);
    if (focus.length) this.stage.broadcast({ type: 'focus', userIds: focus });
    // to：这一轮她回应的观众（uid）；接下来的 say 就是她这一轮说的
    this.record({ type: 'topic', seq: this.seq, kind: topic.kind, ...(focus.length ? { to: focus } : {}) });
    this.lastTopic = topic;
    const d = new Date(now);
    const text = topicText(topic, {
      viewerCard: (u: LiveUser) => this.memory.viewerCard(u, now),
      lastRecap: topic.kind === 'opening' && this.memoryStream ? this.memory.lastRecap() : undefined,
      today: topic.kind === 'opening' || topic.kind === 'ending' ? whenNow(d) : undefined,
      justSaid: topic.kind === 'ending' ? this.lines.filter((l) => now - l.at < JUST_SAID_MS).slice(-JUST_SAID_LINES).map((l) => l.text) : undefined,
      board: topic.kind === 'opening' ? this.options.board?.() : undefined,
      title: topic.kind === 'opening' ? this.options.title?.() : undefined,
      inGame: this.gameOn,
      gameNow: !this.gameSession ? undefined
        : this.resumingGame && !this.gameOn ? GAME_RESTARTING
        : this.gameOn ? `${this.gameNow ? `（${Math.max(1, Math.round((now - this.gameMomentAt) / 1000))} 秒前）${this.gameNow}` : '刚开，还没有消息'}` : undefined,
      gameOff: !!this.gameSession && !this.gameOn && !this.resumingGame && topic.kind === 'owner',
      orders: this.gameSession ? this.orders.summary() || undefined : undefined,
    });
    this.pushing = true;
    this.setBrain('thinking', topicLabel(topic));
    try {
      const style = this.options.styleLine?.();
      const outgoing = style ? `${style}\n\n${text}` : text;
      const ok = await this.hooks.push(this.brainSession!, outgoing, midTurn);
      if (!ok) {
        // 她的会话不在线（DSH 重启过、会话被关了）：要紧的事放回去，等控制台重新开播
        if (topic.kind === 'opening' || topic.kind === 'ending' || topic.kind === 'owner') this.priority.unshift(topic);
        this.setBrain('away', '她的会话不在线');
        return false;
      }
      this.turnRunning = true;
      this.turnSince = Date.now();
      if (topic.kind === 'ending') this.endingPushed = true;
      return true;
    } finally {
      this.pushing = false;
    }
  }

  /** 她的会话开始了一轮（身体推的，或者主人在会话里直接说话） */
  turnStarted(sessionId: string): void {
    if (sessionId === this.gameSession && sessionId !== this.brainSession) {
      this.gameTurnRunning = true;
      return;
    }
    if (sessionId !== this.brainSession) return;
    this.turnRunning = true;
    this.turnSince = Date.now();
  }

  /** 她这一轮结束了：话念完以后导演再推下一件 */
  turnEnded(sessionId: string): void {
    if (sessionId === this.gameSession && sessionId !== this.brainSession) {
      this.gameTurnRunning = false;
      this.gameTurnEndedAt = Date.now();
      return;
    }
    if (sessionId !== this.brainSession) return;
    this.turnRunning = false;
    this.turnEndedAt = Date.now();
    if (this.onAir && this.speaking === 0) this.setBrain('listening');
  }

  private take(now: number): Topic | null {
    const body = this.priority.shift();
    if (body) return { ...body, id: `p-${now}`, priority: 200, heat: this.attention.heat(now), createdAt: now };
    const topic = this.attention.next(now);
    // 弹幕、礼物这些照常先回；没别的事时，先说收件箱，再说在放的视频（不用她找话说）
    if (topic && topic.kind !== 'idle') return topic;
    if (this.inbox.length) {
      const lines = this.inbox.splice(0, 5);
      return { kind: 'inbox', lines, id: `i-${now}`, priority: 2, heat: this.attention.heat(now), createdAt: now };
    }
    if (this.player.current) return this.watching(now);
    return topic;
  }

  /** 边看边聊：她安静一会儿了，视频又往下放了一段，这段有人说话或者原视频有弹幕，就告诉她 */
  private watching(now: number): Topic | null {
    const video = this.player.current;
    const watch = this.watch;
    const at = this.player.position(now);
    if (!video || !watch || watch.id !== video.id || at === null) return null;
    if (this.attention.silentMs(now) < WATCH_GAP_MS || now - watch.toldAt < WATCH_GAP_MS) return null;
    const from = Math.max(watch.seenSec, at - WATCH_WINDOW_SEC);
    if (at - from < WATCH_MIN_SEC) return null;
    const moment = watch.notes.between(from, at);
    watch.seenSec = at;
    watch.toldAt = now;
    if (!moment.lines.length && !moment.danmaku.length) return null;
    return {
      kind: 'watching', title: video.title, fromSec: from, toSec: at,
      lines: moment.lines.map((l) => ({ from: l.from, text: l.text })),
      source: moment.kind, ...(moment.engine ? { engine: moment.engine } : {}),
      danmaku: moment.danmaku.map((d) => d.text),
      id: `w-${now}`, priority: 1, heat: this.attention.heat(now), createdAt: now,
    };
  }

  /** 正在放的视频不放了（how：ended 放完、error 放不出来、stopped 她让停的、replaced 换别的了、off 下播） */
  private endWatch(how: string, playedSec?: number): void {
    this.watch?.notes.stop();
    this.watch = null;
    const playing = this.playing;
    this.playing = null;
    if (!playing) return;
    const video = this.player.current;
    const played = playedSec ?? (video && video.id === playing.id ? (this.player.position() ?? video.fromSec) - video.fromSec : 0);
    try {
      playing.done({ how, playedSec: Math.round(played), said: this.herLines.slice(playing.saidFrom) });
    } catch (err) {
      this.hooks.log?.('warn', `视频放完的记录出错：${(err as Error).message}`);
    }
  }

  /** 念她写的话：合成语音、交给舞台、等念完 */
  async say(raw: string, mood: string, signal: AbortSignal, line: 'live' | 'game' = 'live'): Promise<string> {
    const text = speakable(raw);
    if (!text) return '';
    // 嘴两条线共用、按先后念：游戏线的话一句不丢（死了、危险、拿到装备都在这里说）；直播线推下一件事时不等游戏线的话
    const game = line === 'game';
    this.queued += 1;
    if (game) this.queuedGame += 1;
    return this.stage.withMic(async () => {
      this.speaking += 1;
      this.attention.speechStarted();
      this.setBrain('speaking');
      const start = Date.now();
      try {
        let speech: { audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null = null;
        // 合成一段平时不到 2 秒：一次最多等 SYNTH_TIMEOUT_MS，卡住了马上再试一次（实测豆包偶尔一个请求一直不回，等满两分钟直播就冷场了）
        for (let attempt = 1; attempt <= 2 && !speech && !signal.aborted; attempt++) {
          try {
            speech = await this.hooks.synthesize(text, AbortSignal.any([signal, AbortSignal.timeout(SYNTH_TIMEOUT_MS)]));
          } catch (err) {
            this.hooks.log?.('warn', `语音合成失败（第 ${attempt} 次）：${(err as Error).message}`);
          }
        }
        const id = randomUUID();
        const estimateMs = estimateSpeechMs(text);
        const done = this.stage.waitSaid(id, estimateMs, signal);
        this.stage.broadcast({
          type: 'say', id, text, mood, estimateMs,
          audio: speech ? Buffer.from(speech.audio).toString('base64') : null,
          ...(speech?.timeline.length ? { timeline: speech.timeline } : {}),
        });
        await done;
      } finally {
        this.speaking -= 1;
        this.queued -= 1;
        if (game) this.queuedGame -= 1;
        this.attention.speechEnded(Date.now());
        this.lines = [...this.lines, { text, mood, at: start }].slice(-RECENT_LINES);
        this.herLines.push(text);
        this.spoken += [...text].length;
        this.record({ type: 'say', text, mood, start, end: Date.now(), ...(game ? { line: 'game' } : {}) });
        this.setBrain(!this.onAir ? 'off' : this.turnRunning ? 'thinking' : 'listening');
      }
      return text;
    }, game ? 1 : 0);
  }

  /**
   * 嘉宾（主人那边的人，比如 Claude 小姐）在直播间开口：用自己的音色念出来，字幕上写嘉宾的名字，和她共用一个麦（不抢话）；
   * 念完把这句交给她（像主人的话一样排在最前），她来回。观众和她都听得到
   */
  async guestSay(who: string, raw: string, voice: string, signal: AbortSignal): Promise<string> {
    const text = speakable(raw);
    if (!text || !this.onAir) return '';
    this.queued += 1;
    try {
      await this.stage.withMic(async () => {
        const start = Date.now();
        let speech: Awaited<ReturnType<ShowHooks['synthesize']>> = null;
        for (let attempt = 1; attempt <= 2 && !speech && !signal.aborted; attempt++) {
          speech = await this.hooks.synthesize(text, AbortSignal.any([signal, AbortSignal.timeout(SYNTH_TIMEOUT_MS)]), voice).catch((err) => {
            this.hooks.log?.('warn', `嘉宾的语音合成失败（第 ${attempt} 次）：${(err as Error).message}`);
            return null;
          });
        }
        const id = randomUUID();
        const estimateMs = estimateSpeechMs(text);
        const done = this.stage.waitSaid(id, estimateMs, signal);
        this.stage.broadcast({
          type: 'say', id, text, mood: '', estimateMs, speaker: who,
          audio: speech ? Buffer.from(speech.audio).toString('base64') : null,
          ...(speech?.timeline.length ? { timeline: speech.timeline } : {}),
        });
        await done;
        this.record({ type: 'guest', who, text, start, end: Date.now() });
      });
    } finally {
      this.queued -= 1;
    }
    this.ownerSay(raw, who);
    return text;
  }

  get currentSession(): string | null {
    return this.brainSession;
  }

  // ── 她的工具用到的 ──────────────────────────────────

  /** 按她看到的名字（或 UID）在这场直播最近的事件里找观众；找不到、对不上好几位时带着候选（见 core/viewerLookup） */
  lookupViewer(who: string): ViewerLookup {
    return lookupViewer(who, this.hub.recentEvents(), { simulatedPrefix: SIMULATED_PREFIX });
  }

  /** 这个观众的粉丝团等级（本房间的牌子；没有就是 0） */
  medalLevel(who: string): number {
    const hit = this.lookupViewer(who);
    if (hit.kind !== 'found') return 0;
    const medal = hit.user.medal;
    return medal?.ofThisRoom ? medal.level : 0;
  }

  /** 查点播队列：某人排第几，或者整条队列长什么样 */
  queueStatus(by = ''): string {
    const cur = this.player.current;
    const lines: string[] = [];
    if (cur) lines.push(`正在放：${cur.title}（${this.playingWho || '自动播放'}）`);
    this.videoQueue.forEach((item, i) => lines.push(`第 ${i + 1} 位：${item.request.title}（${item.who}）`));
    const name = by.trim();
    if (!name) return lines.length ? lines.join('\n') : '点播队列是空的。';
    const mine = this.videoQueue.map((item, i) => ({ item, i })).filter(({ item }) => item.who.includes(name) || name.includes(item.who));
    if (!mine.length) {
      const playingMine = cur && (this.playingWho.includes(name) || name.includes(this.playingWho));
      return playingMine ? `${name} 的点播正在放：${cur!.title}` : `${name} 现在没有排着的点播（可能还没点，或者已经放完了）。`;
    }
    return mine.map(({ i, item }) => `${name} 的「${item.request.title}」排在第 ${i + 1} 位（前面还有 ${i} 个）`).join('\n');
  }

  /** 把某人排在队列里的点播挪到下一个（观众同意优先播放时用）；返回挪动的视频标题 */
  promoteQueued(who: string): string | null {
    const name = who.trim();
    if (!name) return null;
    const index = this.videoQueue.findIndex((item) => item.who.includes(name) || name.includes(item.who));
    if (index < 0) return null;
    const [item] = this.videoQueue.splice(index, 1);
    this.videoQueue.unshift(item);
    this.publishQueue();
    return item.request.title;
  }

  /** 她私信了一位观众：记进这场的记录（复盘、剪视频用） */
  noteDm(to: string, text: string): void {
    this.record({ type: 'dm', to, text });
  }

  /** 她用开播账号发了评论：记进这场的记录 */
  noteComment(text: string, where: string): void {
    this.record({ type: 'comment', where, text });
  }

  /** 直播间最近的弹幕（旧 → 新）：视频库记「点视频之前在聊什么」 */
  recentChat(limit = 10, withinMs = 5 * 60_000, now = Date.now()): Array<{ name: string; uid: string; text: string; at: number }> {
    return this.hub.recentEvents()
      .filter((e): e is Extract<typeof e, { kind: 'chat' }> => e.kind === 'chat' && now - e.ts <= withinMs)
      .slice(-limit)
      .map((e) => ({ name: e.user.name, uid: e.user.id, text: e.text, at: e.ts }));
  }

  /** 这一场真的推流到直播间了：记忆里算一场（彩排不算「上一场」） */
  markBroadcast(): void {
    if (this.memoryStream) this.memory.markBroadcast();
  }

  /** 这场直播的记录文件名（没在播为 null） */
  get logName(): string | null {
    return this.logFile ? basename(this.logFile) : null;
  }

  /** 她用开播账号发了动态：记进这场的记录 */
  noteDynamic(text: string): void {
    this.record({ type: 'dynamic', text });
  }

  /** 这位观众认不认识：这场里出现过，或者观众记忆里有他（私信只发给认识的人） */
  knowsViewer(uid: string): boolean {
    return this.hub.recentEvents().some((e) => e.user.id === uid) || !!this.memory.store.getViewer('bilibili', uid);
  }

  /** 这位观众说过「忘了我」：不看、不记 */
  optedOut(uid: string): boolean {
    return this.memory.store.isOptedOut('bilibili', uid);
  }

  /** 主人拉黑了这位观众：不欢迎、不回、不记、不看主页、不私信 */
  isBlocked(uid: string): boolean {
    return !!uid && !!this.options.blocked?.(uid);
  }

  /** 她看了这位观众的主页：自己的直播间里记一句，下次见到他卡片里会提 */
  rememberProfile(uid: string, summary: string): void {
    if (this.memoryStream && this.memory.store.getViewer('bilibili', uid)) this.memory.store.setAppraisal('bilibili', uid, { summary, at: Date.now() });
  }

  /** 停下正在放的视频（她让停的、下播），不再听写后面的；不是下播就接着放排队里的 */
  stopVideo(how = 'stopped') {
    this.endWatch(how);
    const stopped = this.player.stop();
    if (how !== 'off') this.nextInQueue();
    return stopped;
  }

  /**
   * 在舞台上放一个视频（换掉正在放的）；记进这场的记录。notes：这段视频里有什么（边看边聊用）；
   * done：不放了的时候（放完、停下、换掉、下播）告诉调用的人放了多久、这期间她说了什么
   */
  playVideo(request: PlayRequest, notes?: VideoNotes, done?: (end: VideoEnd) => void, id?: string) {
    // 串门和点播只能有一个：要放视频了，先把串门画面撤掉
    if (this.visiting) {
      this.visiting = false;
      this.options.stopVisit?.();
    }
    const replaced = this.player.current;
    this.endWatch('replaced');
    const video = this.player.play(request, id);
    if (notes) this.watch = { id: video.id, notes, seenSec: request.fromSec, toldAt: Date.now() };
    if (done) this.playing = { id: video.id, saidFrom: this.herLines.length, done };
    this.record({ type: 'play', bvid: request.bvid, title: request.title, from: request.fromSec, until: request.untilSec });
    return { video, replaced };
  }

  /**
   * 点播：正在放东西时先排队（不打断），放完自动接下一个；没人放就现在放。
   * who：谁点的（舞台上排队栏显示）
   */
  queueVideo(request: PlayRequest, notes: VideoNotes | undefined, done: ((end: VideoEnd) => void) | undefined, who: string, jump = false) {
    // 长视频（>20 分钟）看粉丝团等级：10 级以上才给点
    if (request.durationSec && request.durationSec > MAX_VIDEO_SEC) {
      const level = this.medalLevel(who);
      if (level <= LONG_VIDEO_FAN_LEVEL) {
        throw new Error(
          `超过 20 分钟的视频要粉丝团 ${LONG_VIDEO_FAN_LEVEL} 级以上才能点哦（${who} 现在${level ? `是粉丝牌 ${level} 级` : '还没有粉丝牌'}）。`,
        );
      }
    }
    // 有人点播时优先：正在放合集自动视频的话，直接打断换成人点的
    if (!request.auto) this.lastRequestAt = Date.now();
    if (!request.auto && this.player.current?.auto) {
      this.stopVideo('replaced');
    }
    // 正在串门：点播先排队，等串门结束再放（串门期间不抢舞台）
    if (this.visiting) {
      const item = { id: `q${++this.queueSeq}`, request, notes, done, who };
      if (jump) this.videoQueue.unshift(item);
      else this.videoQueue.push(item);
      this.publishQueue();
      return { queued: true as const, position: this.videoQueue.indexOf(item) + 1, title: request.title };
    }
    if (this.player.current) {
      const item = { id: `q${++this.queueSeq}`, request, notes, done, who };
      // 插队：放到最前面（下一个就放它）；否则排到队尾
      if (jump) this.videoQueue.unshift(item);
      else this.videoQueue.push(item);
      this.publishQueue();
      return { queued: true as const, position: this.videoQueue.indexOf(item) + 1, title: request.title };
    }
    this.playingWho = who;
    const played = this.playVideo(request, notes, done);
    this.publishQueue();
    return { queued: false as const, video: played.video, replaced: played.replaced, title: request.title };
  }

  /** 现在排着几个点播 */
  get queueLength(): number {
    return this.videoQueue.length + this.songQueue.length;
  }

  /** 点歌：正在放东西时先排着，放完接着唱；没人放就现在唱。who：谁点的（舞台上排队栏显示） */
  queueSong(request: PlayRequest, who: string, jump = false) {
    this.lastRequestAt = Date.now();
    // 同一首已经在唱/已经排着：不重复排（弹幕自动点和她说点歌可能同时来）
    if (this.player.current?.bvid === request.bvid) {
      return { queued: false as const, video: this.player.current, replaced: null, title: request.title };
    }
    const queuedAt = this.songQueue.findIndex((q) => q.request.bvid === request.bvid);
    if (queuedAt >= 0) {
      return { queued: true as const, position: queuedAt + 1, title: request.title };
    }
    if (this.player.current?.auto) this.stopVideo('replaced');
    // 正在串门：点歌先排着，等串门结束再唱
    if (this.visiting) {
      const item = { id: `q${++this.queueSeq}`, request, who };
      if (jump) this.songQueue.unshift(item);
      else this.songQueue.push(item);
      this.publishQueue();
      return { queued: true as const, position: this.songQueue.indexOf(item) + 1, title: request.title };
    }
    if (this.player.current) {
      const item = { id: `q${++this.queueSeq}`, request, who };
      if (jump) this.songQueue.unshift(item);
      else this.songQueue.push(item);
      this.publishQueue();
      return { queued: true as const, position: this.songQueue.indexOf(item) + 1, title: request.title };
    }
    this.playingWho = who;
    const played = this.playVideo(request);
    this.publishQueue();
    return { queued: false as const, video: played.video, replaced: played.replaced, title: request.title };
  }

  /** 最近一次观众点播的时间（毫秒） */
  get lastViewerRequestAt(): number {
    return this.lastRequestAt;
  }

  /** 清空点播排队；返回清掉几个 */
  clearQueue(): number {
    const n = this.videoQueue.length;
    this.videoQueue = [];
    this.songQueue = [];
    this.publishQueue();
    return n;
  }

  /** 一个放完了：接排队里的下一个（点播和点歌按排队先后），并告诉她（她好接着说） */
  private nextInQueue(): void {
    // 正在串门：队列先停着，等串门结束再接着放
    if (this.visiting) return;
    const seq = (id: string) => Number(id.replace(/\D/g, '')) || 0;
    const video = this.videoQueue[0];
    const song = this.songQueue[0];
    const takeVideo = !!video && (!song || seq(video.id) < seq(song.id));
    if (!this.onAir || this.ending || (!video && !song)) {
      this.publishQueue();
      return;
    }
    if (takeVideo && video) {
      this.videoQueue.shift();
      this.playingWho = video.who;
      this.playVideo(video.request, video.notes, video.done, video.id);
      this.note('点播', `排队的「${video.request.title}」开始放了（${video.who} 点的）`);
      this.notifyInbox([`排队里的「${video.request.title}」开始放了（${video.who} 点的）。放完会告诉你。`]);
    } else if (song) {
      this.songQueue.shift();
      this.playingWho = song.who;
      this.playVideo(song.request, undefined, undefined, song.id);
      this.note('点歌', `排队的「${song.request.title}」开始唱了（${song.who} 点的）`);
      this.notifyInbox([`排队里的「${song.request.title}」开始唱了（${song.who} 点的）。唱完会告诉你。`]);
    }
    this.publishQueue();
  }

  /** 舞台上显示排队：正在放的 + 点播和点歌按先后排的；顺便让舞台预加载下一条视频 */
  private publishQueue(): void {
    const current = this.player.current;
    const seq = (id: string) => Number(id.replace(/\D/g, '')) || 0;
    const rest = [
      ...this.videoQueue.map((q) => ({ id: q.id, who: q.who, title: q.request.title, kind: 'video' as const })),
      ...this.songQueue.map((q) => ({ id: q.id, who: q.who, title: q.request.title, kind: 'song' as const })),
    ].sort((a, b) => seq(a.id) - seq(b.id));
    const items = [
      ...(current ? [{ id: current.id, who: this.playingWho, title: current.title, playing: true, kind: current.kind === 'audio' ? ('song' as const) : ('video' as const) }] : []),
      ...rest,
    ];
    this.stage.broadcast({ type: 'queue', items });
    const next = current ? this.videoQueue[0] : undefined;
    // 已经缓存到本地的不需要预加载（舞台直接读本地文件）
    if (next?.request.src) this.player.prefetch(null, null);
    else this.player.prefetch(next?.id ?? null, next?.request.url ?? null);
  }

  /**
   * 她调用了一个工具：舞台终端里记一行（观众看得出画面上的视频、私信是她自己动手做的），
   * doing 写在提示符上（她正在干什么）
   */
  toolCall(name: string, detail: string, doing?: string): void {
    if (!this.onAir) return;
    this.brain = 'thinking';
    this.stage.broadcast({ type: 'tool', name, detail, doing });
  }

  /** 开播账号收到了新东西：没别的事要回时告诉她 */
  notifyInbox(lines: string[]): void {
    if (this.onAir && !this.ending) this.inbox.push(...lines);
  }

  /** 终端里记一行身体自己在做的事（后台听写视频之类）：不是她调的工具，不改她的状态 */
  note(tag: string, text: string): void {
    if (this.onAir) this.stage.broadcast({ type: 'note', tag, text });
  }

  /**
   * 她在直播里玩的游戏的画面上舞台、撤下（dsh-game 经 liveBody.showGame 给；null：这局结束了）。
   * 在玩的时候导演换一套做法：直播间的事照推，不另找话题（见 docs/game-live-contract.md）
   */
  showGame(source: GameSource | null): void {
    if (JSON.stringify(source) === JSON.stringify(this.game)) return;
    this.game = source;
    this.gamePushedAt = 0;
    this.stage.broadcast({ type: 'game', source });
    if (!source && this.gameStatus) {
      this.gameStatus = null;
      this.stage.broadcast({ type: 'gameStatus', status: null });
    }
    this.record({ type: 'game', source });
    this.persistLive();
    this.hooks.onGame?.(source);
  }

  get gameSource(): GameSource | null {
    return this.game;
  }

  /** 直播间有事推给她时 resolve（liveBody.attention：game_continue 和游戏自己的等待一起 race）；signal 取消就不管了 */
  waitAttention(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return;
      const wake = () => {
        this.attentionWaiters.delete(wake);
        signal.removeEventListener('abort', drop);
        resolve();
      };
      const drop = () => this.attentionWaiters.delete(wake);
      this.attentionWaiters.add(wake);
      signal.addEventListener('abort', drop, { once: true });
    });
  }

  get isOnAir(): boolean {
    return this.onAir;
  }

  private setBrain(state: BrainState, detail?: string): void {
    if (this.brain === state && !detail) return;
    this.brain = state;
    this.stage.broadcast({ type: 'brain', state, detail });
  }

  status(): ShowStatus {
    const now = Date.now();
    const snap = this.attention.snapshot(now);
    return {
      live: this.hub.status(now),
      onAir: this.onAir,
      brain: this.brain,
      brainSession: this.brainSession,
      heat: snap.heat,
      audience: snap.audience,
      pending: snap.pending,
      lines: this.lines,
      stageWatchers: this.stage.watchers,
      roomId: this.roomId,
    };
  }

  // ── 记录（剪视频、复盘用） ─────────────────────────

  private openLog(): void {
    const dir = join(this.options.dataDir, 'shows');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = join(dir, `${stamp}.jsonl`);
    this.record({ type: 'begin', roomId: this.roomId });
  }

  private record(entry: Record<string, unknown>): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
    } catch {
      // 记录写不进去不影响直播
    }
  }

  /** 插件停了（多半是 DSH 重启、更新）：在播的这一场不收尾，存好，起来以后接着播 */
  dispose(): void {
    if (this.onAir && !this.ending) {
      this.persistLive();
      this.record({ type: 'suspend' });
      this.player.stop();
    } else {
      this.finish();
    }
    if (this.director) clearInterval(this.director);
    this.director = null;
    this.disconnect();
  }
}

/** 没有音频时按字数估朗读时长 */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, [...text].length * 230);
}


const KIND_LABEL: Record<Topic['kind'], string> = {
  chat: '在看弹幕', superchat: '在看醒目留言', thanks: '在谢礼物', gifts: '在谢礼物', trend: '在看大家刷屏',
  welcome: '在欢迎新观众', follow: '在谢关注', idle: '在找话说', opening: '在准备开场', ending: '在准备道别', owner: '在听主人说话',
  video: '视频放完了', watching: '在看视频', inbox: '在看私信和评论', resumed: '在接着播', game: '在玩游戏',
};

function topicLabel(topic: Topic): string {
  return KIND_LABEL[topic.kind];
}

/** 她这次要回应的观众（舞台上高亮） */
function focusOf(topic: Topic): string[] {
  const ids = (users: LiveUser[]) => users.map((u) => u.id || u.name);
  switch (topic.kind) {
    case 'chat': return ids(topic.picks.map((p) => p.event.user));
    case 'superchat': return ids([topic.event.user]);
    case 'thanks': case 'gifts': return ids(topic.events.map((e) => e.user));
    case 'welcome': case 'follow': return ids(topic.users);
    default: return [];
  }
}

function stageUser(user: LiveUser): StageUser {
  return {
    id: user.id || user.name,
    name: cleanName(user.name),
    ...(user.face ? { face: user.face } : {}),
    ...(user.guardLevel ? { guard: user.guardLevel } : {}),
    ...(user.medal?.ofThisRoom ? { medal: { name: cleanName(user.medal.name), level: user.medal.level } } : {}),
    ...(user.isAdmin ? { admin: true } : {}),
  };
}

/** 直播事件 → 舞台显示用（清洗过的名字和文字；点赞不上舞台） */
function toStage(event: LiveEvent): StageLiveEvent | null {
  const user = stageUser(event.user);
  switch (event.kind) {
    case 'chat': return { kind: 'chat', id: event.id, user, text: cleanText(event.text), ...(event.stickerUrl ? { sticker: event.stickerUrl } : {}) };
    case 'gift': return { kind: 'gift', id: event.id, user, gift: cleanName(event.giftName), count: event.count, yuan: event.valueYuan };
    case 'superchat': return { kind: 'superchat', id: event.id, user, text: cleanText(event.text), yuan: event.valueYuan };
    case 'membership': return { kind: 'membership', id: event.id, user, level: cleanName(event.levelName), count: event.count };
    case 'enter': case 'follow': return { kind: event.kind, id: event.id, user };
    default: return null;
  }
}
