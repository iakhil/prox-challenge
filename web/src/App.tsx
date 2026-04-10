import { useCallback, useEffect, useRef, useState } from 'react'
import { Conversation } from '@elevenlabs/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const SESSION_KEY = 'omnipro_session_id'
type ChatMsg = {
  role: 'user' | 'assistant'
  content: string
  tools?: string[]
  imageDataUrl?: string
  imageName?: string
}

type Part = { type: 'md'; text: string } | { type: 'artifact'; html: string }

type McpToolCallSuccess = {
  tool_call_id?: string
  tool_name?: string
  state?: 'success' | 'loading' | 'failure' | 'awaiting_approval'
  result?: unknown[]
}

function MicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19 11a7 7 0 0 1-14 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 18v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M8 21h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function splitArtifacts(raw: string): Part[] {
  const re = /```omnipro-artifact\n([\s\S]*?)```/g
  const parts: Part[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'md', text: raw.slice(last, m.index) })
    }
    parts.push({ type: 'artifact', html: m[1].trim() })
    last = m.index + m[0].length
  }
  if (last < raw.length) {
    parts.push({ type: 'md', text: raw.slice(last) })
  }
  if (parts.length === 0) {
    parts.push({ type: 'md', text: raw })
  }
  return parts
}

function AssistantBody({ text }: { text: string }) {
  const parts = splitArtifacts(text)
  return (
    <div className="md">
      {text === '…' && (
        <div className="thinking">
          <div className="dots" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
          <div className="thinking-line shimmer" />
          <div className="thinking-line shimmer" style={{ width: '72%' }} />
        </div>
      )}
      {parts.map((p, i) =>
        p.type === 'md' ? (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            urlTransform={(u) => u}
          >
            {p.text}
          </ReactMarkdown>
        ) : (
          <iframe
            key={i}
            className="artifact-frame"
            title={`Interactive ${i}`}
            sandbox="allow-scripts"
            srcDoc={p.html}
          />
        ),
      )}
    </div>
  )
}

function parseSseBlocks(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const part of parts) {
    const line = part.trim()
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)))
      } catch {
        /* ignore */
      }
    }
  }
  return { events, rest }
}

function collectImageMarkdownFromUnknown(
  value: unknown,
  out: Set<string>,
): void {
  if (typeof value === 'string') {
    const fromMarkdown = value.match(/!\[[^\]]*]\(([^)]+)\)/g)
    fromMarkdown?.forEach((m) => out.add(m))

    const urls = value.match(/https?:\/\/[^\s)"']+|\/api\/pages\/[^\s)"']+/g)
    urls?.forEach((u) => {
      if (u.endsWith('.png') || u.includes('/api/pages/')) {
        out.add(`![Manual page](${u})`)
      }
    })
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectImageMarkdownFromUnknown(item, out))
    return
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.markdown_for_chat === 'string') out.add(obj.markdown_for_chat)
    if (typeof obj.image_url === 'string') out.add(`![Manual page](${obj.image_url})`)
    Object.values(obj).forEach((v) => collectImageMarkdownFromUnknown(v, out))
  }
}

