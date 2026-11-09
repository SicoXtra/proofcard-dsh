/** Secret redaction for Proofcard DSH receipts. */

const REDACTED = '[REDACTED]';

const PATTERNS = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bASIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/(\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key)\b\s*[:=]\s*)(['"]?)[^\s'"`,;]{8,}\2/gi, `$1$2${REDACTED}$2`],
  [/\b(bearer\s+)[A-Za-z0-9._-]{12,}/gi, `$1${REDACTED}`],
];

export function redact(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (!text) return '';
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function containsSecret(value) {
  if (!value || typeof value !== 'string') return false;
  return redact(value) !== value;
}
