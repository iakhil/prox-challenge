/** True if spoken transcript should trigger TTS of the last reply instead of a new chat turn. */

export function isReadAloudIntent(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  if (t.length < 4 || t.length > 120) return false

  const patterns = [
    /^read (that|it|this)\b/,
    /^read (the )?answer\b/,
    /^read (this )?aloud\b/,
    /^read it (out |to me|for me)\b/,
    /^speak (the )?answer\b/,
    /^say (that|it)\b/,
    /^can you read (that|it)\b/,
    /^please read (that|it|aloud)\b/,
    /\bread that aloud\b/,
    /\bread this aloud\b/,
  ]

  return patterns.some((p) => p.test(t))
}
