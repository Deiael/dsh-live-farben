import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  defineTool
} from "./chunks/chunk-3TTXC623.js";
import {
  broadcast,
  settings,
  updateSettings
} from "./chunks/chunk-TDP4TOGQ.js";

// src/dsh/repair.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
var name = "dsh-live-farben-repair";
var inject = ["tools"];
var textOut = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }]
};
function obsLogPath() {
  const dir = join(process.env.APPDATA ?? "", "obs-studio", "logs");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return files.length ? join(dir, files[0].f) : null;
}
function repairPlugin(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "stream_status",
    description: "\u67E5\u76F4\u64AD\u63A8\u6D41\u7684\u771F\u5B9E\u72B6\u6001\uFF1A\u63A8\u5230\u54EA\u4E00\u6B65\u3001\u63A8\u4E86\u591A\u4E45\u3001\u7801\u7387\u3001\u4E22\u5E27\u3001\u6709\u6CA1\u6709\u62A5\u9519\u3002\u5148\u67E5\u8FD9\u4E2A\u518D\u51B3\u5B9A\u600E\u4E48\u4FEE\u3002",
    parameters: {},
    output: textOut,
    async execute() {
      const s = broadcast.status();
      const h = s.health;
      const lines = [
        `\u63A8\u6D41\uFF1A${s.phase}${s.step ? `\uFF08${s.step}\uFF09` : ""}`,
        s.error ? `\u62A5\u9519\uFF1A${s.error}` : "",
        h ? `\u5DF2\u63A8 ${h.timecode}\uFF0C\u7801\u7387\u7EA6 ${h.kbps} kbps\uFF0C\u7F51\u7EDC\u4E22\u5E27 ${h.skipped}/${h.total}\uFF0C\u6E32\u67D3\u5EF6\u8FDF ${h.renderSkipped} \u5E27` : "\u8FD8\u6CA1\u6709\u63A8\u6D41\u6570\u636E\uFF08\u6CA1\u5728\u63A8\uFF09",
        `\u8BBE\u7F6E\uFF1A\u7801\u7387 ${settings.streamKbps} kbps\uFF0C\u534F\u8BAE ${s.protocol ?? settings.pushProtocol}`
      ];
      return lines.filter(Boolean).join("\n");
    }
  })), "stream_status tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "stream_restart",
    description: "\u91CD\u63A8\u6D41\uFF08\u5148\u505C\u518D\u5F00\uFF09\u3002\u63A8\u6D41\u5361\u6B7B\u3001\u4E22\u5E27\u592A\u591A\u3001\u753B\u9762\u5361\u4F4F\u65F6\u7528\uFF1B\u4F1A\u65AD\u6D41\u51E0\u79D2\uFF0C\u52A8\u624B\u524D\u5148\u8DDF\u89C2\u4F17\u8BF4\u4E00\u58F0\u3002",
    parameters: {},
    output: textOut,
    async execute() {
      const before = broadcast.status();
      if (before.phase === "streaming" || before.phase === "preparing") {
        await broadcast.stop().catch(() => void 0);
      }
      broadcast.start();
      await new Promise((r) => setTimeout(r, 8e3));
      const after = broadcast.status();
      return `\u91CD\u63A8\u5B8C\u6210\uFF1A\u73B0\u5728 ${after.phase}${after.error ? `\uFF08${after.error}\uFF09` : ""}${after.health ? `\uFF0C\u7801\u7387\u7EA6 ${after.health.kbps} kbps` : ""}\u3002`;
    }
  })), "stream_restart tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "obs_log",
    description: "\u770B OBS \u6700\u8FD1\u7684\u65E5\u5FD7\uFF08\u9ED8\u8BA4\u6700\u540E 30 \u884C\uFF09\uFF1A\u627E\u62A5\u9519\u3001\u4E22\u5E27\u3001\u8FDE\u63A5\u65AD\u5F00\u7684\u539F\u56E0\u3002",
    parameters: {
      lines: { type: "number", description: "\u770B\u6700\u540E\u591A\u5C11\u884C\uFF0C\u9ED8\u8BA4 30" },
      grep: { type: "string", description: "\u53EA\u770B\u5305\u542B\u8FD9\u4E2A\u8BCD\u7684\u884C\uFF0C\u6BD4\u5982 error\u3001rtmp\u3001bitrate" }
    },
    output: textOut,
    async execute(args) {
      const path = obsLogPath();
      if (!path) return "\u627E\u4E0D\u5230 OBS \u65E5\u5FD7\u76EE\u5F55\u3002";
      const n = Math.max(5, Math.min(200, Number(args.lines) || 30));
      const grep = String(args.grep ?? "").trim().toLowerCase();
      let lines = readFileSync(path, "utf8").split(/\r?\n/);
      if (grep) lines = lines.filter((l) => l.toLowerCase().includes(grep));
      return `OBS \u65E5\u5FD7\uFF08${path.split(/[\\/]/).pop()}\uFF09\uFF1A
${lines.slice(-n).join("\n")}`;
    }
  })), "obs_log tool");
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "set_bitrate",
    description: "\u6539\u63A8\u6D41\u7801\u7387\uFF08kbps\uFF09\u3002\u7F51\u7EDC\u6491\u4E0D\u4F4F\u3001\u4E22\u5E27\u591A\u65F6\u8C03\u4F4E\uFF08\u5EFA\u8BAE 1200\uFF5E1500\uFF09\uFF1B\u6539\u5B8C\u8981\u91CD\u63A8\u624D\u751F\u6548\uFF0C\u6240\u4EE5\u540C\u65F6\u8C03 stream_restart\u3002",
    parameters: {
      kbps: { type: "number", required: true, description: "\u76EE\u6807\u7801\u7387\uFF0C\u6BD4\u5982 1200" }
    },
    output: textOut,
    async execute(args) {
      const kbps = Math.max(600, Math.min(4e3, Math.round(Number(args.kbps) || 0)));
      if (!kbps) return "kbps \u8981\u7ED9\u4E2A\u6570\u5B57\u3002";
      updateSettings({ streamKbps: kbps });
      return `\u7801\u7387\u8BBE\u7F6E\u6539\u6210 ${kbps} kbps\uFF08\u5F53\u524D\u63A8\u6D41\u8FD8\u662F\u65E7\u7801\u7387\uFF0C\u8981 stream_restart \u624D\u751F\u6548\uFF09\u3002`;
    }
  })), "set_bitrate tool");
}
export {
  repairPlugin as default,
  inject,
  name
};
//# sourceMappingURL=repair.js.map
