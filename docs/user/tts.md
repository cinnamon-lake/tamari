# Text-to-Speech

tamari can speak text aloud using one of eleven TTS providers — local servers like Fish Audio S2 Pro, Kokoro, or GPT-SoVITS, and cloud services like OpenAI, ElevenLabs, or Azure Speech. There is no global "read every message aloud" switch: TTS is a **tool the AI calls**, and you configure it per toolset.

## How TTS Works in tamari

SillyTavern configured TTS globally in Settings and auto-played or read messages aloud on demand. tamari intentionally works differently: TTS is the built-in **Speak** tool template, which exposes a single `speak` tool to the model.

- **The LLM decides when to speak.** During a generation, the model can call `speak` with the text it wants voiced — a line of dialogue, a dramatic whisper, a single word. There is no auto-play of chat messages.
- **Configuration lives per toolset.** Provider, voice, API key, and related options are set on the Speak toolset's **Configuration** form in the Tools modal — not in global settings. You can create multiple Speak toolsets with different voices or providers and enable the one you want.
- **Speaking doesn't end the turn.** After the tool runs, the tool-calling loop continues: the model sees the result and writes its reply, embedding the audio reference so you can play it. See [Tools & Lua Templates](./tools.md) for how the tool loop works.

When the model calls `speak`, tamari sends the text to the configured provider, saves the returned audio as a chat attachment, and hands the model an `{{attachment::ID}}` reference to include in its response.

## Setup

1. Open the sidebar and click **Tools**.
2. In the Tools modal, click **New Toolset**.
3. In the toolset's **Template** dropdown, pick **Speak**.
4. Fill in the **Configuration** form (below) — at minimum, choose a **provider**.
5. Make sure the toolset is toggled **Enabled**.

The `speak` tool reaches the model on the next generation. If `provider` is empty, the tool call fails with `Error: no TTS provider configured in toolset config` — visible to the model, which will usually tell you.

### Configuration Fields

| Field | Description |
|-------|-------------|
| `provider` | **Required.** One of `fishaudio`, `kokoro`, `elevenlabs`, `openai`, `azure`, `minimax`, `volcengine`, `alltalk`, `vits`, `silero`, `gptsovits`. |
| `voiceId` | Voice ID (optional; provider default if empty). For Azure, the voice ShortName (e.g. `en-US-JennyNeural`); for GPT-SoVITS, the server-side reference-audio path. |
| `baseUrl` | API base URL (optional; provider default if empty). For Azure, the regional host (e.g. `https://eastus.tts.speech.microsoft.com`). |
| `apiKey` | API key or access token, or a vault reference (`secret:<key>`). Rendered as a password field with a vault picker. |
| `model` | Model ID for OpenAI / ElevenLabs / MiniMax (optional). |
| `appId` | App ID for VolcEngine (optional for other providers). |
| `referenceAudio` | Reference audio file for voice cloning (optional). Uploaded in the form and stored as base64. |
| `referenceText` | Transcript of the reference audio — required when `referenceAudio` is set. |
| `requestScript` | Lua script that mutates the outgoing HTTP request — see [Request Scripts](./request-scripts.md). |

> **Note:** Which fields matter depends on the provider — check the table below. Fields you leave empty fall back to the provider's built-in defaults.

## Providers

"Needs" lists what you must supply beyond picking the provider. Every provider also accepts `baseUrl` (to point at a self-hosted or proxied endpoint) and `requestScript`.

| Provider (`provider` value) | Kind | Needs | Defaults |
|------------------------------|------|-------|----------|
| `fishaudio` — Fish Audio S2 Pro | Local | Nothing for a default local server | `baseUrl` `http://127.0.0.1:8080/v1`; `voiceId` is a reference ID from your server's voice list |
| `kokoro` — Kokoro (FastAPI) | Local | Nothing for a default local server | `baseUrl` `http://127.0.0.1:8880/v1`; voice `af_heart` |
| `elevenlabs` — ElevenLabs | Cloud | `apiKey` | `baseUrl` `https://api.elevenlabs.io`; voice `21m00Tcm4TlvDq8ikWAM` ("Rachel"); `model` `eleven_multilingual_v2` |
| `openai` — OpenAI | Cloud | `apiKey` | `baseUrl` `https://api.openai.com`; voice `alloy`; `model` `gpt-4o-mini-tts` |
| `azure` — Azure Speech | Cloud | `apiKey` (subscription key) | `baseUrl` `https://eastus.tts.speech.microsoft.com`; voice `en-US-JennyNeural` |
| `minimax` — MiniMax | Cloud | `apiKey` | `baseUrl` `https://api.minimax.io`; voice `English_expressive_narrator`; `model` `speech-02-hd` |
| `volcengine` — VolcEngine | Cloud | `apiKey` (OpenSpeech Access Token) **and** `appId` | `baseUrl` `https://openspeech.bytedance.com`; voice `zh_female_wanwanxiaohe` |
| `alltalk` — AllTalk | Local | Nothing for a default local server | `baseUrl` `http://127.0.0.1:7851`; voice `alloy` |
| `vits` — VITS (simple-api) | Local | Nothing for a default local server | `baseUrl` `http://127.0.0.1:23456`; voice is a numeric speaker ID (`0` if empty) |
| `silero` — Silero | Local | Nothing for a default local server | `baseUrl` `http://127.0.0.1:8001`; voice `en_0` |
| `gptsovits` — GPT-SoVITS | Local | Nothing for a default local server | `baseUrl` `http://127.0.0.1:9880`; set `voiceId` to the server-side reference-audio path |

