import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  DEFAULT_BOARD,
  GUEST_VOICE,
  SECRETS,
  SIMULATED_PREFIX,
  agentReady,
  asr,
  broadcast,
  checkObs,
  connectObs,
  cookie,
  currentCharacter,
  currentMoods,
  dm,
  hooks,
  packs,
  placeGame,
  pollQrLogin,
  prepareSpeech,
  publishBoard,
  publishNotice,
  server,
  settings,
  show,
  social,
  speakable,
  splitByMood,
  startQrLogin,
  takeLive,
  updateSettings,
  whoIs
} from "./chunks/chunk-XZAAOCEF.js";

// src/dsh/index.ts
var name = "dsh-live-farben";
var inject = ["connection"];
var json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
var fail = (message, status = 400) => json({ ok: false, error: message }, status);
async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
function state() {
  return {
    ok: true,
    show: show.status(),
    broadcast: broadcast.status(),
    settings: { ...settings, stageToken: void 0 },
    stageUrl: server.url,
    characters: packs.list("characters"),
    templates: packs.list("templates"),
    asr: { available: asr.available },
    defaultBoard: DEFAULT_BOARD
  };
}
function cleanPace(raw) {
  const sec = (v) => v === "" || v === null || v === void 0 || !Number.isFinite(Number(v)) ? void 0 : Math.max(0, Math.min(600, Math.round(Number(v))));
  const welcome = raw.welcomeSec === "off" ? "off" : sec(raw.welcomeSec);
  const thanks = sec(raw.thanksSec), follow = sec(raw.followSec);
  const picks = sec(raw.chatPicks);
  return {
    ...welcome !== void 0 ? { welcomeSec: welcome } : {},
    ...thanks !== void 0 ? { thanksSec: thanks } : {},
    ...follow !== void 0 ? { followSec: follow } : {},
    ...picks !== void 0 ? { chatPicks: Math.max(1, Math.min(5, picks)) } : {}
  };
}
function cleanBlocked(raw) {
  const out = /* @__PURE__ */ new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const b = item;
    const uid = String(b.uid ?? "").trim();
    if (!/^\d{1,20}$/.test(uid)) continue;
    out.set(uid, { uid, name: String(b.name ?? "").trim().slice(0, 40), why: String(b.why ?? "").trim().slice(0, 200), at: Number(b.at) || Date.now() });
  }
  return [...out.values()];
}
function gameSource(value) {
  const v = value;
  const web = (x) => typeof x === "string" && /^https?:\/\//.test(x);
  if (v && web(v.url)) return { url: v.url };
  if (v && typeof v.window === "string" && v.window) return { window: v.window, ...web(v.overlay) ? { overlay: v.overlay } : {} };
  return null;
}
var simSeq = 0;
function simulated(input) {
  const name2 = (input.name ?? "").trim() || "\u6A21\u62DF\u89C2\u4F17";
  const user = { id: `${SIMULATED_PREFIX}${name2}`, name: name2, ...input.guard ? { guardLevel: input.guard } : {} };
  const base = { id: `sim-${Date.now()}-${++simSeq}`, platform: "bilibili", ts: Date.now(), user };
  switch (input.kind) {
    case "chat":
      return input.text?.trim() ? { ...base, kind: "chat", text: input.text.trim() } : null;
    case "gift":
      return { ...base, kind: "gift", giftName: input.gift || "\u5C0F\u82B1\u82B1", count: input.count ?? 1, valueYuan: input.yuan ?? 0.1 };
    case "superchat":
      return input.text?.trim() ? { ...base, kind: "superchat", text: input.text.trim(), valueYuan: input.yuan ?? 30 } : null;
    case "membership":
      return { ...base, kind: "membership", levelName: "\u8230\u957F", level: 3, count: 1, valueYuan: 138 };
    case "enter":
      return { ...base, kind: "enter" };
    case "follow":
      return { ...base, kind: "follow" };
    default:
      return null;
  }
}
var waitingOffair = null;
var ENDING_SCENE_MS = 17e3;
var RESUME_WITHIN_MS = 10 * 6e4;
async function resumeLive(ctx, stopped) {
  const saved = takeLive();
  if (!saved) return;
  if (Date.now() - saved.at > RESUME_WITHIN_MS) {
    show.closeStale(saved);
    return;
  }
  const deadline = Date.now() + 6e4;
  let resumed = false;
  while (!stopped() && Date.now() < deadline) {
    const controller = ctx.get?.("sessionController");
    if (controller?.agents?.resolveAgent) {
      const result = await controller.agents.resolveAgent(saved.sessionId).catch((err) => ({ error: err }));
      if (!("error" in result)) {
        resumed = true;
        break;
      }
      console.warn(`[dsh-live-farben] \u6062\u590D\u5979\u7684\u4F1A\u8BDD\u5931\u8D25\uFF1A${String(result.error?.message ?? result.error)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2e3));
  }
  if (!resumed || stopped()) {
    show.closeStale(saved);
    return;
  }
  if (saved.gameSessionId) {
    const controller = ctx.get?.("sessionController");
    const result = await controller.agents.resolveAgent(saved.gameSessionId).catch((err) => ({ error: err }));
    if ("error" in result) {
      console.warn(`[dsh-live-farben] \u6062\u590D\u6E38\u620F\u7EBF\u7684\u4F1A\u8BDD\u5931\u8D25\uFF1A${String(result.error?.message ?? result.error)}`);
      saved.gameSessionId = void 0;
      saved.playing = void 0;
    }
  }
  while (!stopped() && Date.now() < deadline && !agentReady()) await new Promise((r) => setTimeout(r, 500));
  if (saved.roomId) show.connect(saved.roomId, await cookie(), settings.ownRooms.includes(saved.roomId));
  show.resumeLive(saved);
  if (saved.broadcasting && saved.roomId) await broadcast.adopt(saved.roomId);
  const pushing = saved.broadcasting ? `\uFF0C\u63A8\u6D41${broadcast.streaming ? "\u63A5\u4E0A\u4E86" : "\u6CA1\u63A5\u4E0A\uFF08OBS \u5DF2\u7ECF\u4E0D\u5728\u63A8\u4E86\uFF09"}` : "\uFF08\u5F69\u6392\uFF0C\u6CA1\u5728\u63A8\u6D41\uFF09";
  console.warn(`[dsh-live-farben] \u63A5\u7740\u64AD\uFF1A\u4F1A\u8BDD ${saved.sessionId}\uFF0C\u65AD\u4E86 ${Math.round((Date.now() - saved.at) / 1e3)} \u79D2${pushing}`);
}
function apply(ctx) {
  ctx.effect(() => {
    server.start().catch((err) => console.warn(`[dsh-live-farben] \u821E\u53F0\u670D\u52A1\u5668\u8D77\u4E0D\u6765\uFF08\u7AEF\u53E3 ${settings.stagePort}\uFF09\uFF1A${err.message}`));
    return () => server.stop();
  }, "dsh-live-farben stage server");
  ctx.effect(() => () => show.dispose(), "dsh-live-farben show");
  ctx.effect(() => {
    let stopped = false;
    void resumeLive(ctx, () => stopped).catch((err) => console.warn(`[dsh-live-farben] \u63A5\u7740\u64AD\u5931\u8D25\uFF1A${err.message}`));
    return () => {
      stopped = true;
    };
  }, "dsh-live-farben resume");
  ctx.effect(() => () => asr.close(), "dsh-live-farben asr");
  ctx.provide("liveBody", {
    get onAir() {
      return show.isOnAir;
    },
    attention: (signal) => show.waitAttention(signal),
    showGame: (source) => show.showGame(gameSource(source))
  });
  ctx.effect(() => () => show.showGame(null), "dsh-live-farben game screen");
  const route = (path, methods, fetch, label) => ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: "buffered", fetch }), label);
  route("/api/dsh-live-farben/state", ["GET"], () => json(state()), "state");
  route("/api/dsh-live-farben/settings", ["POST"], async (request) => {
    const patch = await body(request);
    const next = {};
    if (patch.roomId !== void 0) {
      const room = Number(patch.roomId);
      if (!Number.isInteger(room) || room <= 0) return fail("\u623F\u95F4\u53F7\u8981\u662F\u6B63\u6574\u6570");
      next.roomId = room;
    }
    if (patch.character !== void 0) {
      if (!packs.character(String(patch.character))) return fail("\u6CA1\u6709\u8FD9\u4E2A\u89D2\u8272\u5305");
      next.character = String(patch.character);
    }
    if (patch.template !== void 0) {
      if (!packs.template(String(patch.template))) return fail("\u6CA1\u6709\u8FD9\u4E2A\u6A21\u677F");
      next.template = String(patch.template);
    }
    if (patch.voice !== void 0) next.voice = String(patch.voice).trim();
    if (patch.idleAfterSec !== void 0) next.idleAfterSec = Math.max(10, Math.min(600, Number(patch.idleAfterSec) || 45));
    if (patch.gameChatGapSec !== void 0) next.gameChatGapSec = Math.max(5, Math.min(120, Number(patch.gameChatGapSec) || 15));
    if (patch.pace !== void 0) next.pace = cleanPace({ ...settings.pace, ...patch.pace });
    if (patch.distillModel !== void 0) next.distillModel = String(patch.distillModel).trim() || settings.distillModel;
    if (patch.broadcast !== void 0) next.broadcast = !!patch.broadcast;
    if (patch.areaId !== void 0) next.areaId = patch.areaId ? Number(patch.areaId) : null;
    if (patch.liveTitle !== void 0) next.liveTitle = String(patch.liveTitle).slice(0, 40);
    if (patch.liveCover !== void 0) next.liveCover = String(patch.liveCover).trim().replace(/^"|"$/g, "");
    if (patch.pushProtocol !== void 0) next.pushProtocol = patch.pushProtocol === "rtmp" ? "rtmp" : "srt";
    if (patch.videoQuality !== void 0) next.videoQuality = patch.videoQuality === "720p" ? "720p" : "1080p";
    if (patch.encoder !== void 0) {
      const e = String(patch.encoder);
      next.encoder = e === "nvenc" || e === "qsv" || e === "x264" ? e : "auto";
    }
    if (patch.streamKbps !== void 0) next.streamKbps = Math.max(1e3, Math.min(12e3, Number(patch.streamKbps) || 4500));
    if (patch.asrPython !== void 0) next.asrPython = String(patch.asrPython).trim().replace(/^"|"$/g, "");
    if (patch.asrModel !== void 0) next.asrModel = String(patch.asrModel).trim() || "large-v3-turbo";
    if (patch.boardText !== void 0) next.boardText = String(patch.boardText).replace(/\r/g, "").slice(0, 1e3);
    if (patch.noticeText !== void 0) next.noticeText = String(patch.noticeText).replace(/\s+/g, " ").trim().slice(0, 200);
    if (patch.blocked !== void 0) next.blocked = cleanBlocked(patch.blocked);
    const own = patch.ownRoom;
    if (own !== void 0 && settings.roomId) {
      const rooms = new Set(settings.ownRooms);
      if (own) rooms.add(settings.roomId);
      else rooms.delete(settings.roomId);
      next.ownRooms = [...rooms];
      show.rememberViewers = own && show.status().roomId === settings.roomId;
    }
    const repaint = next.character && next.character !== settings.character || next.template && next.template !== settings.template;
    if (next.asrPython !== void 0 && next.asrPython !== settings.asrPython || next.asrModel !== void 0 && next.asrModel !== settings.asrModel) asr.close();
    updateSettings(next);
    if (next.boardText !== void 0) publishBoard();
    if (next.noticeText !== void 0) publishNotice();
    if (next.character) show.setNames(currentCharacter()?.names ?? []);
    if (repaint) show.stage.broadcast({ type: "reload" });
    if (next.template && show.gameSource) placeGame(show.gameSource);
    return json(state());
  }, "settings");
  route("/api/dsh-live-farben/connect", ["POST"], async () => {
    if (!settings.roomId) return fail("\u5148\u586B\u76F4\u64AD\u95F4\u623F\u95F4\u53F7");
    show.connect(settings.roomId, await cookie(), settings.ownRooms.includes(settings.roomId));
    return json(state());
  }, "connect");
  route("/api/dsh-live-farben/disconnect", ["POST"], () => {
    show.disconnect();
    return json(state());
  }, "disconnect");
  route("/api/dsh-live-farben/onair", ["POST"], async (request) => {
    const { sessionId, gameSessionId } = await body(request);
    if (!sessionId) return fail("\u7F3A\u5979\u76F4\u64AD\u7528\u7684\u4F1A\u8BDD");
    show.goLive(sessionId, gameSessionId || void 0);
    if (broadcast.streaming) show.markBroadcast();
    dm.newShow();
    social.newShow();
    return json(state());
  }, "onair");
  route("/api/dsh-live-farben/offair", ["POST"], () => {
    show.endLive();
    if (broadcast.streaming && !waitingOffair) {
      waitingOffair = setInterval(() => {
        if (show.isOnAir) return;
        if (waitingOffair) clearInterval(waitingOffair);
        waitingOffair = null;
        setTimeout(() => void broadcast.stop(), ENDING_SCENE_MS);
      }, 1e3);
    }
    return json(state());
  }, "offair");
  route("/api/dsh-live-farben/broadcast/start", ["POST"], () => {
    broadcast.start();
    return json(state());
  }, "broadcast start");
  route("/api/dsh-live-farben/broadcast/stop", ["POST"], async () => {
    await broadcast.stop();
    return json(state());
  }, "broadcast stop");
  route("/api/dsh-live-farben/obs/check", ["POST"], async () => {
    try {
      const obs = await connectObs(true);
      try {
        return json({ ok: true, ...await checkObs(obs, server.url, settings.streamKbps) });
      } finally {
        obs.close();
      }
    } catch (err) {
      return fail(err.message, 500);
    }
  }, "obs check");
  route("/api/dsh-live-farben/account", ["GET"], async () => json({ ok: true, account: await whoIs(await cookie()) }), "account");
  route("/api/dsh-live-farben/login/start", ["POST"], async () => {
    try {
      return json({ ok: true, ...await startQrLogin() });
    } catch (err) {
      return fail(err.message, 502);
    }
  }, "login start");
  route("/api/dsh-live-farben/login/poll", ["POST"], async (request) => {
    const { key } = await body(request);
    if (!key) return fail("\u7F3A key");
    try {
      const result = await pollQrLogin(String(key));
      if (result.state !== "ok") return json({ ok: true, state: result.state, ...result.state === "error" ? { message: result.message } : {} });
      const account = await whoIs(result.cookie);
      if (!account) return json({ ok: true, state: "error", message: "\u767B\u5F55\u6210\u529F\u4E86\uFF0C\u4F46\u7528\u8FD9\u4E2A Cookie \u67E5\u4E0D\u5230\u8D26\u53F7" });
      await hooks.setSecret(SECRETS.cookie, result.cookie);
      return json({ ok: true, state: "ok", account });
    } catch (err) {
      return fail(err.message, 502);
    }
  }, "login poll");
  route("/api/dsh-live-farben/orders", ["POST"], async (request) => {
    const { id, state: to, clear } = await body(request);
    const ok = ["queued", "doing", "done", "dropped"].find((s) => s === to);
    return show.ownerOrders({ id: Number(id) || void 0, state: ok, clear: !!clear }) ? json(state()) : fail("\u6CA1\u6709\u8FD9\u4E00\u5355\uFF0C\u6216\u8005\u72B6\u6001\u4E0D\u5BF9");
  }, "orders");
  route("/api/dsh-live-farben/owner", ["POST"], async (request) => {
    const { text, who, line } = await body(request);
    if (!text?.trim()) return fail("\u8BF4\u70B9\u4EC0\u4E48");
    if (line === "game") return show.ownerToGame(text) ? json({ ok: true }) : fail("\u8FD9\u573A\u6CA1\u5F00\u6E38\u620F\u7EBF");
    show.ownerSay(text, who ? String(who).slice(0, 20) : void 0);
    return json({ ok: true });
  }, "owner");
  route("/api/dsh-live-farben/guest", ["POST"], async (request) => {
    const { who, text, voice } = await body(request);
    if (!text?.trim()) return fail("\u8BF4\u70B9\u4EC0\u4E48");
    if (!show.isOnAir) return fail("\u6CA1\u5728\u64AD");
    const name2 = String(who ?? "").trim().slice(0, 20) || "Claude\u5C0F\u59D0";
    const said = await show.guestSay(name2, text.slice(0, 300), String(voice ?? "").trim() || GUEST_VOICE, AbortSignal.timeout(12e4));
    return json({ ok: true, said });
  }, "guest");
  route("/api/dsh-live-farben/say", ["POST"], async (request) => {
    const { text, prepare } = await body(request);
    if (!text?.trim()) return fail("\u5FF5\u4EC0\u4E48");
    if (prepare) {
      for (const part of splitByMood(text.slice(0, 500), currentMoods())) prepareSpeech(speakable(part.text));
      return json({ ok: true });
    }
    const said = [];
    for (const part of splitByMood(text.slice(0, 500), currentMoods())) said.push(await show.say(part.text, part.mood, AbortSignal.timeout(12e4)));
    return json({ ok: true, said: said.filter(Boolean) });
  }, "say");
  route("/api/dsh-live-farben/simulate", ["POST"], async (request) => {
    const event = simulated(await body(request));
    if (!event) return fail("\u6A21\u62DF\u7684\u4E8B\u4EF6\u4E0D\u5B8C\u6574");
    show.inject(event);
    return json({ ok: true });
  }, "simulate");
  route("/api/dsh-live-farben/events", ["GET"], () => {
    let unsubscribe = null;
    let tick = null;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (text) => {
          try {
            controller.enqueue(enc.encode(text));
          } catch {
          }
        };
        unsubscribe = show.stage.subscribe((event) => {
          if (event.type === "hello") return;
          send(`data: ${JSON.stringify(event.type === "say" ? { ...event, audio: null } : event)}

`);
        }, false);
        const status = () => {
          send(`event: status
data: ${JSON.stringify(show.status())}

`);
          send(`event: broadcast
data: ${JSON.stringify(broadcast.status())}

`);
        };
        tick = setInterval(status, 1e3);
        status();
      },
      cancel() {
        unsubscribe?.();
        if (tick) clearInterval(tick);
      }
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }, "events");
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
