import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  splitByMood,
  whoIs
} from "./chunks/chunk-4A2ZZR7B.js";
import {
  defineTool
} from "./chunks/chunk-3TTXC623.js";
import {
  BiliRoom,
  COMMENT_GAP_MS,
  FAVORITE_FOLDER,
  MAX_COMMENT_CHARS,
  asr,
  clock,
  cookie,
  currentMoods,
  dataDir,
  dm,
  fetchProfile,
  giftBoard,
  hooks,
  infoText,
  lastRoomError,
  library,
  listBooks,
  listSongs,
  loadBook,
  lookupProblem,
  markAgentReady,
  matchSong,
  orderTags,
  profileSummary,
  profileText,
  saveBook,
  screenshot,
  searchText,
  settings,
  show,
  social,
  songRequest,
  subtitleText,
  videos,
  watchRoom
} from "./chunks/chunk-TDP4TOGQ.js";

// src/dsh/agent.ts
import { join as join2 } from "node:path";

// src/body/mediaCache.ts
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var MAX_BYTES_PER_SEC = Math.max(2e5, Number(process.env.DSH_MEDIA_BPS) || 125e4);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cacheVideo(dir, bvid, url) {
  const file = join(dir, `${bvid}.mp4`);
  if (existsSync(file) && statSync(file).size > 1024) return file;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.part`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
      signal: AbortSignal.timeout(18e4)
    });
    if (!res.ok || !res.body) return null;
    const total = Number(res.headers.get("content-length") ?? 0);
    const out = createWriteStream(tmp);
    const reader = res.body.getReader();
    const started = Date.now();
    let bytes = 0;
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
        const shouldTake = bytes / MAX_BYTES_PER_SEC * 1e3;
        const waited = Date.now() - started;
        if (shouldTake > waited) await sleep(Math.min(200, shouldTake - waited));
      }
    } finally {
      await new Promise((r) => out.end(() => r()));
    }
    if (!existsSync(tmp) || statSync(tmp).size < 1024) {
      if (existsSync(tmp)) unlinkSync(tmp);
      return null;
    }
    if (total > 0 && Math.abs(statSync(tmp).size - total) > Math.max(2048, total * 5e-3)) {
      unlinkSync(tmp);
      return null;
    }
    renameSync(tmp, file);
    return file;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
    }
    return null;
  }
}
function pruneVideos(dir, keep = 20) {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".mp4")).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const old of files.slice(keep)) unlinkSync(join(dir, old.f));
  } catch {
  }
}

// src/dsh/agent.ts
import { randomUUID } from "node:crypto";

// src/body/watchAlong.ts
var DANMAKU_MAX = 12;
var VideoNotes = class {
  constructor(fromSec, untilSec, source, log) {
    this.fromSec = fromSec;
    this.untilSec = untilSec;
    void source.danmaku().then((list) => {
      this.comments = list;
    }, () => {
    });
    void this.load(source).catch((err) => log?.(`\u8FB9\u770B\u8FB9\u804A\uFF1A\u5B57\u5E55\u6CA1\u62FF\u5230\uFF08${err.message}\uFF09`));
  }
  fromSec;
  untilSec;
  lines = [];
  kind = null;
  engine;
  comments = [];
  stopped = false;
  async load(source) {
    const sub = await source.subtitles();
    if (sub) return this.take(sub);
    let at = this.fromSec;
    while (!this.stopped && at < this.untilSec) {
      const heard = await source.listen(at);
      if (!heard || this.stopped) return;
      this.take(heard);
      if (heard.until === void 0 || heard.until <= at) return;
      at = heard.until;
    }
  }
  take(sub) {
    this.kind = sub.kind;
    this.engine = sub.engine;
    this.lines = [...this.lines, ...sub.lines].sort((a, b) => a.from - b.from);
  }
  /** from–to 秒这段：说的话和原视频弹幕（弹幕太多时均匀挑几条，重复的只留一条） */
  between(fromSec, toSec) {
    const lines = this.lines.filter((l) => l.to > fromSec && l.from < toSec);
    const seen = /* @__PURE__ */ new Set();
    const inRange = this.comments.filter((d) => d.at >= fromSec && d.at < toSec && !seen.has(d.text) && seen.add(d.text));
    const step = inRange.length / DANMAKU_MAX;
    const danmaku = step > 1 ? Array.from({ length: DANMAKU_MAX }, (_, i) => inRange[Math.floor(i * step)]) : inRange;
    return { lines, kind: this.kind, ...this.engine ? { engine: this.engine } : {}, danmaku };
  }
  /** 不放了：后面的不再听 */
  stop() {
    this.stopped = true;
  }
};

// src/core/cost.ts
var FLASH = { cacheHit: 0.04, miss: 2, output: 8 };
var TTS_YUAN_PER_10K_CHARS = 3;
function isPeak(ms) {
  const beijing = new Date(ms + 8 * 36e5);
  const day = beijing.getUTCDay();
  const h = beijing.getUTCHours();
  return day >= 1 && day <= 5 && (h >= 9 && h < 12 || h >= 14 && h < 18);
}
function turnYuan(model, usage2, at) {
  if (!model || !/flash/i.test(model)) return null;
  const k = isPeak(at) ? 1 : 0.5;
  return k * ((usage2.cacheReadTokens ?? 0) * FLASH.cacheHit + (usage2.inputTokens ?? 0) * FLASH.miss + (usage2.outputTokens ?? 0) * FLASH.output) / 1e6;
}
function ttsYuan(chars) {
  return chars / 1e4 * TTS_YUAN_PER_10K_CHARS;
}

// src/dsh/agent.ts
var name = "dsh-live-farben-agent";
var inject = ["tools"];
var voiced = /* @__PURE__ */ new Set();
var HandOffs = class {
  sessions = /* @__PURE__ */ new Set();
  turnStarted(sessionId) {
    this.sessions.delete(sessionId);
  }
  /** 这条消息不念（这一轮已经交出去了）返回 true */
  unsaid(sessionId, event) {
    if ((event?.data?.message?.content ?? []).some((p) => p?.type === "tool-call" && p.name === "game_side")) this.sessions.add(sessionId);
    return this.sessions.has(sessionId);
  }
};
var wordsOf = (event) => (event?.data?.message?.content ?? []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text.trim()).filter(Boolean).join("\n");
var cursors = /* @__PURE__ */ new Map();
var handOffs = new HandOffs();
var watching = false;
var freshUsage = (sessionId) => ({ sessionId, tokens: 0, input: 0, cacheRead: 0, output: 0, yuan: 0, priced: true, model: "" });
var usage = freshUsage("");
var gameMoment = "";
var gameWords = "";
function countUsage(sessionId, event, broadcast = true) {
  const u = event?.data?.usage;
  const turn = Number(u?.totalTokens);
  if (!Number.isFinite(turn) || turn <= 0) return;
  if (usage.sessionId !== sessionId) usage = freshUsage(sessionId);
  usage.tokens += turn;
  usage.input += Number(u.inputTokens) || 0;
  usage.cacheRead += Number(u.cacheReadTokens) || 0;
  usage.output += Number(u.outputTokens) || 0;
  const model = event?.data?.message?.source?.model;
  if (typeof model === "string") usage.model = model;
  const yuan = turnYuan(model, u, Number(event?.time) || Date.now());
  if (yuan === null) usage.priced = false;
  else usage.yuan += yuan;
  if (broadcast) show.stage.broadcast({ type: "usage", tokens: usage.tokens, turn, ...usage.priced ? { yuan: Math.round(usage.yuan * 1e4) / 1e4 } : {}, ...typeof model === "string" ? { model } : {} });
}
function momentSummary(text) {
  const pick = (re) => re.exec(text)?.[1]?.trim() ?? "";
  const progress = pick(/【进度】([^\n]+)/);
  if (!progress) return "";
  const body = pick(/【说明】(身体[^\n]+)/);
  const bag = pick(/【说明】背包：([^\n]+)/).replace(/\s*等\s*(\d+)\s*种\s*$/, "\u2026\u2026\uFF08\u4E00\u5171 $1 \u79CD\uFF0C\u8FD9\u91CC\u53EA\u5217\u4E86\u4E00\u90E8\u5206\uFF1A\u6CA1\u5217\u51FA\u7684\u4E0D\u7B49\u4E8E\u6CA1\u6709\uFF09");
  return [progress, body, bag && `\u80CC\u5305\uFF1A${bag}`].filter(Boolean).join("\uFF1B");
}
function publishGameNow(moment = false) {
  show.setGameNow([gameMoment, gameWords && `\u4F60\u521A\u5728\u6E38\u620F\u91CC\u8BF4\uFF1A\u300C${gameWords}\u300D`].filter(Boolean).join("\uFF1B"), moment);
}
function watchSession(ctx, sessionId, line) {
  const session = ctx.get?.("sessions")?.get?.(sessionId);
  if (!session) return;
  const total = show.currentSession ?? sessionId;
  if (!cursors.has(sessionId)) {
    cursors.set(sessionId, Number(session.seq));
    if (line === "live") usage = freshUsage(sessionId);
    for (const event of session.snapshotEvents(0) ?? []) if (event?.type === "assistant/message") countUsage(total, event, false);
    if (usage.tokens) show.stage.broadcast({ type: "usage", tokens: usage.tokens, turn: 0, ...usage.model ? { model: usage.model } : {} });
    return;
  }
  const events = session.snapshotEvents(cursors.get(sessionId));
  cursors.set(sessionId, Number(session.seq));
  for (const event of events) {
    if (event?.type === "turn/start") {
      handOffs.turnStarted(sessionId);
      show.turnStarted(sessionId);
    } else if (event?.type === "turn/end") show.turnEnded(sessionId);
    else if (event?.type === "tool/result" && line === "game") {
      const moment = wordsOf(event);
      const summary = momentSummary(moment);
      if (summary) {
        gameMoment = summary;
        show.setGameMomentFull(moment);
        publishGameNow(true);
      }
    } else if (event?.type === "assistant/message") {
      countUsage(total, event);
      const key = `${sessionId}:${event.seq}`;
      if (voiced.has(key)) continue;
      voiced.add(key);
      const handedOff = line === "live" && handOffs.unsaid(sessionId, event);
      let words = wordsOf(event);
      if (line === "game") {
        const tagged = orderTags(words);
        if (tagged.marks.length) show.markOrders(tagged.marks);
        words = tagged.text;
      }
      if (!words) continue;
      if (line === "repair") {
        show.repairSay(words);
        continue;
      }
      if (handedOff) {
        show.unsaid(words, "\u4EA4\u7ED9\u6E38\u620F\u7EBF\u56DE");
        continue;
      }
      if (line === "game") {
        gameWords = words.replace(/\[[a-z]+\]/g, "").trim().slice(0, 80);
        publishGameNow();
      }
      for (const part of splitByMood(words, currentMoods())) {
        void show.say(part.text, part.mood, AbortSignal.timeout(3e5), line).catch((err) => hooks.log("warn", `\u5FF5\u5979\u7684\u8BDD\u51FA\u9519\uFF1A${err.message}`));
      }
    }
  }
}
async function watch(ctx) {
  const sessionId = show.currentSession;
  if (!sessionId || watching) return;
  watching = true;
  try {
    if (!cursors.has(sessionId)) {
      cursors.clear();
      gameMoment = "";
      gameWords = "";
    }
    watchSession(ctx, sessionId, "live");
    const game = show.currentGameSession;
    if (game && game !== sessionId) watchSession(ctx, game, "game");
    const repair = show.currentRepairSession;
    if (repair && repair !== sessionId) watchSession(ctx, repair, "repair");
  } finally {
    watching = false;
  }
}
async function push(ctx, sessionId, text, now = false) {
  const agents = ctx.get?.("agents");
  const found = agents?.get?.(sessionId);
  const agent = found?.followup ? found : found?.agent;
  if (!agent?.followup) return false;
  const message = Object.freeze({ id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "dsh-live-farben" } });
  if (now && agent.steer) await agent.steer(message);
  else await agent.followup(message);
  return true;
}
function money(yuan) {
  return yuan < 0.01 ? "\u4E0D\u5230 1 \u5206\u94B1" : `${yuan.toFixed(2)} \u5143`;
}
var PLAY_UNKNOWN_SEC = 600;
var PLAY_CONFIRM_MS = 15e3;
var FIND_DEADLINE_MS = 2e4;
var MAX_VIDEO_SEC = 20 * 60;
var LONG_VIDEO_FAN_LEVEL = 10;
var LONG_VIDEO_NOTE = `\u8D85\u8FC7 20 \u5206\u949F\u7684\u89C6\u9891\u8981\u7C89\u4E1D\u56E2 ${LONG_VIDEO_FAN_LEVEL} \u7EA7\u4EE5\u4E0A\u624D\u80FD\u70B9\u54E6\u3002`;
function withDeadline(promise, ms = FIND_DEADLINE_MS) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
}
async function findCover(query) {
  for (const suffix of [" \u7FFB\u5531", " \u4F34\u594F", ""]) {
    const found = await videos.search(`${query}${suffix}`, { order: "views" });
    for (const hit of found?.hits ?? []) {
      if (!hit.durationSec || hit.durationSec < 45 || hit.durationSec > MAX_VIDEO_SEC) continue;
      const ref = await videos.resolve(hit.bvid);
      if (!ref) continue;
      const info = await videos.info(ref);
      const part = info?.parts?.[0];
      if (!info || !part) continue;
      const url = await videos.playUrl(info.bvid, part.cid);
      if (!url) continue;
      const cached = await cacheVideo(join2(dataDir, "media"), info.bvid, url);
      const src = cached ? `/media?id=${info.bvid}` : void 0;
      return {
        title: info.title,
        request: {
          bvid: info.bvid,
          title: info.title,
          up: info.up?.name ?? "",
          url,
          fromSec: 0,
          untilSec: info.durationSec || part.durationSec || 240,
          durationSec: info.durationSec || part.durationSec,
          ...src ? { src } : {}
        }
      };
    }
  }
  return null;
}
function seconds(value) {
  if (typeof value === "number") return Math.max(0, value);
  const text = String(value ?? "").trim();
  if (!text) return 0;
  return Math.max(0, text.split(":").reduce((sum, n) => sum * 60 + (Number(n) || 0), 0));
}
function person(who) {
  const w = who.trim();
  const talker = social.findTalker(w);
  if (talker) return talker;
  const viewer = show.lookupViewer(w);
  if (viewer.kind === "found") return { uid: viewer.uid, name: viewer.user.name };
  if (/^\d{1,20}$/.test(w)) return { uid: w, name: `UID ${w}` };
  return lookupProblem(w, viewer);
}
async function findVideo(video, part) {
  const text = String(video ?? "").trim();
  const ref = await videos.resolve(text);
  if (!ref) return `\u6CA1\u8BA4\u51FA\u300C${text.slice(0, 40)}\u300D\u662F\u54EA\u4E2A\u89C6\u9891\uFF1Avideo \u586B BV \u53F7\uFF08BV \u5F00\u5934\u7684 12 \u4F4D\uFF0Csearch_videos \u7684\u7ED3\u679C\u548C view_profile \u7684\u6295\u7A3F\u91CC\u90FD\u6709\uFF09\u3001av \u53F7\u6216\u8005\u89C6\u9891\u94FE\u63A5\u3002`;
  const info = await videos.info(ref);
  if (!info) return `${ref.bvid ?? `av${ref.aid}`} \u6253\u4E0D\u5F00\uFF1A\u53EF\u80FD\u6CA1\u6709\u8FD9\u4E2A\u89C6\u9891\u3001\u88AB\u5220\u4E86\uFF0C\u6216\u8005 B \u7AD9\u6CA1\u8FD4\u56DE\uFF08\u7F51\u7EDC\u95EE\u9898\uFF09\u3002\u68C0\u67E5\u4E00\u4E0B\u53F7\u7801\u3002`;
  const page = Math.floor(Number(part) || ref.part || 1);
  const found = info.parts.find((p) => p.page === page);
  if (!found) return `\u300C${info.title}\u300D\u53EA\u6709 ${info.parts.length} P\uFF0C\u6CA1\u6709 P${page}\u3002`;
  return { info, part: found };
}
async function listen(info, part, from) {
  try {
    const heard = await asr.chunk(
      { bvid: info.bvid, cid: part.cid, durationSec: part.durationSec },
      from,
      () => videos.audioUrl(info.bvid, part.cid),
      (text) => show.note("listen", `Whisper\u300C${info.title.slice(0, 12)}\u300D${text}`)
    );
    const sub = heard ? { kind: "asr", lang: heard.lang, lines: heard.lines, until: heard.until, engine: settings.asrModel } : null;
    library.subtitles(info, part, sub);
    return sub;
  } catch (err) {
    hooks.log("warn", `\u8BED\u97F3\u8BC6\u522B\u5931\u8D25\uFF08${info.bvid}\uFF09\uFF1A${err.message}`);
    return null;
  }
}
async function officialSubtitles(info, part) {
  const sub = await videos.subtitles(info.bvid, part.cid);
  library.subtitles(info, part, sub);
  return sub;
}
async function videoDanmaku(info, part) {
  const list = await videos.danmaku(part.cid);
  library.danmaku(info, part, list);
  return list;
}
function libraryView(how, fromSec, untilSec) {
  const logName = show.logName;
  const chat = show.recentChat();
  return { how, at: Date.now(), fromSec, ...untilSec !== void 0 ? { untilSec } : {}, ...logName ? { show: logName } : {}, ...chat.length ? { chat } : {} };
}
async function completeWithDsh(ctx, model, system, user) {
  const llm = ctx.get?.("llm");
  if (!llm) throw new Error("DSH \u7684\u6A21\u578B\u670D\u52A1\u4E0D\u53EF\u7528");
  const slash = model.indexOf("/");
  let out = "";
  for await (const chunk of llm.stream({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    system,
    messages: [{ id: randomUUID(), role: "user", content: [{ type: "text", text: user }], source: { kind: "dsh-live-farben" } }],
    maxTokens: 3e3,
    reasoningEffort: "off",
    purpose: "dsh-live-farben-memory",
    signal: AbortSignal.timeout(12e4)
  })) {
    if (chunk.type === "text-delta") out += chunk.text;
  }
  return out.trim();
}
function apply(ctx) {
  hooks.secret = async (name2) => {
    const credentials = ctx.get?.("credentials");
    const hit = credentials ? await credentials.resolve(name2).catch(() => void 0) : void 0;
    return hit?.value ?? process.env[name2] ?? "";
  };
  hooks.setSecret = async (name2, value) => {
    const credentials = ctx.get?.("credentials");
    if (!credentials?.set) throw new Error("\u8FD9\u4E2A DSH \u6CA1\u6709\u51ED\u636E\u670D\u52A1\uFF0C\u5B58\u4E0D\u4E86");
    await credentials.set(name2, value);
  };
  hooks.complete = (model, system, user) => completeWithDsh(ctx, model, system, user);
  hooks.push = (sessionId, text2, now) => push(ctx, sessionId, text2, now);
  markAgentReady();
  if (ctx.logger) hooks.log = (level, message) => {
    ctx.logger[level]?.(`dsh-live-farben: ${message}`);
    if (level === "warn") console.warn(`[dsh-live-farben] ${message}`);
  };
  ctx.effect(() => {
    const timer = setInterval(() => void watch(ctx).catch((err) => hooks.log("warn", `\u76EF\u4F1A\u8BDD\u51FA\u9519\uFF1A${err.message}`)), 300);
    return () => clearInterval(timer);
  }, "dsh-live-farben session watch");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "view_profile",
    description: "\u770B\u4E00\u4E2A B \u7AD9\u4E2A\u4EBA\u4E3B\u9875\uFF1A\u7B49\u7EA7\u3001\u7B7E\u540D\u3001\u7C89\u4E1D\u548C\u5173\u6CE8\u6570\u3001\u6700\u8FD1\u6295\u7A3F\u3001\u7F6E\u9876\u89C6\u9891\u3001\u4EE3\u8868\u4F5C\u3001\u7A7A\u95F4\u516C\u544A\u3001\u6709\u6CA1\u6709\u76F4\u64AD\u95F4\u3001\u5934\u50CF\u56FE\u7247\u7684\u7F51\u5740\u3002\u53EF\u4EE5\u770B\u89C2\u4F17\u7684\uFF0C\u4E5F\u53EF\u4EE5\u770B\u4F60\u81EA\u5DF1\u5F00\u64AD\u8D26\u53F7\u7684\u3002\u53EA\u770B\u5F97\u5230\u4E3B\u9875\u4E0A\u516C\u5F00\u7684\u4E1C\u897F\u3002\u8981\u51E0\u79D2\u949F\u3002",
    parameters: {
      who: { type: "string", required: true, description: "\u89C2\u4F17\u7684\u540D\u5B57\uFF08\u7167\u6D88\u606F\u91CC\u5199\u7684\uFF09\u6216 UID\uFF1B\u770B\u4F60\u81EA\u5DF1\u5F00\u64AD\u8D26\u53F7\u7684\u4E3B\u9875\u586B\u300C\u81EA\u5DF1\u300D" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const who = String(args.who ?? "");
      if (who.trim() === "\u81EA\u5DF1") {
        const me = await whoIs(await cookie());
        if (!me) return "\u5F00\u64AD\u8D26\u53F7\u73B0\u5728\u6CA1\u767B\u5F55\uFF0C\u770B\u4E0D\u4E86\u81EA\u5DF1\u7684\u4E3B\u9875\u3002";
        show.toolCall("view_profile", me.name, "\u5728\u770B\u81EA\u5DF1\u7684\u4E3B\u9875");
        const profile2 = await fetchProfile(String(me.uid), await cookie());
        return profile2 ? `\u4F60\u81EA\u5DF1\u7684\u5F00\u64AD\u8D26\u53F7\uFF08${me.name}\uFF0CUID ${me.uid}\uFF09\uFF1A
${profileText(profile2)}` : "\u6CA1\u6253\u5F00\u81EA\u5DF1\u7684\u4E3B\u9875\uFF08B \u7AD9\u6CA1\u8FD4\u56DE\uFF0C\u53EF\u80FD\u662F\u7F51\u7EDC\u95EE\u9898\uFF09\u3002";
      }
      const viewer = show.lookupViewer(who);
      if (viewer.kind !== "found") return lookupProblem(who, viewer);
      if (show.isBlocked(viewer.uid)) return `${viewer.user.name} \u5728\u4E3B\u4EBA\u7684\u9ED1\u540D\u5355\u4E0A\uFF0C\u4E0D\u548C\u4ED6\u6765\u5F80\uFF0C\u4E3B\u9875\u4E5F\u4E0D\u770B\u3002`;
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} \u8BF4\u8FC7\u4E0D\u60F3\u88AB\u8BB0\u4F4F\uFF0C\u4ED6\u7684\u4E3B\u9875\u5C31\u4E0D\u770B\u4E86\u3002`;
      show.toolCall("view_profile", viewer.how === "unseen-uid" ? `UID ${viewer.uid}` : viewer.user.name, viewer.how === "unseen-uid" ? `\u5728\u770B UID ${viewer.uid} \u7684\u4E3B\u9875` : `\u5728\u770B${viewer.user.name}\u7684\u4E3B\u9875`);
      const profile = await fetchProfile(viewer.uid, await cookie());
      if (!profile) return viewer.how === "unseen-uid" ? `UID ${viewer.uid} \u6253\u4E0D\u5F00\uFF1A\u53EF\u80FD\u6CA1\u6709\u8FD9\u4E2A\u7528\u6237\uFF0C\u68C0\u67E5\u4E00\u4E0B\u6570\u5B57\u3002` : `\u6CA1\u6253\u5F00 ${viewer.user.name} \u7684\u4E3B\u9875\uFF08B \u7AD9\u6CA1\u8FD4\u56DE\uFF0C\u53EF\u80FD\u662F\u7F51\u7EDC\u95EE\u9898\uFF09\u3002`;
      const marks = [
        viewer.user.guardLevel ? ["", "\u603B\u7763", "\u63D0\u7763", "\u8230\u957F"][viewer.user.guardLevel] : "",
        viewer.user.medal?.ofThisRoom ? `\u7C89\u4E1D\u724C${viewer.user.medal.level}\u7EA7` : "",
        viewer.user.isAdmin ? "\u623F\u7BA1" : ""
      ].filter(Boolean).join("\uFF0C");
      show.rememberProfile(viewer.uid, profileSummary(profile));
      const note = viewer.how === "partial" ? `\uFF08\u6309\u300C${who}\u300D\u627E\u5230\u7684\u662F ${profile.name}\uFF1B\u4E0D\u662F\u4ED6\u7684\u8BDD\uFF0C\u7528 UID \u518D\u67E5\uFF09
` : "";
      return note + profileText(profile, marks || void 0);
    }
  })), "view_profile tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "send_dm",
    description: "\u7528\u5F00\u64AD\u8D26\u53F7\u7ED9\u4E00\u4E2A\u4EBA\u53D1\u4E00\u6761 B \u7AD9\u79C1\u4FE1\uFF08\u6587\u5B57\uFF09\uFF1A\u76F4\u64AD\u95F4\u91CC\u7684\u89C2\u4F17\u3001\u79C1\u4FE1\u8FC7\u4F60\u7684\u4EBA\uFF0C\u6216\u8005\u4EFB\u4F55 B \u7AD9\u7528\u6237\uFF08\u586B UID\uFF09\u3002B \u7AD9\u89C4\u5B9A\uFF1A\u5BF9\u65B9\u6CA1\u5173\u6CE8\u5F00\u64AD\u8D26\u53F7\u3001\u4E5F\u6CA1\u56DE\u8FC7\u79C1\u4FE1\u65F6\uFF0C\u53EA\u80FD\u53D1\u4E00\u6761\uFF0C\u8981\u7B49\u4ED6\u5173\u6CE8\u6216\u56DE\u590D\u624D\u80FD\u518D\u53D1\uFF1B\u7ED3\u679C\u91CC\u4F1A\u544A\u8BC9\u4F60\u4ED6\u5173\u6CE8\u4E86\u6CA1\u6709\u3002",
    parameters: {
      who: { type: "string", required: true, description: "\u540D\u5B57\uFF08\u7167\u6D88\u606F\u91CC\u5199\u7684\uFF09\u6216 UID" },
      text: { type: "string", required: true, description: "\u79C1\u4FE1\u5185\u5BB9\uFF082000 \u5B57\u8282\u4EE5\u5185\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const who = person(String(args.who ?? ""));
      if (typeof who === "string") return who;
      if (show.isBlocked(who.uid)) return `${who.name} \u5728\u4E3B\u4EBA\u7684\u9ED1\u540D\u5355\u4E0A\uFF0C\u4E0D\u7ED9\u4ED6\u53D1\u79C1\u4FE1\u3002`;
      if (show.optedOut(who.uid)) return `${who.name} \u8BF4\u8FC7\u4E0D\u60F3\u88AB\u8BB0\u4F4F\uFF0C\u5C31\u4E0D\u79C1\u4FE1\u4ED6\u4E86\u3002`;
      show.toolCall("send_dm", `\u2192 ${who.name}`, `\u5728\u7ED9${who.name}\u53D1\u79C1\u4FE1`);
      const result = await dm.send(who, String(args.text ?? ""));
      if (result.ok) show.noteDm(who.name, String(args.text ?? ""));
      return result.text;
    }
  })), "send_dm tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "like",
    description: "\u7528\u5F00\u64AD\u8D26\u53F7\u70B9\u8D5E\uFF1A\u7ED9\u4E00\u4E2A B \u7AD9\u89C6\u9891\uFF08video\uFF09\uFF0C\u6216\u8005\u7ED9\u4E00\u6761\u8BC4\u8BBA\uFF08comment\uFF0Cread_comments / check_inbox \u91CC\u65B9\u62EC\u53F7\u7684\u7F16\u53F7\uFF09\u3002",
    parameters: {
      video: { type: "string", description: "BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" },
      comment: { type: "string", description: "\u8BC4\u8BBA\u7F16\u53F7" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const comment = String(args.comment ?? "").trim();
      if (comment) {
        show.toolCall("like", `\u8BC4\u8BBA ${comment}`, "\u5728\u7ED9\u8BC4\u8BBA\u70B9\u8D5E");
        return social.likeComment(comment);
      }
      const found = await findVideo(args.video, void 0);
      if (typeof found === "string") return found;
      show.toolCall("like", `\u300C${found.info.title.slice(0, 16)}\u300D`, "\u5728\u70B9\u8D5E");
      return social.likeVideo(found.info.aid, found.info.title);
    }
  })), "like tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "read_comments",
    description: "\u770B\u4E00\u4E2A B \u7AD9\u89C6\u9891\u7684\u8BC4\u8BBA\u533A\uFF1A\u6BCF\u6761\u5E26\u7F16\u53F7\uFF08\u56DE\u590D\u3001\u70B9\u8D5E\u7528\uFF09\u3001\u540D\u5B57\u3001\u70B9\u8D5E\u6570\u3001\u697C\u91CC\u7684\u51E0\u6761\u56DE\u590D\u3002\u53EF\u4EE5\u6309\u70ED\u95E8\u6216\u6700\u65B0\uFF0C\u53EF\u4EE5\u7FFB\u9875\u3002",
    parameters: {
      video: { type: "string", required: true, description: "BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" },
      sort: { type: "string", enum: ["hot", "new"], description: "hot \u70ED\u95E8\uFF08\u9ED8\u8BA4\uFF09\u3001new \u6700\u65B0" },
      page: { type: "number", description: "\u7B2C\u51E0\u9875\uFF0C\u9ED8\u8BA4 1" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, void 0);
      if (typeof found === "string") return found;
      const { info } = found;
      show.toolCall("read_comments", `\u300C${info.title.slice(0, 16)}\u300D`, `\u5728\u770B\u300C${info.title.slice(0, 16)}\u300D\u7684\u8BC4\u8BBA\u533A`);
      return social.readComments({ type: 1, oid: String(info.aid), title: info.title }, args.sort === "new" ? "new" : "hot", Math.max(1, Math.floor(Number(args.page) || 1)));
    }
  })), "read_comments tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "post_comment",
    description: `\u7528\u5F00\u64AD\u8D26\u53F7\u53D1\u4E00\u6761 B \u7AD9\u8BC4\u8BBA\uFF1A\u53D1\u5728\u89C6\u9891\u4E0B\u9762\uFF08video\uFF09\uFF0C\u6216\u8005\u56DE\u590D\u67D0\u4E00\u6761\u8BC4\u8BBA\uFF08reply_to\uFF0Cread_comments / check_inbox \u91CC\u65B9\u62EC\u53F7\u7684\u7F16\u53F7\uFF09\u3002\u8BC4\u8BBA\u516C\u5F00\u6302\u5728\u90A3\u91CC\uFF0C\u5927\u5BB6\u90FD\u770B\u5F97\u5230\u662F\u8FD9\u4E2A\u8D26\u53F7\u53D1\u7684\u3002\u4E24\u6761\u4E4B\u95F4\u9694 ${COMMENT_GAP_MS / 1e3} \u79D2\uFF08\u53D1\u592A\u5FEB B \u7AD9\u4F1A\u98CE\u63A7\uFF09\u3002`,
    parameters: {
      text: { type: "string", required: true, description: `\u8BC4\u8BBA\u5185\u5BB9\uFF08${MAX_COMMENT_CHARS} \u5B57\u4EE5\u5185\uFF09` },
      video: { type: "string", description: "\u53D1\u5728\u54EA\u4E2A\u89C6\u9891\u4E0B\u9762\uFF1ABV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" },
      reply_to: { type: "string", description: "\u56DE\u590D\u54EA\u4E00\u6761\u8BC4\u8BBA\uFF1A\u8BC4\u8BBA\u7F16\u53F7" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const replyTo = String(args.reply_to ?? "").trim() || void 0;
      let thread = null;
      if (!replyTo) {
        const found = await findVideo(args.video, void 0);
        if (typeof found === "string") return found;
        thread = { type: 1, oid: String(found.info.aid), title: found.info.title };
      }
      show.toolCall("post_comment", replyTo ? `\u56DE\u590D ${replyTo}` : `\u300C${thread.title.slice(0, 16)}\u300D`, "\u5728\u53D1\u8BC4\u8BBA");
      const result = await social.postComment(thread, String(args.text ?? ""), replyTo);
      if (result.ok) show.noteComment(String(args.text ?? ""), thread?.title ?? replyTo ?? "");
      return result.text;
    }
  })), "post_comment tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "check_inbox",
    description: "\u770B\u5F00\u64AD\u8D26\u53F7\u7684\u6536\u4EF6\u7BB1\uFF1A\u6700\u8FD1\u7684\u79C1\u4FE1\u4F1A\u8BDD\uFF08\u8C01\u3001\u672A\u8BFB\u51E0\u6761\u3001\u6700\u540E\u4E00\u53E5\uFF09\uFF0C\u548C\u522B\u4EBA\u5728\u8BC4\u8BBA\u533A\u56DE\u590D\u4F60\u3001@ \u4F60\u7684\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      show.toolCall("check_inbox", "", "\u5728\u770B\u79C1\u4FE1\u548C\u8BC4\u8BBA\u56DE\u590D");
      return social.inbox();
    }
  })), "check_inbox tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "read_dm",
    description: "\u770B\u4F60\u548C\u4E00\u4E2A\u4EBA\u6700\u8FD1\u7684\u79C1\u4FE1\u5F80\u6765\uFF08\u4ED6\u8BF4\u4E86\u4EC0\u4E48\u3001\u4F60\u56DE\u4E86\u4EC0\u4E48\uFF09\u3002\u4ED6\u53D1\u6765\u7684\u56FE\u7247\u4F1A\u5E26\u7740\u56FE\u7247\u7F51\u5740\uFF0C\u6E38\u620F\u91CC\u7684 picture \u80FD\u7528\u3002",
    parameters: {
      who: { type: "string", required: true, description: "\u540D\u5B57\uFF08check_inbox \u91CC\u7684\uFF09\u6216 UID" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const who = String(args.who ?? "").trim();
      const talker = social.findTalker(who) ?? (/^\d{1,20}$/.test(who) ? { uid: who, name: `UID ${who}` } : null);
      if (!talker) {
        const viewer = show.lookupViewer(who);
        if (viewer.kind !== "found") return `\u4E0D\u77E5\u9053\u300C${who}\u300D\u662F\u8C01\uFF1A\u5148 check_inbox \u770B\u770B\u79C1\u4FE1\u5217\u8868\uFF0C\u7528\u90A3\u91CC\u7684\u540D\u5B57\u6216 UID\u3002`;
        show.toolCall("read_dm", viewer.user.name, `\u5728\u770B\u548C${viewer.user.name}\u7684\u79C1\u4FE1`);
        return social.conversation(viewer.uid, viewer.user.name);
      }
      show.toolCall("read_dm", talker.name, `\u5728\u770B\u548C${talker.name}\u7684\u79C1\u4FE1`);
      return social.conversation(talker.uid, talker.name);
    }
  })), "read_dm tool");
  const text = (value) => [{ type: "text", text: value }];
  const stringOut = { schema: { type: "string" }, render: (_args, value) => text(value) };
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "look",
    description: "\u770B\u4E00\u773C\u76F4\u64AD\u753B\u9762\uFF1A\u622A\u4E00\u5F20\u89C2\u4F17\u73B0\u5728\u770B\u5230\u7684\u76F4\u64AD\u753B\u9762\u7ED9\u4F60\u3002",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", required: true },
          image: {
            type: "object",
            additionalProperties: false,
            properties: {
              attachmentId: { type: "string", required: true },
              mediaType: { type: "string", required: true },
              bytes: { type: "integer", required: true },
              width: { type: "integer", required: true },
              height: { type: "integer", required: true },
              name: { type: "string" }
            }
          }
        }
      },
      render: (_args, value) => [
        { type: "text", text: value.text },
        ...value.image ? [{ type: "image", attachment: value.image }] : []
      ]
    },
    async execute(_args, exec) {
      show.toolCall("look", "", "\u5728\u770B\u76F4\u64AD\u753B\u9762");
      const attachments = ctx.get?.("attachments");
      const llm = ctx.get?.("llm");
      const routed = exec?.agent?.session?.requestHeader?.()?.config;
      const provider = routed?.provider ?? exec?.agent?.options?.provider;
      const model = routed?.model ?? exec?.agent?.options?.model;
      const info = llm && provider && model ? await llm.resolveModelInfo(provider, model, exec?.signal).catch(() => null) : null;
      if (!attachments || !info?.inputModalities?.includes("image")) return { text: "\u73B0\u5728\u7528\u7684\u6A21\u578B\u4E0D\u80FD\u770B\u56FE\uFF0C\u8FD9\u6B21\u770B\u4E0D\u4E86\u753B\u9762\u3002" };
      let data;
      try {
        data = await screenshot();
      } catch (err) {
        hooks.log("warn", `look \u622A\u56FE\u5931\u8D25\uFF1A${err.message}`);
        return { text: "\u753B\u9762\u6CA1\u622A\u5230\uFF08\u76F4\u64AD\u7535\u8111\u4E0A\u7684 OBS \u6CA1\u8FDE\u4E0A\uFF09\uFF0C\u8FC7\u4E00\u4F1A\u513F\u518D\u770B\u3002" };
      }
      const ref = await attachments.saveImage({ data, mediaType: "image/jpeg", name: "look.jpg" });
      const at = new Date(Date.now() + 8 * 36e5).toISOString().slice(11, 19);
      return {
        text: `\u76F4\u64AD\u753B\u9762\uFF0C${at}\uFF1A`,
        image: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...ref.name ? { name: ref.name } : {} }
      };
    }
  })), "look tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "show_stats",
    description: "\u770B\u8FD9\u573A\u76F4\u64AD\u7684\u6570\u636E\uFF1A\u64AD\u4E86\u591A\u4E45\u3001\u4F60\u7528\u4E86\u591A\u5C11 token\u3001\u5927\u6982\u82B1\u4E86\u591A\u5C11\u94B1\uFF08\u6A21\u578B\u548C\u914D\u97F3\uFF09\u3001\u5FF5\u4E86\u591A\u5C11\u5B57\u3002",
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall("show_stats", "", "\u5728\u770B\u8FD9\u573A\u7684\u8D26");
      const s = show.stats();
      const tts = ttsYuan(s.spokenChars);
      const minutes = Math.round(s.liveMs / 6e4);
      const lines = [
        `\u8FD9\u573A\u64AD\u4E86 ${minutes >= 60 ? `${Math.floor(minutes / 60)} \u5C0F\u65F6 ${minutes % 60} \u5206\u949F` : `${minutes} \u5206\u949F`}\u3002`,
        `\u4F60\u7528\u4E86 ${usage.tokens.toLocaleString("en-US")} token\uFF08\u7F13\u5B58\u547D\u4E2D ${usage.cacheRead.toLocaleString("en-US")}\uFF0C\u6CA1\u547D\u4E2D\u7684\u8F93\u5165 ${usage.input.toLocaleString("en-US")}\uFF0C\u8F93\u51FA ${usage.output.toLocaleString("en-US")}\uFF09\u3002`,
        usage.priced ? `\u6A21\u578B\u5927\u6982\u82B1\u4E86 ${money(usage.yuan)}\uFF08\u7F13\u5B58\u547D\u4E2D\u5F88\u4FBF\u5B9C\uFF1B\u5DE5\u4F5C\u65E5\u767D\u5929\u9AD8\u5CF0\u4EF7\uFF0C\u5176\u4F59\u65F6\u95F4\u534A\u4EF7\uFF09\u3002` : "\u8FD9\u4E2A\u6A21\u578B\u7684\u4EF7\u94B1\u8FD9\u91CC\u4E0D\u77E5\u9053\uFF0C\u53EA\u80FD\u62A5 token\u3002",
        `\u5FF5\u4E86\u5927\u7EA6 ${s.spokenChars} \u4E2A\u5B57\uFF0C\u914D\u97F3\u5927\u6982 ${money(tts)}\uFF083 \u5143\u4E00\u4E07\u5B57\uFF09\u3002`
      ];
      return lines.join("\n");
    }
  })), "show_stats tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "follow",
    description: "\u7528\u5F00\u64AD\u8D26\u53F7\u5173\u6CE8\u4E00\u4E2A\u4EBA\uFF08\u6BD4\u5982\u56DE\u5173\u65B0\u7C89\u4E1D\uFF09\uFF0C\u6216\u8005\u53D6\u5173\u3002",
    parameters: {
      who: { type: "string", required: true, description: "\u540D\u5B57\uFF08\u76F4\u64AD\u95F4\u91CC\u3001\u79C1\u4FE1\u91CC\u7684\uFF09\u6216 UID" },
      unfollow: { type: "boolean", description: "true \u662F\u53D6\u5173\uFF0C\u9ED8\u8BA4\u5173\u6CE8" }
    },
    output: stringOut,
    async execute(args) {
      const who = person(String(args.who ?? ""));
      if (typeof who === "string") return who;
      const follow = args.unfollow !== true;
      show.toolCall("follow", `${follow ? "" : "\u53D6\u5173 "}${who.name}`, follow ? `\u5728\u5173\u6CE8${who.name}` : `\u5728\u53D6\u5173${who.name}`);
      return social.follow(who.uid, who.name, follow);
    }
  })), "follow tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "my_fans",
    description: "\u770B\u5F00\u64AD\u8D26\u53F7\u6700\u65B0\u7684\u7C89\u4E1D\uFF1A\u8C01\u3001\u4EC0\u4E48\u65F6\u5019\u5173\u6CE8\u7684\u3001\u4F60\u56DE\u5173\u4E86\u6CA1\u6709\u3002",
    parameters: { page: { type: "number", description: "\u7B2C\u51E0\u9875\uFF0C\u9ED8\u8BA4 1" } },
    output: stringOut,
    async execute(args) {
      show.toolCall("my_fans", "", "\u5728\u770B\u65B0\u7C89\u4E1D");
      return social.fans(Math.max(1, Math.floor(Number(args.page) || 1)));
    }
  })), "my_fans tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "delete_comment",
    description: "\u5220\u6389\u4E00\u6761\u8BC4\u8BBA\uFF1A\u4F60\u81EA\u5DF1\u53D1\u7684\uFF08post_comment \u7ED9\u7684\u7F16\u53F7\uFF09\uFF0C\u6216\u8005\u5F00\u64AD\u8D26\u53F7\u81EA\u5DF1\u89C6\u9891\u4E0B\u9762\u522B\u4EBA\u7684\uFF08read_comments / check_inbox \u91CC\u7684\u7F16\u53F7\uFF09\u3002",
    parameters: { comment: { type: "string", required: true, description: "\u8BC4\u8BBA\u7F16\u53F7" } },
    output: stringOut,
    async execute(args) {
      const rpid = String(args.comment ?? "").trim();
      show.toolCall("delete_comment", rpid, "\u5728\u5220\u8BC4\u8BBA");
      return social.deleteComment(rpid);
    }
  })), "delete_comment tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "post_dynamic",
    description: "\u7528\u5F00\u64AD\u8D26\u53F7\u53D1\u4E00\u6761 B \u7AD9\u6587\u5B57\u52A8\u6001\uFF08\u6807\u6CE8\u4E3A AI \u751F\u6210\uFF09\uFF0C\u5173\u6CE8\u8FD9\u4E2A\u8D26\u53F7\u7684\u4EBA\u9996\u9875\u90FD\u770B\u5F97\u5230\u3002",
    parameters: { text: { type: "string", required: true, description: "\u52A8\u6001\u5185\u5BB9" } },
    output: stringOut,
    async execute(args) {
      show.toolCall("post_dynamic", String(args.text ?? "").slice(0, 16), "\u5728\u53D1\u52A8\u6001");
      const result = await social.postDynamic(String(args.text ?? ""));
      if (result.ok) show.noteDynamic(String(args.text ?? ""));
      return result.text;
    }
  })), "post_dynamic tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "favorite",
    description: `\u628A\u4E00\u4E2A B \u7AD9\u89C6\u9891\u6536\u8FDB\u4F60\u81EA\u5DF1\u7684\u6536\u85CF\u5939\u300C${FAVORITE_FOLDER}\u300D\uFF08\u5F00\u64AD\u8D26\u53F7\u4E0A\uFF0C\u4E3B\u4EBA\u539F\u6709\u7684\u6536\u85CF\u5939\u4E0D\u52A8\uFF09\u3002`,
    parameters: { video: { type: "string", required: true, description: "BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" } },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, void 0);
      if (typeof found === "string") return found;
      show.toolCall("favorite", `\u300C${found.info.title.slice(0, 16)}\u300D`, "\u5728\u6536\u85CF");
      return social.favorite(found.info.aid, found.info.title);
    }
  })), "favorite tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "coin",
    description: "\u7528\u5F00\u64AD\u8D26\u53F7\u7ED9\u4E00\u4E2A B \u7AD9\u89C6\u9891\u6295\u5E01\uFF081 \u4E2A\u6216 2 \u4E2A\uFF0C\u4E00\u4E2A\u89C6\u9891\u6700\u591A\u6295 2 \u4E2A\uFF09\uFF0C\u53EF\u4EE5\u987A\u4FBF\u70B9\u8D5E\u3002\u786C\u5E01\u662F\u8D26\u53F7\u81EA\u5DF1\u7684\u3002",
    parameters: {
      video: { type: "string", required: true, description: "BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" },
      count: { type: "number", description: "\u6295\u51E0\u4E2A\uFF1A1 \u6216 2\uFF0C\u9ED8\u8BA4 1" },
      like: { type: "boolean", description: "\u987A\u4FBF\u70B9\u8D5E\uFF0C\u9ED8\u8BA4 true" }
    },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, void 0);
      if (typeof found === "string") return found;
      const count = Number(args.count) === 2 ? 2 : 1;
      show.toolCall("coin", `\u300C${found.info.title.slice(0, 16)}\u300D\xD7${count}`, "\u5728\u6295\u5E01");
      return social.coin(found.info.aid, found.info.title, count, args.like !== false);
    }
  })), "coin tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "mute",
    description: "\u5728\u4F60\u7684\u76F4\u64AD\u95F4\u7981\u8A00\u4E00\u4E2A\u4EBA\uFF08\u8FD9\u6BB5\u65F6\u95F4\u4ED6\u53D1\u4E0D\u4E86\u5F39\u5E55\uFF09\u3002",
    parameters: {
      who: { type: "string", required: true, description: "\u540D\u5B57\uFF08\u5F39\u5E55\u91CC\u7684\uFF09\u6216 UID" },
      hours: { type: "number", description: "\u7981\u8A00\u591A\u5C11\u5C0F\u65F6\uFF0C\u9ED8\u8BA4 1" }
    },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return "\u8FD8\u4E0D\u77E5\u9053\u4F60\u7684\u76F4\u64AD\u95F4\u662F\u54EA\u4E2A\uFF08\u6CA1\u5F00\u8FC7\u64AD\uFF09\u3002";
      const who = person(String(args.who ?? ""));
      if (typeof who === "string") return who;
      const hours = Math.max(1, Math.min(720, Math.floor(Number(args.hours) || 1)));
      show.toolCall("mute", `${who.name} ${hours}h`, `\u5728\u7981\u8A00${who.name}`);
      return social.mute(roomId, who.uid, who.name, hours);
    }
  })), "mute tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "unmute",
    description: "\u89E3\u5F00\u76F4\u64AD\u95F4\u91CC\u4E00\u4E2A\u4EBA\u7684\u7981\u8A00\uFF08\u540D\u5B57\u6216 UID\uFF09\uFF1B\u540D\u5B57\u5BF9\u4E0D\u4E0A\u65F6\u4F1A\u5217\u51FA\u73B0\u5728\u88AB\u7981\u8A00\u7684\u4EBA\u3002",
    parameters: { who: { type: "string", required: true, description: "\u540D\u5B57\u6216 UID" } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return "\u8FD8\u4E0D\u77E5\u9053\u4F60\u7684\u76F4\u64AD\u95F4\u662F\u54EA\u4E2A\uFF08\u6CA1\u5F00\u8FC7\u64AD\uFF09\u3002";
      show.toolCall("unmute", String(args.who ?? ""), "\u5728\u89E3\u7981\u8A00");
      return social.unmute(roomId, String(args.who ?? ""));
    }
  })), "unmute tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "set_live_title",
    description: "\u6539\u4F60\u76F4\u64AD\u95F4\u7684\u6807\u9898\uFF0840 \u5B57\u4EE5\u5185\uFF09\uFF0C\u63A8\u8350\u9875\u548C\u641C\u7D22\u91CC\u663E\u793A\u7684\u5C31\u662F\u5B83\u3002",
    parameters: { title: { type: "string", required: true, description: "\u65B0\u6807\u9898" } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      const title = String(args.title ?? "").trim().slice(0, 40);
      if (!roomId) return "\u8FD8\u4E0D\u77E5\u9053\u4F60\u7684\u76F4\u64AD\u95F4\u662F\u54EA\u4E2A\uFF08\u6CA1\u5F00\u8FC7\u64AD\uFF09\u3002";
      if (!title) return "\u6807\u9898\u662F\u7A7A\u7684\u3002";
      show.toolCall("set_live_title", title.slice(0, 16), "\u5728\u6539\u76F4\u64AD\u95F4\u6807\u9898");
      try {
        await new BiliRoom(await cookie()).update(roomId, { title });
        return `\u76F4\u64AD\u95F4\u6807\u9898\u6539\u6210\u4E86\u300C${title}\u300D\u3002`;
      } catch (err) {
        return `\u6539\u6807\u9898\u6CA1\u6210\u529F\uFF1A${err.message}`;
      }
    }
  })), "set_live_title tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "search_videos",
    description: "\u641C B \u7AD9\u89C6\u9891\uFF0C\u8FD4\u56DE\u4E00\u9875\u5019\u9009\uFF08BV \u53F7\u3001\u6807\u9898\u3001UP \u4E3B\u3001\u65F6\u957F\u3001\u64AD\u653E\u91CF\u3001\u53D1\u5E03\u65E5\u671F\u3001\u6807\u7B7E\u3001\u7B80\u4ECB\u3001\u5C01\u9762\u56FE\u7F51\u5740\uFF09\u3002\u5C01\u9762\u56FE\u7F51\u5740\u6E38\u620F\u91CC\u7684 picture \u4E5F\u80FD\u7528\uFF1A\u89C2\u4F17\u8981\u753B\u67D0\u4E2A\u89D2\u8272\u3001\u67D0\u6837\u4E1C\u897F\u65F6\uFF0C\u53EF\u4EE5\u641C\u5B83\u7684\u89C6\u9891\u3001\u6311\u4E00\u5F20\u5C01\u9762\u5C31\u662F\u5B83\u7684\u3002\u53EF\u4EE5\u53EA\u641C\u67D0\u4F4D UP \u4E3B\u7684\u6295\u7A3F\uFF08up\uFF09\uFF0C\u53EF\u4EE5\u6309\u6700\u65B0\u6216\u64AD\u653E\u6700\u591A\u6392\uFF08order\uFF09\uFF0C\u53EF\u4EE5\u7FFB\u9875\uFF08page\uFF09\u3002\u8D85\u8FC7 20 \u79D2\u8FD8\u6CA1\u7ED3\u679C\u5C31\u522B\u518D\u641C\u4E86\uFF1A\u76F4\u63A5\u8DDF\u89C2\u4F17\u8BF4\u6CA1\u627E\u5230\uFF0C\u7B49\u4ED6\u4EEC\u6362\u4E2A\u5173\u952E\u8BCD\u6216\u7ED9 BV \u53F7\u3002",
    parameters: {
      query: { type: "string", required: true, description: "\u5173\u952E\u8BCD\uFF08\u89C2\u4F17\u8BF4\u7684\u5927\u6982\u610F\u601D\u5C31\u884C\uFF09\uFF1B\u53EA\u770B\u67D0\u4F4D UP \u4E3B\u6700\u65B0\u7684\u6295\u7A3F\u65F6\u53EF\u4EE5\u7559\u7A7A" },
      up: { type: "string", description: "UP \u4E3B\u7684\u540D\u5B57\u6216 UID\uFF1A\u53EA\u5728\u4ED6\u7684\u6295\u7A3F\u91CC\u627E" },
      order: { type: "string", enum: ["relevance", "newest", "views"], description: "relevance \u76F8\u5173\u5EA6\uFF08\u9ED8\u8BA4\uFF09\u3001newest \u6700\u65B0\u3001views \u64AD\u653E\u6700\u591A\uFF08\u586B\u4E86 up \u65F6\u6309\u53D1\u5E03\u65F6\u95F4\uFF09" },
      page: { type: "number", description: "\u7B2C\u51E0\u9875\uFF0C\u9ED8\u8BA4 1" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const query = String(args.query ?? "").trim();
      const up = String(args.up ?? "").trim() || void 0;
      if (!query && !up) return "query \u548C up \u81F3\u5C11\u586B\u4E00\u4E2A\u3002";
      const order = ["relevance", "newest", "views"].find((o) => o === args.order);
      const options = { up, order, page: Number(args.page) || 1 };
      show.toolCall("search_videos", query ? `\u300C${query}\u300D` : `UP ${up}`, `\u5728\u641C\u89C6\u9891\uFF1A${query || up}`);
      asr.warm();
      const result = await withDeadline(videos.search(query, options));
      if (!result) return "\u641C\u7D22\u8D85\u8FC7 20 \u79D2\u8FD8\u6CA1\u7ED3\u679C\uFF1A\u76F4\u63A5\u8DDF\u89C2\u4F17\u8BF4\u6CA1\u627E\u5230\uFF0C\u522B\u53CD\u590D\u641C\u540C\u4E00\u4E2A\u8BCD\uFF0C\u7B49\u4ED6\u4EEC\u6362\u4E2A\u5173\u952E\u8BCD\u6216\u7ED9 BV \u53F7\u3002";
      return searchText(query, result, options);
    }
  })), "search_videos tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "sing_song",
    description: "\u89C2\u4F17\u70B9\u6B4C\u65F6\u7528\uFF1A\u5148\u770B\u672C\u5730\u66F2\u5E93\uFF0C\u6709\u5C31\u653E\uFF08\u5E26\u6B4C\u8BCD\uFF09\uFF1B\u66F2\u5E93\u6CA1\u6709\u5C31\u53BB B \u7AD9\u627E\u7FFB\u5531/\u4F34\u594F\u7248\uFF0C\u4E0B\u8F7D\u5230\u672C\u5730\u5F53\u73B0\u5B66\u7248\u64AD\u3002\u90FD\u6CA1\u6709\u5C31\u8001\u5B9E\u8BF4\u4E0D\u4F1A\uFF0C\u522B\u81EA\u5DF1\u7F16\u3002",
    parameters: {
      query: { type: "string", required: true, description: "\u6B4C\u540D\u6216\u6B4C\u624B\uFF08\u89C2\u4F17\u8BF4\u7684\u5927\u6982\u610F\u601D\uFF09" },
      by: { type: "string", description: "\u8C01\u70B9\u7684\uFF08\u89C2\u4F17\u540D\u5B57\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "query \u5FC5\u586B\u3002";
      const who = String(args.by ?? "").trim().slice(0, 20) || "\u5979";
      const hit = matchSong(listSongs(join2(dataDir, "songs")), query);
      if (hit) {
        const queued2 = show.queueSong(songRequest(hit), who);
        return queued2.queued ? `\u300C${hit.title}\u300D\u6392\u8FDB\u70B9\u6B4C\u961F\u5217\u4E86\uFF0C\u7B2C ${queued2.position} \u4F4D\uFF0C\u524D\u9762\u653E\u5B8C\u5C31\u5531\u3002` : `\u5F00\u59CB\u5531\u300C${hit.title}\u300D\u4E86\u3002`;
      }
      const cover = await withDeadline(findCover(query), 2e4);
      if (!cover) return `\u66F2\u5E93\u91CC\u6CA1\u6709\u300C${query}\u300D\uFF0CB \u7AD9\u4E5F\u6CA1\u627E\u5230\u80FD\u653E\u7684\u7FFB\u5531\uFF1A\u8DDF\u89C2\u4F17\u8BF4\u8FD9\u9996\u8FD8\u4E0D\u4F1A\u3001\u7B49\u5B66\u4E86\u518D\u5531\uFF0C\u522B\u4E71\u7F16\u3002`;
      const queued = show.queueVideo(cover.request, void 0, void 0, who);
      return queued.queued ? `\u66F2\u5E93\u6CA1\u6709\u300C${query}\u300D\uFF0C\u6211\u627E\u4E86\u4E2A B \u7AD9\u7FFB\u5531\u7248\u300C${cover.title}\u300D\uFF0C\u6392\u8FDB\u961F\u5217\u7B2C ${queued.position} \u4F4D\u3002` : `\u66F2\u5E93\u6CA1\u6709\u300C${query}\u300D\uFF0C\u6211\u627E\u4E86\u4E2A B \u7AD9\u7FFB\u5531\u7248\u300C${cover.title}\u300D\uFF0C\u73B0\u5728\u653E\u3002`;
    }
  })), "sing_song tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "priority_play",
    description: "\u628A\u67D0\u4F4D\u89C2\u4F17\u6392\u5728\u70B9\u64AD\u961F\u5217\u91CC\u7684\u89C6\u9891\u63D2\u5230\u4E0B\u4E00\u4E2A\uFF08ta \u540C\u610F\u300C\u4F18\u5148\u64AD\u653E\u300D\u65F6\u7528\uFF09\u3002\u957F\u89C6\u9891\u7684\u7C89\u4E1D\u56E2\u89C2\u4F17\u624D\u7528\u5F97\u4E0A\u3002",
    parameters: {
      by: { type: "string", required: true, description: "\u540C\u610F\u4F18\u5148\u64AD\u653E\u7684\u89C2\u4F17\u540D\u5B57" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const who = String(args.by ?? "").trim();
      if (!who) return "by \u586B\u89C2\u4F17\u540D\u5B57\u3002";
      const title = show.promoteQueued(who);
      return title ? `\u300C${title}\u300D\u5DF2\u7ECF\u63D2\u5230\u4E0B\u4E00\u4E2A\uFF0C\u653E\u5B8C\u73B0\u5728\u8FD9\u4E2A\u5C31\u653E\u5B83\u3002` : `\u961F\u5217\u91CC\u6CA1\u627E\u5230 ${who} \u7684\u70B9\u64AD\uFF1A\u53EF\u80FD\u5DF2\u7ECF\u653E\u4E0A\u4E86\uFF0C\u6216\u8005 ta \u8FD8\u6CA1\u70B9\u3002`;
    }
  })), "priority_play tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "queue_status",
    description: "\u67E5\u70B9\u64AD\u961F\u5217\uFF1A\u67D0\u4E2A\u89C2\u4F17\u70B9\u7684\u89C6\u9891\u6392\u5728\u7B2C\u51E0\u4F4D\uFF0C\u6216\u8005\u6574\u6761\u961F\u5217\u73B0\u5728\u4EC0\u4E48\u987A\u5E8F\u3002\u89C2\u4F17\u95EE\u300C\u6211\u7B2C\u51E0\u4E2A\u300D\u65F6\u7528\u3002",
    parameters: {
      by: { type: "string", description: "\u89C2\u4F17\u540D\u5B57\uFF1B\u4E0D\u586B\u5C31\u770B\u6574\u6761\u961F\u5217" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const by = String(args.by ?? "").trim();
      return show.queueStatus(by);
    }
  })), "queue_status tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "gift_board",
    description: "\u770B\u793C\u7269\u699C\uFF1A\u672C\u65E5\u6216\u672C\u6708\uFF0C\u8C01\u9001\u5F97\u6700\u591A\u3001\u9001\u4E86\u4EC0\u4E48\u3002period \u586B today \u6216 month\uFF08\u9ED8\u8BA4 today\uFF09\u3002",
    parameters: {
      period: { type: "string", description: "today \u6216 month\uFF0C\u9ED8\u8BA4 today" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const period = String(args.period ?? "today").toLowerCase() === "month" ? "month" : "today";
      const data = giftBoard.summary();
      const list = period === "month" ? data.month : data.today;
      if (!list.length) return period === "month" ? "\u8FD9\u4E2A\u6708\u8FD8\u6CA1\u4EBA\u9001\u793C\u7269\u5462\u3002" : "\u4ECA\u5929\u8FD8\u6CA1\u4EBA\u9001\u793C\u7269\u5462\u3002";
      const lines = list.map((p, i) => `${i + 1}. ${p.name}\uFF1A${p.gifts.map((g) => `${g.gift}\xD7${g.count}`).join("\u3001")}\uFF0C\u7EA6 ${p.total.toFixed(0)} \u5143`);
      return `${period === "month" ? "\u672C\u6708" : "\u672C\u65E5"}\u793C\u7269\u699C\uFF08${list.length} \u4EBA\uFF09\uFF1A
${lines.join("\n")}`;
    }
  })), "gift_board tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "gift_memory",
    description: "\u67E5\u793C\u7269\u77E5\u8BC6\u5E93\uFF1A\u67D0\u4E2A\u4EBA\u9001\u8FC7\u4EC0\u4E48\uFF08\u957F\u671F\uFF09\uFF0C\u6216\u8005\u6700\u8FD1\u51E0\u5929\u8C01\u9001\u4E86\u4EC0\u4E48\u793C\u7269\u3002name \u586B\u4EBA\u540D\uFF1B\u4E0D\u586B\u5C31\u8FD4\u56DE\u6700\u8FD1\u51E0\u5929\u7684\u6C47\u603B\u3002",
    parameters: {
      name: { type: "string", description: "\u89C2\u4F17\u540D\u5B57\uFF1B\u4E0D\u586B\u5C31\u770B\u6700\u8FD1\u7684\u793C\u7269\u8BB0\u5F55" },
      days: { type: "number", description: "\u4E0D\u586B name \u65F6\u770B\u6700\u8FD1\u51E0\u5929\u7684\u6C47\u603B\uFF0C\u9ED8\u8BA4 7" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const name2 = String(args.name ?? "").trim();
      if (name2) {
        const note = giftBoard.personNote(name2);
        return note ?? `\u793C\u7269\u8BB0\u5F55\u91CC\u6CA1\u627E\u5230\u300C${name2}\u300D\u9001\u8FC7\u4EC0\u4E48\u3002`;
      }
      const days = Math.max(1, Math.min(60, Number(args.days) || 7));
      const notes = giftBoard.dayNotes(days);
      if (!notes.length) return "\u6700\u8FD1\u8FD8\u6CA1\u6709\u793C\u7269\u8BB0\u5F55\u3002";
      return `\u6700\u8FD1 ${notes.length} \u5929\u7684\u793C\u7269\u8BB0\u5F55\uFF1A
${notes.map((n) => n.text).join("\n")}`;
    }
  })), "gift_memory tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "hide_and_seek",
    description: "\u73A9\u6349\u8FF7\u85CF\uFF1A\u5F71\u9041\u85CF\u5230\u821E\u53F0\u67D0\u4E2A\u7EC4\u4EF6\u540E\u9762\uFF0C\u5F00 10 \u79D2\u6295\u7968\u8BA9\u89C2\u4F17\u731C\u3002\u89C2\u4F17\u8BF4\u300C\u6349\u8FF7\u85CF\u300D\u6216\u8005\u4F60\u60F3\u73A9\u65F6\u7528\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      const result = show.startHideGame();
      return result.ok ? result.text : result.text;
    }
  })), "hide_and_seek tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "visit_room",
    description: "\u53BB\u522B\u4EBA\u7684 B \u7AD9\u76F4\u64AD\u95F4\u4E32\u95E8\uFF1A\u770B\u623F\u95F4\u6807\u9898\u3001\u4E3B\u64AD\u3001\u5206\u533A\u3001\u4EBA\u6C14\u3001\u5173\u6CE8\u6570\u548C\u6700\u8FD1\u51E0\u6761\u5F39\u5E55\uFF0C\u518D\u56DE\u6765\u8DDF\u5927\u5BB6\u70B9\u8BC4\u3002",
    parameters: {
      room: { type: "string", required: true, description: "\u5BF9\u65B9\u76F4\u64AD\u95F4\u623F\u95F4\u53F7\uFF08\u6216\u76F4\u64AD\u95F4\u94FE\u63A5\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const raw = String(args.room ?? "").trim();
      const m = /live\.bilibili\.com\/(\d{5,9})/.exec(raw);
      const id = m?.[1] ?? raw.replace(/[^0-9]/g, "");
      if (!id) return "\u623F\u95F4\u53F7\u4E0D\u5BF9\uFF0C\u7ED9\u6211\u5BF9\u65B9\u7684\u76F4\u64AD\u95F4\u623F\u95F4\u53F7\u3002";
      const jar = await cookie().catch(() => "");
      const headers = { "User-Agent": "Mozilla/5.0", Referer: `https://live.bilibili.com/${id}`, ...jar ? { Cookie: jar } : {} };
      try {
        const info = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`, { headers, signal: AbortSignal.timeout(15e3) }).then((r) => r.json());
        if (info.code !== 0) return `\u623F\u95F4 ${id} \u6253\u4E0D\u5F00\uFF1A${info.message ?? info.code}`;
        const d = info.data ?? {};
        let anchor = "";
        let tags = "";
        try {
          const more = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${id}`, { headers, signal: AbortSignal.timeout(15e3) }).then((r) => r.json());
          anchor = more?.data?.anchor_info?.base_info?.uname ?? "";
          tags = more?.data?.room_info?.tags ?? "";
        } catch {
        }
        let chats = "";
        try {
          const hist = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${id}&room_type=0`, { headers, signal: AbortSignal.timeout(15e3) }).then((r) => r.json());
          chats = (hist?.data?.room ?? []).slice(-5).map((c) => `${c.nickname}\uFF1A${c.text}`).join("\n");
        } catch {
        }
        const live = d.live_status === 1 ? "\u6B63\u5728\u76F4\u64AD" : "\u6CA1\u5728\u64AD";
        let onStage = false;
        if (d.live_status === 1) {
          try {
            const pu = await fetch(
              `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${id}&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=web&ptype=8`,
              { headers, signal: AbortSignal.timeout(15e3) }
            ).then((r) => r.json());
            let flv = "";
            let hls = "";
            for (const s of pu?.data?.playurl_info?.playurl?.stream ?? []) {
              for (const f of s.format ?? []) {
                for (const c of f.codec ?? []) {
                  const ui = (c.url_info ?? [])[0];
                  if (!ui?.host) continue;
                  const url = `${ui.host}${c.base_url}${ui.extra ?? ""}`;
                  if (f.format_name === "ts" && !hls) hls = url;
                  if (f.format_name === "flv" && !flv) flv = url;
                }
              }
            }
            const src = flv || hls;
            if (src) onStage = await watchRoom(src, String(d.title ?? ""), 3, Number(id));
          } catch {
          }
        }
        return [
          `\u67E5\u623F ${id}${anchor ? `\uFF08\u4E3B\u64AD\uFF1A${anchor}\uFF09` : ""}`,
          `${live}\uFF1B\u6807\u9898\u300C${d.title ?? ""}\u300D`,
          `\u5206\u533A\uFF1A${d.area_name ?? ""}${tags ? `\uFF08${tags}\uFF09` : ""}\uFF1B\u4EBA\u6C14 ${d.online ?? 0}\uFF1B\u5173\u6CE8 ${d.attention ?? 0}`,
          chats ? `\u6700\u8FD1\u5F39\u5E55\uFF1A
${chats}` : "",
          onStage ? "\uFF08\u5BF9\u65B9\u753B\u9762\u5DF2\u7ECF\u653E\u5230\u821E\u53F0\u4E0A\u4E86\uFF0C\u6700\u591A 3 \u5206\u949F\u81EA\u52A8\u64A4\uFF1A\u8DDF\u5927\u5BB6\u8BF4\u4E00\u58F0\u300C\u53BB\u4E32\u4E2A\u95E8\u300D\u518D\u70B9\u8BC4\u3002\uFF09" : "",
          !onStage && live === "\u6B63\u5728\u76F4\u64AD" ? `\uFF08\u5BF9\u65B9\u5728\u64AD\uFF0C\u4F46\u753B\u9762\u6CA1\u62C9\u4E0A${lastRoomError ? `\uFF1A${lastRoomError}` : "\uFF1A\u6CA1\u62FF\u5230\u64AD\u653E\u5730\u5740"}\u2014\u2014\u8DDF\u89C2\u4F17\u8BF4\u4E00\u58F0\u753B\u9762\u6CA1\u62C9\u4E0A\uFF0C\u522B\u786C\u8BF4\u5728\u4E32\u95E8\u3002\uFF09` : "",
          !onStage && live === "\u6CA1\u5728\u64AD" ? "\uFF08\u5BF9\u65B9\u6CA1\u5728\u64AD\uFF0C\u5C31\u8DDF\u89C2\u4F17\u8BF4\u6251\u7A7A\u4E86\uFF09" : ""
        ].filter(Boolean).join("\n");
      } catch (err) {
        return `\u53BB ${id} \u67E5\u623F\u5931\u8D25\u4E86\uFF1A${err.message}`;
      }
    }
  })), "visit_room tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "story_begin",
    description: "\u5F00\u4E00\u7AE0\u300C\u89C2\u4F17\u5171\u521B\u8FDE\u7EED\u5267\u300D\uFF1A\u7ED9\u6807\u9898\u3001\u4E00\u4E2A\u95EE\u9898\u3001\u4E24\u4E2A\u9009\u9879\uFF1B\u89C2\u4F17\u5F39\u5E55\u53D1 1 \u6216 2 \u6295\u7968\uFF0C\u7968\u6570\u5B9E\u65F6\u663E\u793A\u5728\u821E\u53F0\u3002\u8DE8\u573A\u4FDD\u7559\u3002",
    parameters: {
      title: { type: "string", required: true, description: "\u8FD9\u4E00\u7AE0\u7684\u6807\u9898\uFF08\u7B80\u77ED\uFF09" },
      question: { type: "string", required: true, description: "\u7ED9\u89C2\u4F17\u7684\u9009\u62E9\u9898\uFF08\u4E00\u53E5\u8BDD\uFF09" },
      a: { type: "string", required: true, description: "\u9009\u9879 1\uFF08\u53D1 1 \u9009\u5B83\uFF09" },
      b: { type: "string", required: true, description: "\u9009\u9879 2\uFF08\u53D1 2 \u9009\u5B83\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const row = show.beginStory(
        String(args.title ?? "").slice(0, 20) || "\u65B0\u7684\u4E00\u7AE0",
        String(args.question ?? "").slice(0, 40),
        String(args.a ?? "").slice(0, 20),
        String(args.b ?? "").slice(0, 20)
      );
      return `\u7B2C ${row.chapter} \u7AE0\u300C${row.title}\u300D\u5F00\u597D\u4E86\uFF1A1 = ${row.option_a}\uFF0C2 = ${row.option_b}\u3002\u8DDF\u5927\u5BB6\u8BF4\u53D1 1 \u6216 2 \u6295\u7968\u3002`;
    }
  })), "story_begin tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "story_finish",
    description: "\u7ED3\u675F\u5F53\u524D\u8FD9\u4E00\u7AE0\uFF1A\u9009\u54EA\u4E2A\u5206\u652F\u3001\u8FD9\u4E00\u7AE0\u53D1\u751F\u4E86\u4EC0\u4E48\u5C0F\u7ED3\u3002\u7968\u6570\u4F1A\u88AB\u8BB0\u5F55\uFF0C\u4E0B\u4E00\u7AE0\u63A5\u7740\u6F14\u3002",
    parameters: {
      choice: { type: "string", enum: ["a", "b"], required: true, description: "\u9009\u4E2D\u7684\u5206\u652F" },
      summary: { type: "string", required: true, description: "\u8FD9\u4E00\u7AE0\u7684\u5C0F\u7ED3\uFF08\u53D1\u751F\u4EC0\u4E48\u3001\u89C2\u4F17\u600E\u4E48\u9009\u7684\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const choice = args.choice === "b" ? "b" : "a";
      const row = show.finishStory(choice, String(args.summary ?? "").slice(0, 200));
      if (!row) return "\u73B0\u5728\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u5267\u60C5\uFF1A\u5148\u7528 story_begin \u5F00\u4E00\u7AE0\u3002";
      return `\u7B2C ${row.chapter} \u7AE0\u7ED3\u675F\u4E86\uFF08\u7968\u6570 1:${row.votes_a} / 2:${row.votes_b}\uFF09\uFF0C\u9009\u7684\u662F ${choice === "a" ? row.option_a : row.option_b}\u3002`;
    }
  })), "story_finish tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "story_status",
    description: "\u770B\u73B0\u5728\u8FD9\u4E00\u7AE0\u5267\u60C5\u7684\u8FDB\u5EA6\uFF08\u6807\u9898\u3001\u9009\u9879\u3001\u7968\u6570\uFF09\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      const s = show.currentStory;
      if (!s) return "\u73B0\u5728\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u5267\u60C5\u3002";
      return `\u7B2C ${s.chapter} \u7AE0\u300C${s.title}\u300D\uFF1A${s.question}\uFF5C1 = ${s.option_a}\uFF08${s.votes_a} \u7968\uFF09\uFF5C2 = ${s.option_b}\uFF08${s.votes_b} \u7968\uFF09${s.resolved_at ? "\uFF08\u5DF2\u7ED3\u675F\uFF09" : ""}`;
    }
  })), "story_status tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "set_scene",
    description: "\u5267\u60C5\u6362\u573A\u666F\uFF1A\u628A\u821E\u53F0\u6574\u5C4F\u80CC\u666F\u6362\u6210 scenes \u91CC\u7684\u4E00\u5F20\u56FE\uFF08\u540D\u5B57 = ~/.dsh/dsh-live-farben/scenes/<\u540D\u5B57>.jpg\uFF09\u3002name \u7559\u7A7A\u5C31\u56DE\u5230\u6A21\u677F\u9ED8\u8BA4\u80CC\u666F\u3002",
    parameters: {
      name: { type: "string", description: "\u573A\u666F\u540D\uFF0C\u6BD4\u5982 street / night\uFF1B\u7559\u7A7A\u56DE\u9ED8\u8BA4\u80CC\u666F" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const name2 = String(args.name ?? "").trim();
      show.setScene(name2 || null);
      return name2 ? `\u821E\u53F0\u80CC\u666F\u6362\u6210\u300C${name2}\u300D\u4E86\u3002` : "\u821E\u53F0\u80CC\u666F\u56DE\u5230\u9ED8\u8BA4\u4E86\u3002";
    }
  })), "set_scene tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "book_list",
    description: "\u770B\u4E66\u67B6\u4E0A\u6709\u54EA\u4E9B\u4E66\uFF08\u53EA\u5217\u4E66\u540D\uFF09\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      const books = listBooks(join2(dataDir, "books"));
      if (!books.length) return "\u4E66\u67B6\u662F\u7A7A\u7684\uFF1A\u8BA9\u4E3B\u4EBA\u5F80 books/ \u76EE\u5F55\u653E\u4E66\uFF08\u6BCF\u672C\u4E00\u4E2A\u6587\u4EF6\u5939\uFF0Cmeta.json + book.txt\uFF09\u3002";
      return `\u4E66\u67B6\u4E0A\u6709 ${books.length} \u672C\uFF1A${books.map((b, i) => `${i + 1}. ${b.title}`).join("\uFF1B")}`;
    }
  })), "book_list tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "book_open",
    description: "\u6253\u5F00\u4E00\u672C\u4E66\u5F00\u59CB\u8BFB\uFF08\u63A5\u7740\u4E0A\u6B21\u7684\u8FDB\u5EA6\uFF1B\u8DE8\u573A\u4FDD\u7559\uFF09\u3002book \u586B\u4E66\u540D\u6216\u4E66\u540D\u7684\u4E00\u90E8\u5206\u3002",
    parameters: {
      book: { type: "string", required: true, description: "\u4E66\u540D\uFF08\u6216\u4E00\u90E8\u5206\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      if (!settings.bookMode) return "\u8BFB\u4E66\u4F1A\u73B0\u5728\u662F\u5173\u95ED\u7684\uFF1A\u522B\u5F00\u4E66\uFF0C\u4E5F\u522B\u63D0\u8BFB\u4E66\u4F1A\u3002";
      const query = String(args.book ?? "").trim();
      const books = listBooks(join2(dataDir, "books"));
      const found = books.find((b) => b.title.includes(query) || query.includes(b.title)) ?? books[0];
      if (!found) return "\u4E66\u67B6\u4E0A\u6CA1\u6709\u4E66\uFF1A\u8BA9\u4E3B\u4EBA\u5148\u5F80 books/ \u76EE\u5F55\u653E\u4E66\u3002";
      const book = loadBook(join2(dataDir, "books"), found.id);
      if (!book) return `\u300C${found.title}\u300D\u6253\u4E0D\u5F00\uFF08book.txt \u53EF\u80FD\u574F\u4E86\uFF09\u3002`;
      const opened = show.openBook(book);
      return `\u6253\u5F00\u300A${opened.chapterTitle ? book.title : book.title}\u300B\uFF1A\u5171 ${opened.total} \u7AE0\uFF0C\u73B0\u5728\u4ECE\u7B2C ${opened.chapter + 1} \u7AE0\u5F00\u59CB\uFF08\u4E0A\u6B21\u8BFB\u5230\u7B2C ${opened.para + 1} \u6BB5\uFF09\u3002\u8DDF\u5927\u5BB6\u8BF4\u4E00\u58F0\uFF0C\u7136\u540E\u5C31\u53EF\u4EE5 book_read \u8BFB\u4E86\u3002`;
    }
  })), "book_open tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "book_read",
    description: "\u8BFB\u63A5\u4E0B\u6765\u7684\u51E0\u6BB5\u4E66\uFF08\u9ED8\u8BA4 1 \u6BB5\uFF09\u3002\u8FD4\u56DE\u539F\u6587\u2014\u2014\u628A\u539F\u6587\u5F53\u6210\u4F60\u7684\u8BDD\u8BF4\u51FA\u6765\uFF08\u8FD9\u662F\u6717\u8BFB\uFF09\uFF0C\u8BFB\u5B8C\u505C\u4E0B\u6765\u8DDF\u89C2\u4F17\u804A\u51E0\u53E5\u3002",
    parameters: {
      count: { type: "number", description: "\u8BFB\u51E0\u6BB5\uFF0C\u9ED8\u8BA4 1\uFF1B\u4E00\u822C\u4E00\u6B21 1\uFF5E2 \u6BB5" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      if (!settings.bookMode) return "\u8BFB\u4E66\u4F1A\u73B0\u5728\u662F\u5173\u95ED\u7684\u3002";
      if (!show.currentBook) return "\u73B0\u5728\u6CA1\u5728\u8BFB\u4E66\uFF1A\u5148\u7528 book_open \u6253\u5F00\u4E00\u672C\u3002";
      const count = Math.max(1, Math.min(3, Number(args.count) || 1));
      const text2 = show.readParagraphs(count);
      if (!text2) return "\u8FD9\u672C\u4E66\u8BFB\u5B8C\u4E86\uFF1A\u8DDF\u5927\u5BB6\u8BF4\u8BFB\u5B8C\u4E86\uFF0C\u95EE\u95EE\u8981\u4E0D\u8981\u6362\u4E00\u672C\u3002";
      const now = show.currentBook;
      return `${text2}

\uFF08\u4EE5\u4E0A\u662F\u539F\u6587\uFF0C\u76F4\u63A5\u5FF5\u7ED9\u89C2\u4F17\u542C\uFF1B\u5FF5\u5B8C\u53EF\u4EE5\u804A\u4E24\u53E5\u3002\u8FDB\u5EA6\uFF1A\u7B2C ${(now?.chapter ?? 0) + 1} \u7AE0 ${now?.chapterTitle ?? ""}\uFF09`;
    }
  })), "book_read tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "book_jump",
    description: "\u8DF3\u5230\u67D0\u4E00\u7AE0\u7684\u5F00\u5934\u7EE7\u7EED\u8BFB\u3002",
    parameters: {
      chapter: { type: "number", required: true, description: "\u7B2C\u51E0\u7AE0\uFF08\u4ECE 1 \u5F00\u59CB\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      if (!settings.bookMode) return "\u8BFB\u4E66\u4F1A\u73B0\u5728\u662F\u5173\u95ED\u7684\u3002";
      if (!show.currentBook) return "\u73B0\u5728\u6CA1\u5728\u8BFB\u4E66\u3002";
      const ok = show.bookJump(Math.max(0, (Number(args.chapter) || 1) - 1));
      if (!ok) return "\u8DF3\u7AE0\u5931\u8D25\u3002";
      const now = show.currentBook;
      return `\u8DF3\u5230\u7B2C ${(now?.chapter ?? 0) + 1} \u7AE0\u300C${now?.chapterTitle ?? ""}\u300D\uFF0C\u672C\u4E66\u5171 ${now?.total ?? 0} \u7AE0\u3002`;
    }
  })), "book_jump tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "book_close",
    description: "\u6536\u8D77\u8BFB\u4E66\u4F1A\uFF0C\u821E\u53F0\u56DE\u5230\u5E73\u5E38\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      show.closeBook();
      return "\u8BFB\u4E66\u4F1A\u6536\u8D77\u6765\u4E86\u3002";
    }
  })), "book_close tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "book_find",
    description: "\u53BB\u516C\u7248\u4E66\u5E93\u627E\u4E00\u672C\u5B8C\u6574\u7684\u4E66\u5E76\u653E\u8FDB\u4E66\u67B6\u3002\u76EE\u524D\u652F\u6301 Project Gutenberg\uFF08\u82F1\u6587\u516C\u7248\u4E66\uFF09\uFF1B\u4E2D\u6587\u516C\u7248\u4E66\u6E90\u6682\u65F6\u8FDE\u4E0D\u4E0A\uFF0C\u627E\u4E0D\u5230\u5C31\u8BA9\u4E3B\u4EBA\u624B\u52A8\u653E\u3002",
    parameters: {
      query: { type: "string", required: true, description: "\u4E66\u540D\u6216\u5173\u952E\u8BCD\uFF08\u82F1\u6587\u6548\u679C\u6700\u597D\uFF09" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      if (!settings.bookMode) return "\u8BFB\u4E66\u4F1A\u73B0\u5728\u662F\u5173\u95ED\u7684\uFF0C\u4E0D\u7528\u53BB\u627E\u4E66\u3002";
      const query = String(args.query ?? "").trim();
      if (!query) return "query \u5FC5\u586B\u3002";
      try {
        const search = await fetch(`https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}`, {
          headers: { "User-Agent": "Mozilla/5.0 (dsh-live-farben)" },
          signal: AbortSignal.timeout(2e4)
        });
        const html = await search.text();
        const id = /\/ebooks\/(\d+)/.exec(html)?.[1];
        if (!id) return `\u516C\u7248\u4E66\u5E93\u91CC\u6CA1\u641C\u5230\u300C${query}\u300D\uFF1A\u8DDF\u89C2\u4F17\u8BF4\u627E\u4E0D\u5230\uFF0C\u6216\u8005\u8BA9\u4E3B\u4EBA\u624B\u52A8\u653E\u4E66\u3002`;
        const titleMatch = /<span class="title">([^<]+)<\/span>/.exec(html);
        const title = (titleMatch?.[1] ?? query).trim();
        const txt = await fetch(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, {
          headers: { "User-Agent": "Mozilla/5.0 (dsh-live-farben)" },
          signal: AbortSignal.timeout(6e4)
        });
        if (!txt.ok) return `\u627E\u5230\u4E86\u300A${title}\u300B\u4F46\u6B63\u6587\u4E0B\u8F7D\u5931\u8D25\uFF08${txt.status}\uFF09\uFF0C\u6362\u4E00\u672C\u5427\u3002`;
        const raw = await txt.text();
        const bookId = `gut-${id}`;
        const chapters = [{ title: "\u6B63\u6587", text: raw.slice(0, 4e5) }];
        saveBook(join2(dataDir, "books"), { id: bookId, title, chapters });
        return `\u627E\u5230\u4E86\u300A${title}\u300B\uFF08Project Gutenberg #${id}\uFF09\uFF0C\u5DF2\u7ECF\u653E\u8FDB\u4E66\u67B6\uFF08id=${bookId}\uFF09\u3002\u7528 book_open(book="${title}") \u6253\u5F00\u5C31\u80FD\u8BFB\u3002`;
      } catch (err) {
        return `\u53BB\u516C\u7248\u4E66\u5E93\u627E\u4E66\u5931\u8D25\uFF1A${err.message}\u3002\u8DDF\u89C2\u4F17\u8BF4\u8FD9\u6B21\u6CA1\u627E\u5230\uFF0C\u8BA9\u4E3B\u4EBA\u624B\u52A8\u653E\u4E66\u4E5F\u884C\u3002`;
      }
    }
  })), "book_find tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "poll_start",
    description: "\u5F00\u4E00\u4E2A\u6295\u7968\uFF1A\u89C2\u4F17\u5F39\u5E55\u53D1 1/2/3 \u6295\u7968\uFF0C\u821E\u53F0\u663E\u793A\u7968\u6570\u548C\u5012\u8BA1\u65F6\uFF0C\u5230\u70B9\u81EA\u52A8\u7ED3\u7B97\u5E76\u628A\u7ED3\u679C\u544A\u8BC9\u4F60\u3002",
    parameters: {
      question: { type: "string", required: true, description: "\u95EE\u9898\uFF08\u4E00\u53E5\u8BDD\uFF09" },
      options: { type: "string", required: true, description: "\u9009\u9879\uFF0C\u7528\u300C/\u300D\u6216\u9017\u53F7\u5206\u9694\uFF0C\u6700\u591A 4 \u4E2A" },
      seconds: { type: "number", description: "\u6295\u591A\u4E45\uFF0C\u9ED8\u8BA4 60 \u79D2" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const options = String(args.options ?? "").split(/[\/,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
      if (!options.length) return "options \u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u9009\u9879\u3002";
      const poll = show.startPoll(String(args.question ?? "").slice(0, 40), options, Number(args.seconds) || 60);
      return `\u6295\u7968\u5F00\u597D\u4E86\uFF1A\u300C${poll.question}\u300D${options.map((o, i) => `${i + 1}=${o}`).join("\uFF0C")}\uFF0C${Math.round((poll.endsAt - Date.now()) / 1e3)} \u79D2\u540E\u7ED3\u7B97\u3002\u8DDF\u5927\u5BB6\u8BF4\u53D1\u6570\u5B57\u6295\u7968\u3002`;
    }
  })), "poll_start tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "poll_result",
    description: "\u770B\u5F53\u524D/\u4E0A\u4E00\u6B21\u6295\u7968\u7684\u7ED3\u679C\u548C\u7968\u6570\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      return show.pollResult ?? "\u73B0\u5728\u6CA1\u6709\u6295\u7968\u3002";
    }
  })), "poll_result tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "opening_vote",
    description: "\u5F00\u573A\u6295\u7968\uFF1A\u8BA9\u89C2\u4F17\u9009\u4ECA\u5929\u5148\u5E72\u4EC0\u4E48\uFF08\u70B9\u64AD\u89C6\u9891 / \u968F\u4FBF\u804A\u804A\uFF09\u3002\u5F00\u64AD\u7B2C\u4E00\u4EF6\u4E8B\u5C31\u8C03\u5B83\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      show.startPoll("\u4ECA\u5929\u5148\u6765\u70B9\u4EC0\u4E48\uFF1F", ["\u70B9\u64AD\u89C6\u9891", "\u968F\u4FBF\u804A\u804A"], 60);
      return "\u5F00\u573A\u6295\u7968\u5F00\u597D\u4E86\uFF1A1 = \u70B9\u64AD\u89C6\u9891\uFF0C2 = \u968F\u4FBF\u804A\u804A\uFF0C60 \u79D2\u3002\u8DDF\u5927\u5BB6\u8BF4\u53D1 1 \u6216 2\uFF1B\u7ED3\u679C\u51FA\u6765\u6211\u4F1A\u544A\u8BC9\u4F60\u3002";
    }
  })), "opening_vote tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "watch_video",
    description: "\u770B\u4E00\u4E2A B \u7AD9\u89C6\u9891\uFF1A\u8BE6\u60C5\uFF08\u6807\u9898\u3001UP \u4E3B\u3001\u65F6\u957F\u3001\u64AD\u653E\u70B9\u8D5E\u6295\u5E01\u6536\u85CF\u3001\u6807\u7B7E\u3001\u7B80\u4ECB\u3001\u5206 P\uFF09\u548C\u5E26\u65F6\u95F4\u7684\u5B57\u5E55\u3002\u5B57\u5E55\u4E00\u6B21\u7ED9\u4E00\u6BB5\uFF0C\u957F\u7684\u7528 from \u63A5\u7740\u5F80\u540E\u770B\uFF1B\u89C6\u9891\u6CA1\u6709\u5B57\u5E55\u65F6\u4F1A\u542C\u4E00\u904D\u3001\u628A\u8BF4\u7684\u8BDD\u5199\u4E0B\u6765\uFF08\u8981\u51E0\u79D2\u5230\u5341\u51E0\u79D2\uFF09\u3002",
    parameters: {
      video: { type: "string", required: true, description: "BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" },
      part: { type: "number", description: "\u591A P \u89C6\u9891\u7684\u7B2C\u51E0 P\uFF0C\u9ED8\u8BA4 1" },
      from: { type: "number", description: "\u4ECE\u7B2C\u51E0\u79D2\u7684\u5B57\u5E55\u5F00\u59CB\u770B\uFF08\u63A5\u7740\u770B\u65F6\u586B\u4E0A\u6B21\u7ED9\u7684\u6570\uFF09\uFF1B\u586B\u4E86\u5C31\u53EA\u7ED9\u5B57\u5E55" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const found = await withDeadline(findVideo(args.video, args.part));
      if (!found) return "\u67E5\u4E86 20 \u79D2\u8FD8\u6CA1\u67E5\u5230\uFF1A\u76F4\u63A5\u8DDF\u89C2\u4F17\u8BF4\u6CA1\u627E\u5230\uFF0C\u522B\u53CD\u590D\u8BD5\u540C\u4E00\u4E2A\u89C6\u9891\u3002";
      if (typeof found === "string") return found;
      const { info, part } = found;
      const from = seconds(args.from);
      show.toolCall("watch_video", `\u300C${info.title.slice(0, 16)}\u300D`, `\u5728\u770B\u300C${info.title.slice(0, 20)}\u300D`);
      library.view(info, part, libraryView("watch", from));
      if (!library.hasDanmaku(info, part)) void videoDanmaku(info, part).catch(() => {
      });
      const sub = await officialSubtitles(info, part) ?? await listen(info, part, from);
      const partArg = part.page > 1 ? `, part=${part.page}` : "";
      const subtitle = subtitleText(info, part, sub, from, partArg);
      const noLogin = !sub && !await videos.loggedIn() ? "\uFF08\u5F00\u64AD\u8D26\u53F7\u6CA1\u767B\u5F55\uFF1AB \u7AD9\u7684 AI \u5B57\u5E55\u8981\u767B\u5F55\u624D\u7ED9\uFF09" : "";
      if (from > 0) return `\u300C${info.title}\u300D${part.page > 1 ? `P${part.page} ` : ""}\u4ECE ${clock(from)} \u8D77\uFF1A
${subtitle}${noLogin}`;
      return `${infoText(info, part)}

${subtitle}${noLogin}`;
    }
  })), "watch_video tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "play_video",
    description: "\u5728\u76F4\u64AD\u95F4\u7684\u821E\u53F0\u4E0A\u653E\u4E00\u4E2A B \u7AD9\u89C6\u9891\u7ED9\u5927\u5BB6\u770B\uFF1A\u821E\u53F0\u6362\u6210\u770B\u89C6\u9891\u7684\u5E03\u5C40\uFF0C\u653E\u5B8C\u6362\u56DE\u6765\uFF0C\u653E\u5B8C\u4E86\u4F1A\u544A\u8BC9\u4F60\u3002\u9ED8\u8BA4\u4ECE\u5934\u653E\u5230\u7ED3\u5C3E\uFF0C\u53EF\u4EE5\u6307\u5B9A\u4ECE\u54EA\u91CC\u5F00\u59CB\u3001\u653E\u591A\u4E45\u3002\u8FD9\u4E2A\u5DE5\u5177\u9A6C\u4E0A\u8FD4\u56DE\uFF08\u4F60\u56DE\u4E00\u53E5\u300C\u6211\u53BB\u627E\u300D\u5C31\u884C\uFF09\uFF0C\u627E\u89C6\u9891\u3001\u62FF\u64AD\u653E\u5730\u5740\u90FD\u5728\u540E\u53F0\u505A\uFF0C\u6240\u4EE5\u522B\u7B49\u5B83\u2014\u2014\u8BF4\u5B8C\u7EE7\u7EED\u56DE\u522B\u7684\u5F39\u5E55\u3001\u804A\u522B\u7684\uFF0C\u627E\u5230/\u653E\u4E0A\u4E86\u4F1A\u53E6\u5916\u544A\u8BC9\u4F60\u3002\u627E\u8D85\u8FC7 20 \u79D2\u8FD8\u6CA1\u7ED3\u679C\u5C31\u4E0D\u7528\u518D\u627E\u4E86\uFF1A\u76F4\u63A5\u8BF4\u6CA1\u627E\u5230\uFF0C\u7B49\u89C2\u4F17\u6362\u4E2A\u5173\u952E\u8BCD\u6216\u7ED9 BV \u53F7\u3002\u653E\u7684\u65F6\u5019\u4F60\u7167\u5E38\u8BF4\u8BDD\u3001\u56DE\u5F39\u5E55\uFF0C\u4F60\u8BF4\u8BDD\u65F6\u89C6\u9891\u58F0\u97F3\u4F1A\u81EA\u52A8\u8C03\u5C0F\u3002\u6B63\u5728\u653E\u7684\u4E0D\u4F1A\u88AB\u6362\u6389\uFF1A\u4F1A\u6392\u8FDB\u70B9\u64AD\u961F\u5217\uFF0C\u653E\u5B8C\u81EA\u52A8\u63A5\u7740\u653E\uFF0C\u821E\u53F0\u4E0A\u7684\u6392\u961F\u680F\u4F1A\u663E\u793A\u3002\u821E\u53F0\u53EA\u5728\u8FD9\u4E2A\u5DE5\u5177\u88AB\u8C03\u7528\u65F6\u5F00\u59CB\u653E\uFF1A\u4F60\u8BF4\u300C\u6211\u653E\u4E00\u4E0B\u300D\u53EA\u662F\u5FF5\u7ED9\u5927\u5BB6\u542C\uFF0C\u89C6\u9891\u8981\u9760\u8FD9\u6B21\u8C03\u7528\u624D\u51FA\u73B0\u5728\u821E\u53F0\u4E0A\u3002",
    parameters: {
      video: { type: "string", required: true, description: "BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5" },
      part: { type: "number", description: "\u591A P \u89C6\u9891\u7684\u7B2C\u51E0 P\uFF0C\u9ED8\u8BA4 1" },
      from: { type: "string", description: "\u4ECE\u54EA\u91CC\u5F00\u59CB\u653E\uFF1A\u79D2\u6570\u6216\u300C\u5206:\u79D2\u300D\uFF0C\u9ED8\u8BA4 0" },
      seconds: { type: "number", description: "\u653E\u591A\u5C11\u79D2\uFF0C\u4E0D\u586B\u5C31\u653E\u5230\u7ED3\u5C3E" },
      by: { type: "string", description: "\u70B9\u8FD9\u4E2A\u89C6\u9891\u7684\u89C2\u4F17\u540D\u5B57\uFF08\u89C2\u4F17\u70B9\u7684\u5C31\u586B\u4ED6\uFF0C\u4F60\u81EA\u5DF1\u627E\u7684\u5C31\u522B\u586B\uFF09" },
      jump: { type: "boolean", description: "\u63D2\u961F\uFF1A\u8230\u957F/\u63D0\u7763/\u603B\u7763\u6216\u8005\u9192\u76EE\u7559\u8A00\u70B9\u7684\uFF0C\u586B true\uFF0C\u4E0B\u4E00\u4E2A\u5C31\u653E\u5B83\uFF1B\u666E\u901A\u5F39\u5E55\u522B\u586B" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      const text2 = String(args.video ?? "").trim();
      if (!text2) return "\u7ED9\u6211\u4E00\u4E2A BV \u53F7\u3001av \u53F7\u6216\u89C6\u9891\u94FE\u63A5\u3002";
      const who = String(args.by ?? "").trim().slice(0, 20) || "\u5979\u81EA\u5DF1";
      void (async () => {
        try {
          const found = await withDeadline(findVideo(args.video, args.part));
          if (!found) {
            show.notifyInbox([`\u627E\u300C${text2.slice(0, 20)}\u300D\u8D85\u8FC7 20 \u79D2\u8FD8\u6CA1\u7ED3\u679C\uFF1A\u8DDF\u89C2\u4F17\u8BF4\u6CA1\u627E\u5230\uFF0C\u522B\u518D\u7EE7\u7EED\u641C\uFF0C\u7B49\u4ED6\u4EEC\u6362\u4E2A\u540D\u5B57\u6216\u7ED9 BV \u53F7\u3002`]);
            return;
          }
          if (typeof found === "string") {
            show.notifyInbox([found]);
            return;
          }
          const { info, part } = found;
          if (part.durationSec && part.durationSec > MAX_VIDEO_SEC) {
            const level = show.medalLevel(who);
            if (level <= LONG_VIDEO_FAN_LEVEL) {
              show.notifyInbox([`\u300C${info.title}\u300D\u6709 ${Math.round(part.durationSec / 60)} \u5206\u949F\uFF0C\u8D85\u8FC7 20 \u5206\u949F\u4E86\u2014\u2014${LONG_VIDEO_NOTE}\uFF08${who} \u73B0\u5728${level ? `\u662F\u7C89\u4E1D\u724C ${level} \u7EA7` : "\u8FD8\u6CA1\u6709\u7C89\u4E1D\u724C"}\uFF0C\u64AD\u4E0D\u4E86\uFF09`]);
              return;
            }
            show.notifyInbox([`\u300C${info.title}\u300D\u6709 ${Math.round(part.durationSec / 60)} \u5206\u949F\uFF0C\u7C89\u4E1D\u56E2 ${level} \u7EA7\u53EF\u4EE5\u70B9\uFF1A\u5DF2\u7ECF\u6392\u4E0A\u4E86\u3002\u95EE\u4E00\u53E5 ta \u8981\u4E0D\u8981\u4F18\u5148\u64AD\u653E\uFF0Cta \u540C\u610F\u5C31\u7528 priority_play(by="${who}") \u63D2\u5230\u4E0B\u4E00\u4E2A\u3002`]);
          }
          const from = Math.floor(seconds(args.from));
          if (part.durationSec && from >= part.durationSec) {
            show.notifyInbox([`\u300C${info.title}\u300D\u4E00\u5171\u53EA\u6709 ${clock(part.durationSec)}\uFF0C\u4ECE ${clock(from)} \u5F00\u59CB\u5C31\u6CA1\u6709\u4E86\u3002`]);
            return;
          }
          const asked = Number(args.seconds) > 0 ? Math.max(5, Number(args.seconds)) : null;
          const end = part.durationSec || from + (asked ?? PLAY_UNKNOWN_SEC);
          const until = asked ? Math.min(end, from + asked) : end;
          const url = await withDeadline(videos.playUrl(info.bvid, part.cid), 4e4);
          if (!url) {
            show.notifyInbox([`\u300C${info.title}\u300D\u7684\u64AD\u653E\u5730\u5740 40 \u79D2\u6CA1\u53D6\u5230\uFF08\u53EF\u80FD\u7F51\u7EDC\u6162\u3001\u4ED8\u8D39\u6216\u5730\u533A\u9650\u5236\uFF09\uFF1A\u8DDF\u89C2\u4F17\u8BF4\u8FD9\u4E2A\u653E\u4E0D\u4E86\uFF0C\u6362\u4E00\u4E2A\u3002`]);
            return;
          }
          show.notifyInbox([`\u300C${info.title}\u300D\u6B63\u5728\u62C9\u5230\u672C\u5730\uFF0C\u62C9\u597D\u5C31\u653E\uFF08\u8FD9\u6837\u4E0D\u4F1A\u5361\uFF09\u3002`]);
          const cached = await withDeadline(cacheVideo(join2(dataDir, "media"), info.bvid, url), 25e3);
          if (cached) pruneVideos(join2(dataDir, "media"));
          const localSrc = cached ? `/media?id=${info.bvid}` : void 0;
          show.toolCall("play_video", `\u300C${info.title.slice(0, 16)}\u300D`);
          const notes = new VideoNotes(from, until, {
            subtitles: () => officialSubtitles(info, part),
            listen: (at) => listen(info, part, at),
            danmaku: () => videoDanmaku(info, part)
          }, (message) => hooks.log("warn", message));
          const view = library.view(info, part, libraryView("play", from, until));
          const queued = show.queueVideo(
            { bvid: info.bvid, title: info.title, up: info.up.name, url, fromSec: from, untilSec: until, durationSec: part.durationSec, ...localSrc ? { src: localSrc } : {} },
            notes,
            (end2) => library.finish(info, part, view, { playedSec: end2.playedSec, end: end2.how, said: end2.said }),
            who,
            args.jump === true
          );
          if (queued.queued) {
            show.notifyInbox([`\u300C${info.title}\u300D\u5DF2\u7ECF\u6392\u8FDB\u70B9\u64AD\u961F\u5217\uFF0C\u7B2C ${queued.position} \u4F4D\uFF08${who} \u70B9\u7684\uFF09\uFF0C\u653E\u5B8C\u524D\u9762\u7684\u5C31\u63A5\u5B83\uFF1B\u5230\u5B83\u4E86\u4F1A\u544A\u8BC9\u4F60\u3002`]);
            return;
          }
          const { video, replaced } = queued;
          const outcome = show.stage.watchers ? await show.player.waitStart(video.id, PLAY_CONFIRM_MS) : "playing";
          if (outcome === "error") {
            show.notifyInbox([`\u300C${info.title}\u300D\u6CA1\u653E\u51FA\u6765\uFF08\u821E\u53F0\u52A0\u8F7D\u4E0D\u4E86\u8FD9\u4E2A\u89C6\u9891${video.error ? `\uFF1A${video.error}` : ""}\uFF09\uFF0C\u53EF\u4EE5\u6362\u4E00\u4E2A\u3002`]);
            return;
          }
          const lines = [
            outcome === "pending" ? `\u821E\u53F0\u8FD8\u5728\u52A0\u8F7D\u300C${info.title}\u300D\uFF08UP ${info.up.name}\uFF0C${clock(from)}\u2013${clock(until)}\uFF09\uFF0C\u653E\u5F97\u51FA\u6765\u5C31\u63A5\u7740\u653E\uFF0C\u653E\u4E0D\u51FA\u6765\u4F1A\u544A\u8BC9\u4F60\u3002` : `\u821E\u53F0\u4E0A\u5DF2\u7ECF\u5728\u653E\u300C${info.title}\u300D\uFF08UP ${info.up.name}\uFF09\uFF0C${clock(from)}\u2013${clock(until)}\uFF0C\u5171 ${clock(until - from)}\u3002`
          ];
          if (replaced) lines.push(`\uFF08\u6362\u6389\u4E86\u6B63\u5728\u653E\u7684\u300C${replaced.title}\u300D\uFF09`);
          show.notifyInbox(lines);
        } catch (err) {
          hooks.log("warn", `\u70B9\u64AD\u5931\u8D25\uFF1A${err.message}`);
          show.notifyInbox([`\u70B9\u64AD\u300C${text2.slice(0, 20)}\u300D\u6CA1\u6210\uFF1A${err.message}`]);
        }
      })();
      return `\u6536\u5230\uFF0C\u6211\u53BB\u627E\u300C${text2.slice(0, 20)}\u300D\uFF0C\u627E\u5230\u5C31\u653E\uFF1B\u653E\u4E0A\u4E86\u518D\u8DDF\u4F60\u8BF4\u4E00\u58F0\u3002`;
    }
  })), "play_video tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "stop_video",
    description: "\u505C\u4E0B\u821E\u53F0\u4E0A\u6B63\u5728\u653E\u7684\u89C6\u9891\uFF0C\u821E\u53F0\u6362\u56DE\u804A\u5929\u7684\u5E03\u5C40\u3002",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() {
      show.toolCall("stop_video", "");
      const stopped = show.stopVideo();
      if (!stopped) return "\u73B0\u5728\u6CA1\u5728\u653E\u89C6\u9891\u3002";
      return `\u505C\u4E86\u300C${stopped.video.title}\u300D\uFF08\u653E\u4E86 ${clock(stopped.playedSec)}\uFF09\uFF0C\u821E\u53F0\u6362\u56DE\u4E86\u804A\u5929\u7684\u5E03\u5C40\u3002`;
    }
  })), "stop_video tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "game_side",
    description: "\u89C2\u4F17\u6216\u4E3B\u4EBA\u60F3\u8BA9\u4F60\u5728\u6E38\u620F\u91CC\u505A\u4EC0\u4E48\u3001\u6216\u8005\u4F60\u8981\u7B54\u5E94\u6E38\u620F\u91CC\u7684\u4E8B\uFF1A\u5199\u4E0B\u600E\u4E48\u505A\uFF0C\u4EA4\u7ED9\u6E38\u620F\u91CC\u7684\u4F60\u3002\u4ED6\u4EEC\u7684\u539F\u8BDD\u4F1A\u4E00\u8D77\u4EA4\u8FC7\u53BB\uFF0C\u7531\u6E38\u620F\u91CC\u7684\u4F60\u70B9\u540D\u56DE\u4ED6\u3001\u518D\u53BB\u505A\uFF1B\u4ECE\u8C03\u8FD9\u4E2A\u5DE5\u5177\u7684\u90A3\u6761\u6D88\u606F\u8D77\uFF0C\u8FD9\u4E00\u8F6E\u4F60\u5199\u7684\u8BDD\u90FD\u4E0D\u4F1A\u5FF5\u51FA\u6765\uFF08\u8C03\u4E4B\u524D\u5199\u7684\u4F1A\u5FF5\uFF09\u3002",
    parameters: {
      message: { type: "string", required: true, description: "\u6E38\u620F\u91CC\u63A5\u4E0B\u6765\u600E\u4E48\u505A\uFF0C\u6BD4\u5982\u300C\u5F00 Minecraft \u63A5\u7740\u73A9\uFF0C\u76EE\u6807\u4E00\u8EAB\u94BB\u77F3\u88C5\u5907\u300D\u300C\u5929\u9ED1\u4E86\uFF0C\u5148\u6316\u6D1E\u8EB2\u8D77\u6765\u300D" },
      who: { type: "string", description: "\u8FD9\u662F\u54EA\u4F4D\u89C2\u4F17\u70B9\u7684\u5355\uFF08\u540D\u5B57\uFF0C\u51E0\u4F4D\u7528\u987F\u53F7\u9694\u5F00\uFF09\uFF1A\u8BB0\u8FDB\u70B9\u5355\u961F\u5217\u3001\u89C2\u4F17\u5728\u70B9\u5355\u680F\u91CC\u770B\u5F97\u5230\uFF1B\u8FD9\u4EF6\u4E8B\u91CC\u53EA\u6709\u4E00\u4F4D\u89C2\u4F17\u65F6\u53EF\u4EE5\u4E0D\u586B" }
    },
    output: stringOut,
    async execute(args) {
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message) return "\u6CA1\u5199\u63A5\u4E0B\u6765\u600E\u4E48\u73A9\u3002";
      show.toolCall("game_side", message.slice(0, 40));
      if (!show.toGameLine(message, typeof args.who === "string" ? args.who : "")) return "\u8FD9\u573A\u76F4\u64AD\u6CA1\u5F00\u6E38\u620F\uFF08\u5F00\u64AD\u65F6\u6CA1\u51C6\u5907\u6E38\u620F\uFF09\uFF0C\u73A9\u4E0D\u4E86\u3002";
      return "\u4EA4\u8FC7\u53BB\u4E86\uFF1A\u6E38\u620F\u91CC\u7684\u4F60\u4F1A\u56DE\u4ED6\u3001\u53BB\u505A\u3002\u8FD9\u4E00\u8F6E\u63A5\u4E0B\u6765\u5199\u7684\u8BDD\u4E0D\u4F1A\u5FF5\u51FA\u6765\u3002";
    }
  })), "game_side tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "game_state",
    description: "\u67E5\u4F60\u5728\u6E38\u620F\u91CC\u73B0\u5728\u7684\u5B8C\u6574\u60C5\u51B5\uFF1A\u4F4D\u7F6E\u3001\u8840\u91CF\u3001\u9965\u997F\u3001\u5B8C\u6574\u80CC\u5305\u3001\u8EAB\u4F53\u5728\u505A\u4EC0\u4E48\u3001\u521A\u53D1\u751F\u4E86\u4EC0\u4E48\u3002\u89C2\u4F17\u95EE\u6E38\u620F\u91CC\u7684\u7EC6\u8282\u65F6\u5148\u67E5\u4E00\u4E0B\u518D\u56DE\u3002",
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall("game_state", "", "\u5728\u770B\u6E38\u620F\u91CC\u7684\u60C5\u51B5");
      const state = show.gameState();
      return state ? `\uFF08${state.ageSec} \u79D2\u524D\uFF0C\u6E38\u620F\u91CC\u6700\u8FD1\u4E00\u4E2A\u65F6\u523B\uFF09
${state.text}` : "\u6E38\u620F\u73B0\u5728\u6CA1\u5F00\u3002";
    }
  })), "game_state tool");
}
export {
  HandOffs,
  apply,
  inject,
  momentSummary,
  name
};
//# sourceMappingURL=agent.js.map
