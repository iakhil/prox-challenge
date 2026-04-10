import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { plainTextForSpeech } from './voice/plainText'
import './App.css'

const SESSION_KEY = 'omnipro_session_id'
type ChatMsg = {
  role: 'user' | 'assistant'
  content: string
  tools?: string[]
}

type Part = { type: 'md'; text: string } | { type: 'artifact'; html: string }

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

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7L8 5Z" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 6h12v12H6V6Z" />
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

function pickRecorderMime(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return undefined
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(SESSION_KEY) : null,
  )
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null)
  const [ttsLoadingIndex, setTtsLoadingIndex] = useState<number | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const skipNextTranscribeRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (sessionId) localStorage.setItem(SESSION_KEY, sessionId)
  }, [sessionId])

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (speechUrlRef.current) {
      URL.revokeObjectURL(speechUrlRef.current)
      speechUrlRef.current = null
    }
    setSpeakingIndex(null)
  }, [])

  useEffect(() => () => stopPlayback(), [stopPlayback])

  const sendWithText = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || loading) return
      setError(null)
      setLoading(true)
      setMessages((m) => [
        ...m,
        { role: 'user', content: trimmed },
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
          body: JSON.stringify({ message: trimmed, session_id: sessionId }),
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
    if (!text || loading) return
    setInput('')
    await sendWithText(text)
  }, [input, loading, sendWithText])

  const playAssistant = useCallback(
    async (index: number, content: string) => {
      if (content === '…') return
      const plain = plainTextForSpeech(content)
      if (!plain.trim()) {
        setError('Nothing to read aloud for this message.')
        return
      }
      stopPlayback()
      setError(null)
      setTtsLoadingIndex(index)
      try {
        const r = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: plain }),
        })
        if (!r.ok) {
          const t = await r.text()
          throw new Error(t || r.statusText)
        }
        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        speechUrlRef.current = url
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => stopPlayback()
        audio.onerror = () => {
          setError('Audio playback failed.')
          stopPlayback()
        }
        setSpeakingIndex(index)
        await audio.play()
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e))
        stopPlayback()
      } finally {
        setTtsLoadingIndex(null)
      }
    },
    [stopPlayback],
  )

  const onPlayToggle = useCallback(
    (index: number, content: string) => {
      if (speakingIndex === index) {
        stopPlayback()
        return
      }
      void playAssistant(index, content)
    },
    [playAssistant, speakingIndex, stopPlayback],
  )

  const stopRecordingInternal = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state === 'inactive') {
      setRecording(false)
      return
    }
    mr.stop()
  }, [])

  const startRecording = useCallback(async () => {
    if (loading || transcribing || recording) return
    setError(null)
    skipNextTranscribeRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickRecorderMime()
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        mediaRecorderRef.current = null
        if (skipNextTranscribeRef.current) {
          skipNextTranscribeRef.current = false
          chunksRef.current = []
          setTranscribing(false)
          return
        }
        const blobType = mr.mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type: blobType })
        chunksRef.current = []
        if (blob.size < 100) {
          setTranscribing(false)
          setError('Recording too short.')
          return
        }
        setTranscribing(true)
        try {
          const fd = new FormData()
          const ext = blobType.includes('webm') ? 'webm' : blobType.includes('mp4') ? 'm4a' : 'bin'
          fd.append('audio', blob, `recording.${ext}`)
          const r = await fetch('/api/voice/transcribe', { method: 'POST', body: fd })
          if (!r.ok) {
            const t = await r.text()
            throw new Error(t || r.statusText)
          }
          const data = (await r.json()) as { text?: string }
          const t = (data.text || '').trim()
          if (!t) {
            setError('No speech recognized.')
            return
          }
          await sendWithText(t)
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setTranscribing(false)
        }
      }
      mediaRecorderRef.current = mr
      mr.start()
      setRecording(true)
    } catch {
      setError('Microphone permission denied or unavailable.')
    }
  }, [loading, recording, sendWithText, transcribing])

  const toggleMic = useCallback(() => {
    if (loading || transcribing) return
    if (recording) {
      stopRecordingInternal()
      setRecording(false)
    } else {
      void startRecording()
    }
  }, [loading, recording, startRecording, stopRecordingInternal, transcribing])

  const reset = async () => {
    skipNextTranscribeRef.current = true
    stopRecordingInternal()
    mediaRecorderRef.current = null
    setRecording(false)
    setTranscribing(false)
    stopPlayback()
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
            {msg.role === 'assistant' && msg.content && msg.content !== '…' && (
              <div className="bubble-actions">
                <button
                  type="button"
                  className="play-aloud-btn"
                  onClick={() => onPlayToggle(i, msg.content)}
                  disabled={ttsLoadingIndex === i}
                  aria-label={speakingIndex === i ? 'Stop read aloud' : 'Read aloud'}
                  title={speakingIndex === i ? 'Stop' : 'Read aloud'}
                >
                  {speakingIndex === i ? <StopIcon /> : <PlayIcon />}
                  <span>{ttsLoadingIndex === i ? 'Loading…' : speakingIndex === i ? 'Stop' : 'Play'}</span>
                </button>
              </div>
            )}
            {msg.role === 'user' ? (
              <div className="md">{msg.content}</div>
            ) : (
              <AssistantBody text={msg.content} />
            )}
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. What's the duty cycle for MIG at 200A on 240V?"
          rows={2}
          disabled={loading || recording || transcribing}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-actions">
          <button
            type="button"
            className={`mic-btn ${recording ? 'recording' : ''}`}
            onClick={() => void toggleMic()}
            disabled={loading || transcribing}
            aria-label={recording ? 'Stop recording and send' : 'Record question'}
            title={recording ? 'Tap to stop and send' : 'Tap to record, tap again to transcribe and send'}
          >
            <MicIcon />
          </button>
          <button type="button" className="primary" disabled={loading || recording || transcribing || !input.trim()} onClick={() => void send()}>
            {loading ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </>
  )
}
