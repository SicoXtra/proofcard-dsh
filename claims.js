/**
 * Deterministic claim extraction for Proofcard DSH.
 *
 * The agent's final reply is split into sentence-like segments (fenced code ignored) and
 * matched against an explicit rule table. Only verifiable, non-negated, non-future
 * completion claims survive. Ambiguous text is dropped rather than guessed.
 */

export const CLAIM_KINDS = [
  'test_passed', 'file_changed', 'file_exists', 'command_ran',
  'url_fetched', 'commit', 'message_sent', 'count', 'assertion',
];

const MAX_SEGMENTS = 400;
const MAX_SEGMENT_CHARS = 600;
const PATH_EXT = 'py|pyi|js|mjs|cjs|jsx|ts|tsx|json|jsonc|ya?ml|toml|ini|cfg|conf|md|mdx|txt|rst|html?|css|scss|less|sh|bash|zsh|ps1|bat|cmd|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|sql|env|lock|svg|png|jpe?g|gif|webp|pdf|csv|tsv|xlsx?|docx?|pptx?';

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]{1,240})`/g;
const SPLIT_RE = /(?<=[.!?])\s+|\n+/;
const NEGATION_RE = /\b(?:not|never|no longer|didn't|did not|doesn't|does not|don't|do not|haven't|hasn't|hadn't|wasn't|weren't|wouldn't|shouldn't|isn't|aren't|cannot|can't|couldn't|could not|unable to|failed to|without)\b/i;
const FUTURE_RE = /\b(?:will|should|plan(?:ning)? to|going to|next step|todo|to do|i'll|we'll)\b/i;
const INSTRUCTION_RE = /^(?:then\s+|also\s+|now\s+|first\s+)?(?:use|look|open|click|ask|tell|try|run|check|continue|refresh|go|see|read|keep|make sure|remember|note|please|you can|you should|if you|to test|to verify|here'?s how)\b/i;
const EXAMPLE_RE = /\b(?:e\.g\.|for example|for instance|such as)\b/i;
const HEADING_RE = /^(?:#{1,6}\s|\*\*|\|)|\*\*$/;
const ADVICE_RE = /\b(?:you|your|you're|youre|whenever|send me|ask me|tell me|let me)\b/i;
const CONDITIONAL_RE = /^(?:if|when|unless|once)\b/i;
const RETRACTION_RE = /\b(?:retract(?:ing|ed|ion)?|withdraw(?:ing|n)?|claim was wrong|false claim|not a claim|no write happened|misclassified)\b/i;
const QUESTION_RE = /\?$/;
const PATH_RE = new RegExp(`(?<![\\w/.-])((?:[A-Za-z]:[\\\\/]|\\.{0,2}/)?(?:[\\w@.+~-]+[\\\\/])*[\\w@.+~-]+\\.(?:${PATH_EXT}))\\b`, 'g');
const TEST_CMD_RE = /\b((?:python\s+-m\s+)?pytest(?:\s+[^\s`'".,;)\]}]+)*|npm\s+(?:run\s+)?test(?:\s+[^\s`'".,;)\]}]+)*|yarn\s+test(?:\s+[^\s`'".,;)\]}]+)*|pnpm\s+test(?:\s+[^\s`'".,;)\]}]+)*|cargo\s+test(?:\s+[^\s`'".,;)\]}]+)*|go\s+test(?:\s+[^\s`'".,;)\]}]+)*|mvn\s+test(?:\s+[^\s`'".,;)\]}]+)*|gradle\s+test(?:\s+[^\s`'".,;)\]}]+)*|dotnet\s+test(?:\s+[^\s`'".,;)\]}]+)*)/i;
const TEST_PASS_RE = /\b(?:all\s+)?(?:the\s+)?(?<num>\d{1,6})?\s*(?<noun>tests?|specs?|test\s+suite|checks?|assertions?)\s+(?:now\s+)?(?:all\s+)?(?:pass|passes|passed|passing|are\s+green|is\s+green|succeed|succeeds|succeeded|are\s+ok|is\s+ok|are\s+clean)\b/i;
const TEST_PASS_ALT_RE = /\b(?:pytest|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|dotnet\s+test)\b[^.\n]{0,60}?\b(?:pass(?:ed|es|ing)?|green|succeed(?:ed|s)?|all\s+ok)\b/i;
const FILE_CHANGE_RE = /\b(?<action>created|wrote|written|updated|modified|edited|saved|added|patched|renamed|deleted|removed|generated|implemented|fixed|repaired|refactored)\b/i;
const FILE_EXISTS_RE = new RegExp(
  `(?:\\\`[^\\\`\\n]{1,200}\\\`\\s+(?:exists?|is\\s+present)|\\b(?:file|directory|folder|path|config|script|module)\\b[^\\n]{0,100}?\\b(?:exists?|is\\s+present|are\\s+present|now\\s+exists)\\b|\\bexists?\\b[^\\n]{0,40}?\\b(?:file|directory|folder)\\b|(?:[\\w@.+~\\\\/-]+\\.(?:${PATH_EXT}))\\s+(?:exists?|is\\s+present))`,
  'i',
);
const COMMAND_RAN_RE = /\b(?:ran|executed|run|invoked|launched)\b\s+(?:the\s+)?(?:command\s+)?(?<cmd>`[^`\n]{2,200}`)/i;
const COMMAND_WORD_RE = /\b(?:ran|executed|invoked)\b\s+(?:the\s+)?(?:command\s+)?(?<cmd>[a-z][\w.-]*(?:\s+[^\s.,;`)\]}\]]{1,40}){0,5})/i;
const URL_FETCH_RE = /\b(?:fetched|downloaded|visited|opened|retrieved|scraped|read)\b[^.\n]{0,60}?(?<url>https?:\/\/[^\s<>()\[\]"']{4,300})/i;
const URL_RE = /https?:\/\/[^\s<>()\[\]"']{4,300}/;
const COMMIT_RE = /\b(?:committed|pushed|opened\s+(?:a\s+)?(?:pr|pull\s+request)|created\s+(?:a\s+)?branch|merged|tagged)\b/i;
const MESSAGE_RE = /\b(?:sent|emailed|messaged|posted|notified|delivered|forwarded)\b[^.\n]{0,60}\b(?:message|email|report|summary|telegram|discord|slack|whatsapp|signal|notification|dm|file)\b/i;
const COUNT_RE = /\b(?:found|identified|detected|fixed|resolved|processed|counted|there\s+(?:are|were))\s+(?<num>\d{1,6})\s+(?<noun>[a-z][\w-]{1,30})|\b(?<num2>\d{1,6})\s+(?<noun2>files?|tests?|errors?|warnings?|items?|lines?|issues?|bugs?|failures?|matches?)\b[^.\n]{0,40}\b(?:found|identified|detected|fixed|resolved|processed|counted)\b/i;
const ASSERTION_RE = /\b(?:done|complete|completed|finished|fixed|implemented|works?|working|ready|resolved|ready to ship|shipped|achieved|solved)\b/i;
const META_RE = /\b(?:receipts?|proofcard|claims?|ledger|extractions?|verdicts?)\b/i;

const COMMAND_VERBS = new Set([
  'pytest', 'python', 'pip', 'uv', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'cargo',
  'go', 'mvn', 'gradle', 'dotnet', 'git', 'gh', 'docker', 'kubectl', 'make', 'bash', 'sh',
  'curl', 'wget', 'aws', 'terraform', 'psql', 'sqlite3', 'ruff', 'mypy', 'eslint', 'tsc',
]);

function stripFences(text) {
  return String(text || '').replace(FENCE_RE, '\n');
}

function segments(text) {
  const out = [];
  for (let part of stripFences(text).split(SPLIT_RE)) {
    let cleaned = part.trim().replace(/^[-*•\s\t#>]+/, '');
    cleaned = cleaned.replace(/^\d{1,3}[.)]\s+/, '').trim();
    if (cleaned.length < 8 || cleaned.length > MAX_SEGMENT_CHARS) continue;
    if (QUESTION_RE.test(cleaned)) continue;
    if (NEGATION_RE.test(cleaned) || FUTURE_RE.test(cleaned)) continue;
    if (INSTRUCTION_RE.test(cleaned) || EXAMPLE_RE.test(cleaned)) continue;
    if (HEADING_RE.test(cleaned) || ADVICE_RE.test(cleaned) || CONDITIONAL_RE.test(cleaned)) continue;
    if (RETRACTION_RE.test(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= MAX_SEGMENTS) break;
  }
  return out;
}

function cleanPath(candidate) {
  const value = String(candidate || '').trim().replace(/^[`'"([{<>,;]+|[`'")\]}<>,;]+$/g, '');
  if (!value || value.length > 240) return null;
  if (value.includes('...') || value.includes('<')) return null;
  if (/^(?:https?:\/\/|www\.)/i.test(value)) return null;
  if (/[\s\t\n]/.test(value)) return null;
  // Claims about files must name something that looks like a file. A route or a
  // directory ("/proofcard/actions", "src") is not a file claim.
  if (!new RegExp(`\\.(?:${PATH_EXT})$`, 'i').test(value)) return null;
  return value;
}

function pathIdentity(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  // Link text (relative) and a markdown-link target (absolute) name the same file;
  // the basename is the stable identity inside one claim.
  return (parts[parts.length - 1] || '').toLowerCase();
}

function pathsIn(segment) {
  const found = [];
  for (const match of segment.matchAll(INLINE_CODE_RE)) {
    const path = cleanPath(match[1]);
    if (path) found.push(path);
  }
  for (const match of segment.matchAll(PATH_RE)) {
    const path = cleanPath(match[1]);
    if (path) found.push(path);
  }
  const seen = new Set();
  const unique = [];
  for (const path of found) {
    // An absolute markdown-link target and the same relative path are one file.
    const key = pathIdentity(path);
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(path);
    }
  }
  return unique.slice(0, 5);
}

function commandsIn(segment) {
  const out = [];
  for (const match of segment.matchAll(INLINE_CODE_RE)) {
    const candidate = match[1].trim();
    const first = candidate.split(/\s+/)[0]?.toLowerCase() || '';
    if (COMMAND_VERBS.has(first) && (candidate.split(/\s+/).length > 1 || first === 'pytest')) out.push(candidate);
  }
  return out.slice(0, 3);
}

function testCommand(segment) {
  const match = segment.match(TEST_CMD_RE);
  if (match) return match[1].trim();
  for (const command of commandsIn(segment)) {
    if (/^(?:python\s+-m\s+)?(?:pytest|npm|yarn|pnpm|cargo|go|mvn|gradle|dotnet)/i.test(command)) return command;
  }
  return null;
}

function baseClaim(kind, text, subject) {
  return { kind, text: text.slice(0, 300), subject };
}

function matchRules(segment) {
  const matches = [];

  const pass = segment.match(TEST_PASS_RE) || segment.match(TEST_PASS_ALT_RE);
  if (pass) {
    const detail = segment.match(TEST_PASS_RE);
    const subject = { noun: ((detail?.groups?.noun || 'tests') + '').toLowerCase() };
    const command = testCommand(segment);
    if (command) subject.command = command;
    if (detail?.groups?.num) subject.count = Number(detail.groups.num);
    matches.push(baseClaim('test_passed', segment, subject));
  }

  const change = segment.match(FILE_CHANGE_RE);
  if (change) {
    // A write verb buried in explanatory prose ("the file was actually written")
    // is not a completion claim. Require the action near the start or a first-person claim.
    const firstPerson = /\b(?:i|we)\b/i.test(segment);
    if ((change.index ?? 999) <= 12 || firstPerson) {
      const paths = pathsIn(segment);
      if (paths.length) {
        let action = (change.groups?.action || 'changed').toLowerCase();
        if (['wrote', 'written', 'saved', 'generated'].includes(action)) action = 'created';
        if (['removed'].includes(action)) action = 'deleted';
        if (['implemented', 'fixed', 'repaired', 'refactored'].includes(action)) action = 'updated';
        matches.push(baseClaim('file_changed', segment, { paths, action }));
      }
    }
  }

  if (FILE_EXISTS_RE.test(segment) && !matches.some((item) => item.kind === 'file_changed')) {
    const paths = pathsIn(segment);
    if (paths.length) matches.push(baseClaim('file_exists', segment, { paths }));
  }

  const urlFetch = segment.match(URL_FETCH_RE);
  const urlLoose = !urlFetch && /\b(?:fetched|downloaded|visited|opened|retrieved|scraped)\b/i.test(segment)
    ? segment.match(URL_RE) : null;
  if (urlFetch || urlLoose) {
    const url = (urlFetch?.groups?.url || urlLoose?.[0] || '').replace(/[.,;]+$/, '');
    if (url) matches.push(baseClaim('url_fetched', segment, { url }));
  }

  if (COMMIT_RE.test(segment)) {
    const commands = commandsIn(segment).filter((command) => /^(?:git|gh)\b/i.test(command));
    const subject = { noun: 'commit' };
    if (commands.length) subject.command = commands[0];
    matches.push(baseClaim('commit', segment, subject));
  }

  const cmdRan = segment.match(COMMAND_RAN_RE);
  if (cmdRan) {
    const command = cmdRan.groups?.cmd?.replace(/`/g, '').trim();
    if (command) matches.push(baseClaim('command_ran', segment, { command }));
  } else if (matches.length === 0) {
    const loose = segment.match(COMMAND_WORD_RE);
    const candidate = loose?.groups?.cmd?.trim();
    if (candidate && COMMAND_VERBS.has(candidate.split(/\s+/)[0]?.toLowerCase())) {
      matches.push(baseClaim('command_ran', segment, { command: candidate }));
    }
  }

  if (MESSAGE_RE.test(segment)) {
    matches.push(baseClaim('message_sent', segment, { noun: 'message' }));
  }

  const strong = matches.filter((item) => item.kind !== 'count' && item.kind !== 'assertion');
  if (strong.length === 0) {
    const count = segment.match(COUNT_RE);
    if (count) {
      const num = count.groups?.num || count.groups?.num2;
      const noun = count.groups?.noun || count.groups?.noun2 || 'items';
      matches.push(baseClaim('count', segment, { count: Number(num), noun: noun.toLowerCase() }));
    }
  }

  if (matches.length === 0 && ASSERTION_RE.test(segment) && !META_RE.test(segment)) {
    matches.push(baseClaim('assertion', segment, {}));
  }

  return matches.slice(0, 2);
}

export function extractClaims(text, maxClaims = 12) {
  let limit = Number(maxClaims);
  if (!Number.isFinite(limit)) limit = 12;
  limit = Math.max(0, Math.min(Math.trunc(limit), 30));
  if (limit === 0 || typeof text !== 'string' || !text) return [];

  const claims = [];
  const seen = new Set();
  for (const segment of segments(text)) {
    for (const claim of matchRules(segment)) {
      const subjectKey = JSON.stringify(claim.subject, Object.keys(claim.subject).sort());
      const key = `${claim.kind}|${subjectKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claim.id = `c${claims.length + 1}`;
      claims.push(claim);
      if (claims.length >= limit) return claims;
    }
  }
  return claims;
}
