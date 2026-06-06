// Brand logos for each agent, keyed by agent id. Drop the official SVG into
// src/assets/logos/<id>.svg to update — no code change needed.
import claudeCode from '@/assets/logos/claude-code.svg'
import codex from '@/assets/logos/codex.svg'
import opencode from '@/assets/logos/opencode.svg'

export const LOGOS: Record<string, string> = {
  'claude-code': claudeCode,
  codex,
  opencode
}
