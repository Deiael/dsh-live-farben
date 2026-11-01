/**
 * 小钢炮的工具：直播推流、OBS、画质码率的真实排查与操作。
 * 挂在「小钢炮·维修」预设下（见 cordis.patch.yml），只有它有这些手。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { broadcast, settings, updateSettings } from './runtime';

export const name = 'dsh-live-farben-repair';
export const inject = ['tools'];

interface RepairContext {
  effect(effect: () => () => void, label?: string): unknown;
  tools: { register(tool: unknown): () => void };
}

const textOut = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
};

function obsLogPath(): string | null {
  const dir = join(process.env.APPDATA ?? '', 'obs-studio', 'logs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? join(dir, files[0].f) : null;
}

export default function repairPlugin(ctx: RepairContext): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stream_status',
    description: '查直播推流的真实状态：推到哪一步、推了多久、码率、丢帧、有没有报错。先查这个再决定怎么修。',
    parameters: {},
    output: textOut,
    async execute() {
      const s = broadcast.status();
      const h = s.health;
      const lines = [
        `推流：${s.phase}${s.step ? `（${s.step}）` : ''}`,
        s.error ? `报错：${s.error}` : '',
        h ? `已推 ${h.timecode}，码率约 ${h.kbps} kbps，网络丢帧 ${h.skipped}/${h.total}，渲染延迟 ${h.renderSkipped} 帧` : '还没有推流数据（没在推）',
        `设置：码率 ${settings.streamKbps} kbps，协议 ${s.protocol ?? settings.pushProtocol}`,
      ];
      return lines.filter(Boolean).join('\n');
    },
  })), 'stream_status tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stream_restart',
    description: '重推流（先停再开）。推流卡死、丢帧太多、画面卡住时用；会断流几秒，动手前先跟观众说一声。',
    parameters: {},
    output: textOut,
    async execute() {
      const before = broadcast.status();
      if (before.phase === 'streaming' || before.phase === 'preparing') {
        await broadcast.stop().catch(() => undefined);
      }
      broadcast.start();
      await new Promise((r) => setTimeout(r, 8000));
      const after = broadcast.status();
      return `重推完成：现在 ${after.phase}${after.error ? `（${after.error}）` : ''}${after.health ? `，码率约 ${after.health.kbps} kbps` : ''}。`;
    },
  })), 'stream_restart tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'obs_log',
    description: '看 OBS 最近的日志（默认最后 30 行）：找报错、丢帧、连接断开的原因。',
    parameters: {
      lines: { type: 'number', description: '看最后多少行，默认 30' },
      grep: { type: 'string', description: '只看包含这个词的行，比如 error、rtmp、bitrate' },
    },
    output: textOut,
    async execute(args) {
      const path = obsLogPath();
      if (!path) return '找不到 OBS 日志目录。';
      const n = Math.max(5, Math.min(200, Number(args.lines) || 30));
      const grep = String(args.grep ?? '').trim().toLowerCase();
      let lines = readFileSync(path, 'utf8').split(/\r?\n/);
      if (grep) lines = lines.filter((l) => l.toLowerCase().includes(grep));
      return `OBS 日志（${path.split(/[\\/]/).pop()}）：\n${lines.slice(-n).join('\n')}`;
    },
  })), 'obs_log tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'set_bitrate',
    description: '改推流码率（kbps）。网络撑不住、丢帧多时调低（建议 1200～1500）；改完要重推才生效，所以同时调 stream_restart。',
    parameters: {
      kbps: { type: 'number', required: true, description: '目标码率，比如 1200' },
    },
    output: textOut,
    async execute(args) {
      const kbps = Math.max(600, Math.min(4000, Math.round(Number(args.kbps) || 0)));
      if (!kbps) return 'kbps 要给个数字。';
      updateSettings({ streamKbps: kbps });
      return `码率设置改成 ${kbps} kbps（当前推流还是旧码率，要 stream_restart 才生效）。`;
    },
  })), 'set_bitrate tool');
}