Provider-specific notes:

- **Fish Audio S2 Pro** targets the local `tools/api_server.py` or an SGLang deployment. `apiKey` is sent as a Bearer token if your server requires one. Voices are reference IDs; this is also the provider where `referenceAudio` / `referenceText` voice cloning is passed through.
- **Kokoro** targets the OpenAI-compatible endpoints of `remsky/Kokoro-FastAPI` and similar wrappers (`POST /audio/speech`). Voice names like `af_heart` come from the server.
- **OpenAI** has no voice-list endpoint; the built-in voices are `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.
- **Azure** expects the **regional host** as `baseUrl` (change `eastus` to your region) and your subscription key as `apiKey`. Text is sent as SSML with the voice chosen via `voiceId` ShortName.
- **VolcEngine** uses the OpenSpeech HTTP API. `apiKey` is the static Access Token from the OpenSpeech console, and `appId` comes from the same place. The request cluster is always the standard `volcano_tts` — it is not exposed in the toolset config.
- **AllTalk** targets the v2 OpenAI-compatible endpoint of `erew123/alltalk_tts`. That endpoint only accepts the six classic OpenAI voice names (`alloy`, `echo`, `fable`, `nova`, `onyx`, `shimmer`) — other names are rejected.
- **VITS (simple-api)** targets `Artrajz/vits-simple-api`, the common wrapper for VITS / Bert-VITS2 / GPT-SoVITS. `voiceId` is the numeric speaker ID; `apiKey` is only needed if the server has API-key auth enabled.
- **Silero** ships no official HTTP server; the adapter targets the `ouoertheo/silero-api-server` wrapper.
- **GPT-SoVITS** targets `api_v2.py` from `RVC-Boss/GPT-SoVITS`. A "voice" is a reference-audio file on the server — put its path in `voiceId`.

> **Warning:** `referenceText` is required whenever `referenceAudio` is set — the tool call fails with an error otherwise. Also note that with a reference audio configured, the `voiceId` field is ignored for that call.

## Prosody Tags

The `speak` tool accepts the text to speak **including natural-language voice direction tags**, and tamari passes the text through to the provider verbatim:

```
[whisper in small voice] Come closer... [excitedly] I found it!
```

Providers that understand inline direction — Fish Audio S2 Pro is the flagship case — interpret tags like `[whisper in small voice]`, `[excitedly]`, or `[pitch up]` and act on them. On other providers the effect varies: some ignore the tags, some read them aloud literally.

> **Note:** Azure sends text as XML-escaped SSML, so bracket tags reach Azure as plain spoken text. If your Azure voices are narrating "[whisper]", that's why — strip the tags or switch providers for directed speech.

The model writes these tags itself when it calls `speak`. If you want more (or less) expressive delivery, reword the tool's `description` override in the toolset — for example, telling it to always tag emotion, or to send plain narration only. Overrides are covered in [Tools & Lua Templates](./tools.md).

## Audio Playback in Chat

A successful `speak` call saves the audio as an attachment (the file extension comes from the provider's audio format — `wav`, `mp3`, `ogg`, `flac`, `aac`, or `opus`) and returns an `{{attachment::ID}}` reference to the model. The model is instructed to copy that reference into its reply; when it does, the reference resolves at display time into an **inline audio player** in the message — press play to listen.

Two things follow from this design:

- **If the model doesn't include the reference, you see no player.** The audio was still generated and saved, but nothing renders. A clearer `description` override usually fixes a model that forgets.
- **Audio lives in the message.** The reference is part of the message text, so swipes and branches keep their own generated audio, and the player reappears whenever the message is rendered.

Attachments and the `{{attachment::ID}}` macro are covered in [Assets](./assets.md) and [Macro System](./macros.md).

## Tips & Gotchas

- **Cloud providers charge per character.** OpenAI, ElevenLabs, Azure, MiniMax, and VolcEngine bill per synthesized character, and an expressive model that speaks every other message adds up fast. Local providers — `fishaudio`, `kokoro`, `alltalk`, `vits`, `silero`, `gptsovits` — are free once the server is running.
- **Kokoro is the easiest local start.** One local server gives you an OpenAI-compatible endpoint on `http://127.0.0.1:8880/v1` with no API key needed. Fish Audio S2 Pro is the heavier but more expressive option (and the one that understands prosody tags).
- **Tune behavior with overrides, not code.** If the model speaks too often, too rarely, or forgets the audio reference, edit the `speak` tool's `description` override in the toolset before assuming anything is broken.
- **One voice per toolset.** Voice is toolset config, so different characters speaking with different voices means multiple Speak toolsets — but only enabled toolsets advertise tools, and two enabled Speak toolsets expose the same `speak` name (first match wins). Rename one with a `name` override if you want both active.
- **Failures are visible, not fatal.** A misconfigured provider returns an error string as the tool result (`TTS generation failed: HTTP 401 - ...`, including the provider's response), and the turn continues — the model can read the error and usually relays it.
- **Keep keys in the vault.** The `apiKey` field accepts `secret:<key>` references, so the toolset record stores a pointer instead of the raw key.
