# Prox Founding Engineer Challenge

<img src="product.webp" alt="Vulcan OmniPro 220" width="400" /> <img src="product-inside.webp" alt="Vulcan OmniPro 220 — inside panel" width="400" />

## Solution: OmniPro 220 agent

This fork adds a **multimodal support agent** for the Vulcan OmniPro 220 using the **[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/quickstart)** (Python): a FastAPI backend wraps `ClaudeSDKClient` with an in-process **MCP server** that searches extracted manual text and resolves page images. A **Vite + React** UI streams replies over **SSE**, renders **Markdown** (including manual figures), and shows **HTML artifacts** in a sandboxed iframe when the model emits fenced blocks with the language tag `omnipro-artifact` (see system prompt in `backend/agent_options.py`).

### Quick start (about two minutes)

```bash
git clone <your-fork>
cd <your-fork>
cp .env.example .env
# Add your Anthropic API key to .env as ANTHROPIC_API_KEY=...

uv sync
npm ci --prefix web
```

**Development (API + hot-reload UI):** run both processes — the UI proxies `/api` to the backend.

```bash
# Terminal 1
uv run uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2
cd web && npm run dev
```

Open **http://127.0.0.1:5173**. The first API boot extracts PDFs under `files/` into `data/` (text + PNG per page) if that cache is missing.

**Single-process demo (API + built static UI on port 8000):**

