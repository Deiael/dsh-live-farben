# dsh-live-farben

Let your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent host a Bilibili livestream: it reads the chat, thanks gifts, welcomes viewers, remembers regulars, queues viewer-requested videos on a skinnable stage, and speaks with its own TTS voice — pushed to Bilibili through OBS.

一个让 DeepSeek Harness 在 B 站当主播的插件：读弹幕、谢礼物、欢迎新观众、记住常客，把观众点的视频排进队列放在舞台上，用自己的 TTS 音色说话，画面经 OBS 推到 B 站。

## Features / 功能

- **Chat & gifts** — replies to danmaku, superchats, gifts, follows and new viewers; remembers regulars between streams.
- **Stage** — a browser-source stage with character, subtitles, chat, board, alerts, terminal and a **video request queue** that auto-pages when several viewers queue up.
- **Video requests** — viewers ask for a Bilibili video; it is searched, played on stage, and if something is already playing it waits in the queue (one at a time, no interruption).
- **Voice** — Doubao (ByteDance) TTS, 2.0 voices, with word-level subtitles timed to the audio.
- **OBS integration** — creates its own OBS profile and scene collection, picks the encoder automatically (NVIDIA NVENC → Intel QSV → x264), opens Bilibili's websocket server through the API, starts and stops the stream.
- **Bilibili** — QR login, room setup, stream title/area, cover upload, SRT→RTMP fallback when the SRT address is not OBS-compatible, and readable errors when Bilibili asks for identity verification.
- **Characters / themes** — character packs (Live2D-style clips or still images) and stage templates are just folders under `assets/`; drop in your own.

## Requirements / 环境要求

- DeepSeek Harness with the desktop/web profile.
- **OBS Studio 28+** installed. The plugin enables OBS → Tools → WebSocket Server Settings by itself; no manual setup needed.
- A Bilibili account with a live room (the plugin can create one).
- A Doubao TTS API key (new console, `seed-tts-2.0`) for the voice. Without it the agent still runs, just silently.
- Optional: a Python with `faster-whisper` for transcribing videos that have no subtitles.

## Install / 安装

From npm:

```sh
dsh plugin --profile desktop add dsh-live-farben
```

From GitHub:

```sh
dsh plugin --profile desktop add github:farben/dsh-live-farben
```

Then add `dsh-live-farben` to the `dsh.profile.bundles` list of your profile and restart DeepSeek Harness.

## First run / 第一次使用

1. Open the livestream console in DSH.
2. Settings → **开播账号** → 扫码登录 (scan with the Bilibili app).
3. Enter your room id (or leave empty to open one).
4. Click **检查 OBS** to let the plugin create its OBS profile and stage scene.
5. Click **开播** (or **开始彩排** for a local rehearsal without pushing).

All settings are stored in `~/.dsh/dsh-live-farben/settings.json`; secrets (Bilibili cookie, Doubao key) live in DSH's credential store, never in this package.

## Encoder / 编码器

`encoder` defaults to `auto`: NVENC when an NVIDIA driver is present, Intel QSV on Intel graphics, otherwise x264. Override in `settings.json` with `"encoder": "nvenc" | "qsv" | "x264"` if auto-detection picks the wrong one.

## Themes & characters / 皮肤与角色

- Characters: `assets/characters/<id>/` (`character.json` + clips/images).
- Templates: `assets/templates/<id>/` (`template.json` + `style.css` + preview images).

The bundled `dafeiyu` character is the author's own artwork (see `assets/characters/dafeiyu/`), included as a demo. Replace it with your own before shipping a fork.

## Credits / 致谢

This plugin is a fork/derivative of **dsh-livestream** (MIT). Thanks to its authors for the original architecture, OBS/Bilibili integration and stage runtime.

Bundled character art is licensed as stated inside the character pack (CC BY-NC-SA 4.0). It is not part of the MIT-licensed code.

## License

MIT — see [LICENSE](./LICENSE).