function imageMarkdownFromMcpSuccess(call: McpToolCallSuccess): string[] {
  const out = new Set<string>()
  collectImageMarkdownFromUnknown(call.result, out)
  return Array.from(out)
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(SESSION_KEY) : null,
  )
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [attachedImage, setAttachedImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voiceConnected, setVoiceConnected] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const conversationRef = useRef<Conversation | null>(null)
  const seenMcpToolCallsRef = useRef<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (sessionId) localStorage.setItem(SESSION_KEY, sessionId)
  }, [sessionId])

  const stopVoice = useCallback(async () => {
    try {
      await conversationRef.current?.endSession()
    } catch {
      /* ignore */
    }
    conversationRef.current = null
    seenMcpToolCallsRef.current.clear()
    setVoiceConnected(false)
  }, [])

  const sendWithText = useCallback(
    async (text: string, image?: { dataUrl: string; name: string } | null) => {
      const trimmed = text.trim()
      const imageDataUrl = image?.dataUrl
      if ((!trimmed && !imageDataUrl) || loading) return
      setError(null)
      setLoading(true)
      setMessages((m) => [
        ...m,
        { role: 'user', content: trimmed || 'Analyze this image.', imageDataUrl, imageName: image?.name },
        { role: 'assistant', content: '…', tools: [] },
      ])

      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac

      let accText = ''
      const toolSet = new Set<string>()

      try {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, image_data_url: imageDataUrl, session_id: sessionId }),
          signal: ac.signal,
        })
        if (!res.ok) {
          const err = await res.text()
          throw new Error(err || res.statusText)
        }
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const { events, rest } = parseSseBlocks(buf)
          buf = rest

          for (const raw of events) {
            const ev = raw as {
              event?: string
              data?: Record<string, unknown>
            }
            if (ev.event === 'session' && ev.data?.session_id) {
              setSessionId(String(ev.data.session_id))
            }
            if (ev.event === 'message' && ev.data && (ev.data as { kind?: string }).kind === 'assistant') {
              const content = (ev.data as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }).content || []
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  accText += block.text
                }
                if (block.type === 'tool_use' && block.name) {
                  const short =
                    block.name +
                    (block.input ? ` ${JSON.stringify(block.input).slice(0, 120)}` : '')
                  toolSet.add(short)
                }
              }
              setMessages((m) => {
                const copy = [...m]
                const last = copy[copy.length - 1]
                if (last?.role === 'assistant') {
                  copy[copy.length - 1] = {
                    ...last,
                    content: accText || '…',
                    tools: Array.from(toolSet),
                  }
                }
                return copy
              })
            }
            if (ev.event === 'error') {
              setError(String((ev.data as { message?: string })?.message || 'Unknown error'))
            }
          }
        }

        if (!accText.trim()) {
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            if (last?.role === 'assistant') {
              copy[copy.length - 1] = {
                ...last,
                content:
                  'No assistant text was returned. Set **ANTHROPIC_API_KEY** in `.env` and ensure the Claude Agent SDK can reach Anthropic.',
              }
            }
            return copy
          })
        }
        return accText
      } catch (e: unknown) {
        if ((e as Error).name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [loading, sessionId],
  )

  const send = useCallback(async () => {
    const text = input.trim()
    if ((!text && !attachedImage) || loading) return
    setInput('')
    const image = attachedImage
    setAttachedImage(null)
    await sendWithText(text, image)
  }, [input, loading, sendWithText, attachedImage])

  const onPickImage = useCallback(async (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image too large (max 5MB).')
      return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('Failed to read image file.'))
      reader.readAsDataURL(file)
    })
    setAttachedImage({ dataUrl, name: file.name })
    setError(null)
  }, [])

  const onDropImage = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)
      if (loading || voiceConnected) return
      const file = e.dataTransfer.files?.[0] || null
      void onPickImage(file)
    },
    [loading, voiceConnected, onPickImage],
  )

  const startVoice = useCallback(async () => {
    if (voiceConnected) return
    setError(null)
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone permission denied or unavailable.')
      return
    }
    try {
      seenMcpToolCallsRef.current.clear()
      const callbacks = {
        connectionType: 'websocket',
        onConnect: () => setVoiceConnected(true),
        onDisconnect: () => {
          conversationRef.current = null
          setVoiceConnected(false)
        },
        onError: (m: unknown) => {
          setError(typeof m === 'string' ? m : JSON.stringify(m))
        },
        onMCPToolCall: (call: unknown) => {
          // MCP tool call results do NOT come through `onMessage` (that callback is
          // higher-level chat messages). Listen here for manual page image results.
          const c = call as McpToolCallSuccess
          if (!c || c.state !== 'success' || c.tool_name !== 'get_manual_page_image') return
          if (c.tool_call_id && seenMcpToolCallsRef.current.has(c.tool_call_id)) return
          if (c.tool_call_id) seenMcpToolCallsRef.current.add(c.tool_call_id)

          const imageMd = imageMarkdownFromMcpSuccess(c)
          if (imageMd.length === 0) return

          setMessages((m: ChatMsg[]) => {
            const copy = [...m]
            const append = `\n\n${imageMd.join('\n\n')}`
            const last = copy[copy.length - 1]
            if (last?.role === 'assistant') {
              const content = last.content || ''
              if (!imageMd.some((md) => content.includes(md))) {
                copy[copy.length - 1] = { ...last, content: content + append }
              }
            } else {
              copy.push({ role: 'assistant', content: imageMd.join('\n\n') })
            }
            return copy
          })
        },
        onMessage: (message: unknown) => {
          const msg = message as {
            type?: string
            user_transcription_event?: { user_transcript?: string }
            agent_response_event?: { agent_response?: string }
            text_response_part?: { type?: string; text?: string }
          }
          if (msg?.type === 'user_transcript') {
            const t = msg.user_transcription_event?.user_transcript
            if (t) setMessages((m) => [...m, { role: 'user', content: String(t) }])
          }
          if (msg?.type === 'agent_response') {
            const t = msg.agent_response_event?.agent_response
            if (!t) return
            setMessages((m) => {
              const copy = [...m]
              const last = copy[copy.length - 1]
              if (last?.role === 'assistant') {
                copy[copy.length - 1] = { ...last, content: String(t) }
              } else {
                copy.push({ role: 'assistant', content: String(t) })
              }
              return copy
            })
          }
          if (msg?.type === 'agent_chat_response_part') {
            const part = msg.text_response_part
            if (!part) return
            if (part.type === 'start') {
              setMessages((m) => [...m, { role: 'assistant', content: '' }])
            } else if (part.type === 'delta') {
              setMessages((m) => {
                const copy = [...m]
                const last = copy[copy.length - 1]
                if (last?.role === 'assistant') {
                  copy[copy.length - 1] = {
                    ...last,
                    content: (last.content || '') + String(part.text || ''),
                  }
                }
                return copy
              })
            }
          }
        },
      } as const

      let conv: Conversation | null = null
      let signedUrlError: string | null = null

      try {
        const r = await fetch('/api/voice/convai/signed-url')
        if (!r.ok) {
          const err = await r.text()
          throw new Error(err || r.statusText)
        }
        const data = (await r.json()) as { signed_url?: string }
        const signedUrl = data.signed_url
        if (!signedUrl) throw new Error('Missing signed_url')
        conv = await Conversation.startSession({
          signedUrl,
          ...callbacks,
        })
      } catch (e: unknown) {
        signedUrlError = e instanceof Error ? e.message : String(e)
      }

      if (!conv) {
        const r = await fetch('/api/voice/convai/agent-id')
        if (!r.ok) {
          const err = await r.text()
          throw new Error(
            signedUrlError
              ? `Signed URL failed (${signedUrlError}) and agent-id fallback failed (${err || r.statusText}).`
              : (err || r.statusText),
          )
        }
        const data = (await r.json()) as { agent_id?: string }
        const agentId = (data.agent_id || '').trim()
        if (!agentId) {
          throw new Error(
            signedUrlError
              ? `Signed URL failed (${signedUrlError}) and agent-id fallback returned no agent id.`
              : 'Missing agent id for voice session.',
          )
        }
        conv = await Conversation.startSession({
          agentId,
          ...callbacks,
        })
      }

      conversationRef.current = conv
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      await stopVoice()
    }
  }, [stopVoice, voiceConnected])

  const toggleVoice = useCallback(() => {
    if (voiceConnected) {
      void stopVoice()
    } else {
      void startVoice()
    }
  }, [voiceConnected, startVoice, stopVoice])

  const reset = async () => {
    await stopVoice()
    if (sessionId) {
      try {
        await fetch('/api/session/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        })
      } catch {
        /* ignore */
      }
    }
    localStorage.removeItem(SESSION_KEY)
    setSessionId(null)
    setMessages([])
    setAttachedImage(null)
    setError(null)
  }

  return (
    <>
      <header className="app-header">
        <div className="header-top">
          <div className="header-spacer" aria-hidden="true" />
          <h1 className="brand">Gnosis</h1>
          <div className="header-actions">
            <button type="button" onClick={reset}>
              New chat
            </button>
            <button type="button" className={voiceConnected ? 'primary' : ''} onClick={() => void toggleVoice()}>
              {voiceConnected ? 'Voice: On' : 'Voice: Off'}
            </button>
          </div>
        </div>
        <p className="header-subtitle" style={{ textAlign: 'center' }}>
      "Make everything as simple as possible, but no simpler." 
      <br />
      ~Albert Einstein
        </p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="chat-log">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`bubble ${msg.role === 'user' ? 'user' : 'assistant'}`}
          >
            {msg.role === 'assistant' && msg.tools && msg.tools.length > 0 && (
              <div className="meta">
                {msg.tools.slice(-4).map((t, j) => (
                  <div key={j} className="tool-line">
                    {t}
                  </div>
                ))}
              </div>
            )}
            {msg.role === 'user' ? (
              <div className="md">
                {msg.content}
                {msg.imageDataUrl && (
                  <div className="user-image-wrap">
                    <img src={msg.imageDataUrl} alt={msg.imageName || 'Uploaded image'} className="user-upload-image" />
                  </div>
                )}
              </div>
            ) : (
              <AssistantBody text={msg.content} />
            )}
          </div>
        ))}
      </div>

      <div
        className={`composer ${dragActive ? 'drag-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!loading && !voiceConnected) setDragActive(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragActive(false)
        }}
        onDrop={onDropImage}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void onPickImage(e.target.files?.[0] || null)
            e.currentTarget.value = ''
          }}
        />
        {attachedImage && (
          <div className="image-chip">
            <span className="image-chip-name">{attachedImage.name}</span>
            <button type="button" onClick={() => setAttachedImage(null)}>
              Remove
            </button>
          </div>
        )}
        <div className="composer-main">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type in your question or drag and drop an image."
            rows={2}
            disabled={loading || voiceConnected}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button type="button" className="primary send-btn" disabled={loading || voiceConnected || (!input.trim() && !attachedImage)} onClick={() => void send()}>
            {loading ? '…' : 'Send'}
          </button>
        </div>
        <div className="composer-tools">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || voiceConnected}
            title="Attach image"
            aria-label="Attach image"
          >
            Image
          </button>
          <button
            type="button"
            className={`mic-btn ${voiceConnected ? 'recording' : ''}`}
            onClick={() => void toggleVoice()}
            disabled={loading}
            aria-label={voiceConnected ? 'End voice session' : 'Start voice session'}
            title={voiceConnected ? 'End voice session' : 'Start voice session (ElevenLabs agent)'}
          >
            <MicIcon />
            <span className="mic-bars" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>
      </div>
    </>
  )
}