```bash
npm run build --prefix web
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Then open **http://127.0.0.1:8000/** (same origin as `/api`, so no CORS issues).

Optional: `uv run python -m backend.dev` starts Uvicorn and the Vite dev server together (requires `npm` on `PATH`).

### Architecture

| Piece | Role |
| --- | --- |
| `scripts/extract_manuals.py` | PyMuPDF: per-page `.txt` + `.png` under `data/extracted/` and `data/pages/` |
| `backend/manual_index.py` | Simple ranked search over extracted text |
| `backend/manual_mcp.py` | `@tool` MCP tools: `search_manual`, `read_manual_page_text`, `get_manual_page_image`, `list_manual_docs` |
| `backend/agent_options.py` | `ClaudeAgentOptions`: system prompt, `mcp_servers`, read-only tool allowlist (`Read`, `Grep`, `Glob` + manual tools), `disallowed_tools` for write/bash/web |
| `backend/chat.py` | `ClaudeSDKClient` per HTTP session; SSE serialization |
| `backend/main.py` | FastAPI: `/health`, `/api/chat/stream`, `/api/pages/...`, `/api/voice/*`, and remote MCP at `/api/mcp/manual`; optional `web/dist` SPA |
| `scripts/sync_elevenlabs_kb.py` | Optional: upload `files/*.pdf` to ElevenLabs ConvAI knowledge base via API |
| `backend/elevenlabs_voice.py` | Proxies [ElevenLabs](https://elevenlabs.io/) STT + TTS (API key server-side only) |
| `web/` | Chat UI, `react-markdown`, artifact iframes, mic (STT) + per-message read-aloud (TTS) |

### Voice (ElevenLabs STT + TTS)

The UI does **not** use ConvAI WebSockets. Flow:

- **Mic**: record in the browser → `POST /api/voice/transcribe` (ElevenLabs speech-to-text) → the transcript is sent through the same **`/api/chat/stream`** path as typed messages (Claude + manual MCP tools).
- **Read aloud**: each assistant message has a **Play** button → `POST /api/voice/speak` (ElevenLabs text-to-speech) → audio plays in the browser. Spoken text is a markdown-stripped version (`web/src/voice/plainText.ts`).

**Cost**: Billed by your ElevenLabs plan; the API needs outbound HTTPS to `api.elevenlabs.io`.

**Env** (see [`.env.example`](.env.example)): `ELEVENLABS_API_KEY`, and **`ELEVENLABS_VOICE_ID`** for TTS. Without them, chat still works; mic / play will error until configured.

**Browser**: microphone permission required; use **HTTPS** or **localhost** so `getUserMedia` is allowed.

### Knowledge extraction

Manuals live in `files/` (`owner-manual.pdf`, `quick-start-guide.pdf`, `selection-chart.pdf`). Extraction is **idempotent** and **gitignored** (`data/`). The agent is instructed to **call manual tools before stating facts** so duty cycles, polarity, and troubleshooting stay tied to the PDFs.

### Multimodal behavior

- **Manual images**: Tools return `/api/pages/{doc_id}/{page}.png` so the model can paste Markdown images the UI loads via the Vite proxy or same-origin static hosting.
- **Synthetic / interactive**: The system prompt asks for self-contained HTML in fenced blocks whose language tag is `omnipro-artifact`; the UI strips those blocks and renders them with `sandbox="allow-scripts"`.

### Environment

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required for the Agent SDK |
| `ANTHROPIC_MODEL` / `CLAUDE_MODEL` | Optional model override |
| `OMNIPRO_PUBLIC_BASE` | Optional absolute prefix for image URLs in tools (e.g. public deploy origin) |
| `CORS_ORIGINS` | Comma-separated allowed origins for the API (dev defaults include port 5173) |
| `ELEVENLABS_API_KEY` | Required for ElevenLabs STT/TTS in the UI |
| `ELEVENLABS_VOICE_ID` | Required for read-aloud (`/api/voice/speak`) |
| `VOICE_MANUAL_MCP_TOKEN` | Optional; if set, `/api/mcp/manual/*` requires `Authorization: Bearer ...` or `X-MCP-Auth-Token` |
| `ELEVENLABS_STT_MODEL_ID` | Optional; default `scribe_v2` |
| `ELEVENLABS_TTS_MODEL_ID` | Optional; default `eleven_multilingual_v2` |
| `ELEVENLABS_TTS_OUTPUT_FORMAT` | Optional; default `mp3_44100_128` |

### Optional hosting

Containerize with the same `uv sync` + `npm ci` + `npm run build` flow; expose one port and run Uvicorn. Set `CORS_ORIGINS` and `OMNIPRO_PUBLIC_BASE` to your public origin. The [Agent SDK hosting notes](https://platform.claude.com/docs/en/agent-sdk/hosting) apply (outbound HTTPS to Anthropic, sufficient RAM for the CLI-backed SDK).

---

## Challenge brief

### The Product

The [Vulcan OmniPro 220](https://www.harborfreight.com/omnipro-220-industrial-multiprocess-welder-with-120240v-input-57812.html) is a multiprocess welding system sold by Harbor Freight. It supports four welding processes (MIG, Flux-Cored, TIG, and Stick), runs on both 120V and 240V input, and has an LCD-based synergic control system.

Its owner's manual is 48 pages of dense technical content. Duty cycle matrices across multiple voltages and amperages, polarity setup procedures that differ per welding process, wire feed mechanisms with specific tensioner calibrations, wiring schematics, troubleshooting matrices, weld diagnosis diagrams, and a full parts list.

This is exactly the kind of product Prox exists for. Nobody knows how to use this machine straight out of the box but has time to read 48 page manual, but a complicated machine needs expert-level support.

Additional video: https://www.youtube.com/watch?v=kxGDoGcnhBw

## Your Job

Build a multimodal reasoning agent for the Vulcan OmniPro 220 using the Claude Agent SDK. The agent must be able to answer deep technical questions about this product accurately, helpfully, and not just in text.

The manuals are in the `files/` directory.

**There is no limit to how far you can go.** You can integrate voice. You can build a full interactive experience. Sky is the limit. The more ambitious and polished, the better.

## What We're Testing

### 1. Deep Technical Accuracy

Your agent needs to answer questions like these correctly:

- "What's the duty cycle for MIG welding at 200A on 240V?"
- "I'm getting porosity in my flux-cored welds. What should I check?"
- "What polarity setup do I need for TIG welding? Which socket does the ground clamp go in?"

We will test with questions that require cross-referencing multiple manual sections, understanding visual content (diagrams, schematics, charts), and handling ambiguous questions that need clarification from the user.

### 2. Multimodal Responses

This is the most important part. Your agent must not be text-only.

- If someone asks about polarity setup, the agent should draw or show a diagram of which cable goes in which socket, not just describe it.
- If the answer relates to a specific image in the manual (the wire feed mechanism, the front panel controls, the weld diagnosis examples), the agent should surface that image.
- If a question is complex enough, the agent should generate interactive content: a duty cycle calculator, a troubleshooting flowchart, a settings configurator that takes process + material + thickness and outputs recommended wire speed and voltage.

When something is too cognitively hard to explain in words, the agent should draw it. Real-time diagrams, interactive schematics, visual walkthroughs generated through code.

For your agent to handle these responses well you need to reverse engineer Claude artifacts. Here are two places where you can start:
- https://claude.ai/artifacts (see how Claude renders interactive artifacts in chat)
- https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts

### 3. Tone and Helpfulness

Imagine your user just bought this welder and is standing in their garage trying to set it up. They're not an idiot, but they're not a professional welder either.

### 4. Knowledge Extraction Quality

The manual has a mix of text, tables, labeled diagrams, schematics, and decision matrices. Some critical information exists only in images (the welding process selection chart, the weld diagnosis photos, the wiring schematic). We want to see that your agent understands and presents the visual content, not just the text.

## Tech Requirements

- Use the [Anthropic Claude Agent SDK](https://docs.anthropic.com) as the foundation for your agent.
- The project must run locally with a single API key provided via `.env`.
- You are responsible for your own API costs during development.

## How to Present Your Work

**This matters.** Your submission is not just the code — it's how you present it.

- **Build a frontend.** The best way for us to evaluate your agent is if it has a clean, simple UI we can run immediately. This is realistically the only way to properly demo an agent like this.
- **Hosting is a plus.** If you host it somewhere we can access without cloning, that's a strong signal. Not required, but it removes friction and shows initiative.
- **Write a clear README.** Explain how your agent works, what design decisions you made, how knowledge is extracted and represented, and how to run it. Your documentation will be evaluated — we want to see how you think and communicate, not just how you code.
- **Video walkthrough is a huge plus.** Record yourself demoing the agent and explaining your approach. Walk through the hard questions, show how it handles multimodal responses, explain your architecture. This gives us a much richer picture of your work than code alone.

We should be running your agent within 2 minutes of cloning your repo:

```bash
git clone <your-fork>
cd <your-fork>
cp .env.example .env   # we plug in our own Anthropic API key
# your install command (npm install, uv install, etc.)
# your run command (npm run dev, python app.py, etc.)
```

If it takes longer than that to set up, that's a problem.

## What to Submit

1. Fork this repo.
2. Build your solution.
3. Submit your fork URL through the form at [useprox.com/join/challenge](https://useprox.com/join/challenge).

## What Happens Next

We review submissions on a rolling basis and respond to every single one within a few days. Good luck.
