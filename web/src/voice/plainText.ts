/** Strip markdown-ish content for TTS (no perfect MD parser — good enough for chat). */

export function plainTextForSpeech(markdown: string): string {
  let s = markdown

  // Remove omnipro-artifact fenced blocks (replace with short hint)
  s = s.replace(/```omnipro-artifact\n[\s\S]*?```/g, ' [interactive diagram] ')

  // Other fenced code blocks
  s = s.replace(/```[\s\S]*?```/g, ' ')

  // Images: ![alt](url) -> alt or omit if empty
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt: string) => (alt.trim() ? ` ${alt} ` : ' '))

  // Links [text](url) -> text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // Headers, bold, italic
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')

  // Inline code
  s = s.replace(/`([^`]+)`/g, '$1')

  // List markers
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim()
  return s
}
