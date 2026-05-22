const REPLY_SEPARATOR_MARKERS = [
  'Original Message',
  'Original Mail',
  'Original Email',
  'Replied Message',
  'Forwarded Message',
  '原始邮件',
  '原始邮件信息',
  '原邮件',
  '邮件原文',
  '转发邮件',
  '转发邮件信息',
  '转发消息',
  '転送メッセージ',
  '返信メッセージ',
  '전달된 메시지',
  '회신 메시지',
]

const FORWARDED_SEPARATOR_PATTERNS = [
  /^[-_\s]*forwarded (?:message|mail|email)[-_\s]*$/i,
  /^[-_\s]*begin forwarded message:?\s*[-_]*$/i,
  /^[-_\s]*转发(?:邮件|消息)(?:信息)?[-_\s]*$/,
]

const HEADER_LABEL_MARKERS = [
  'From',
  'Sent',
  'To',
  'Cc',
  'Subject',
  'Date',
  '发件人',
  '发送时间',
  '发送日期',
  '收件人',
  '抄送',
  '主题',
  '主 题',
  '日期',
  '差出人',
  '送信日時',
  '宛先',
  '件名',
  '日付',
  'Cc',
  '보낸사람',
  '보낸 날짜',
  '받는사람',
  '참조',
  '제목',
  '날짜',
]

const ATTRIBUTION_LINE_PATTERNS = [
  /^On\s.+wrote:\s*$/i,
  /^At\s.+wrote:\s*$/i,
  /^.+<[^>]+>\s*于.+写道：\s*$/i,
  /^<[^>]+>\s*于.+写道：\s*$/i,
  /^.+<[^>]+>\s*於.+寫道：\s*$/i,
  /^<[^>]+>\s*於.+寫道：\s*$/i,
  /^在\s*.+<[^>]+>\s*写道：\s*$/i,
  /^在\s*.+<[^>]+>\s*寫道：\s*$/i,
  /^在\s*.+，[^\s<>@]+@[^\s<>]+\s*写道：\s*$/i,
  /^在\s*.+，[^\s<>@]+@[^\s<>]+\s*寫道：\s*$/i,
  /^.+<[^>]+>\s*が.+書きました[:：]\s*$/i,
  /^<[^>]+>\s*が.+書きました[:：]\s*$/i,
  /^.+<[^>]+>\s*님이.+작성[:：]\s*$/i,
  /^<[^>]+>\s*님이.+작성[:：]\s*$/i,
]

type MailSectionKind = 'forwarded' | 'original'

interface MailSectionMarker {
  index: number
  kind: MailSectionKind
}

export interface MailChatProjection {
  text: string
  renderText: string | null
}

export function buildMailChatProjection(input: { bodyText?: string; bodyHTML?: string }): MailChatProjection {
  return {
    text: extractChatTextFromSources(input),
    renderText: extractRenderableHTMLFromSources(input),
  }
}

export function extractChatTextFromSources(input: { bodyText?: string; bodyHTML?: string }): string {
  const plainText = normalizeText(normalizePossiblyHtmlText(unpackEncodedUrlPayload(input.bodyText)))
  const htmlText = normalizeText(htmlToText(input.bodyHTML))
  const source = selectPreferredSource(plainText, htmlText)
  if (!source) return ''
  return extractChatText(source)
}

export function extractRenderableHTMLFromSources(input: { bodyText?: string; bodyHTML?: string }): string | null {
  const htmlSource = normalizeRenderableHTMLSource(input.bodyHTML)
  if (htmlSource) return htmlSource

  const plainSource = normalizeRenderableHTMLSource(unpackEncodedUrlPayload(input.bodyText))
  if (plainSource) return plainSource

  return null
}

function normalizeText(text?: string): string {
  return (text ?? '').replace(/\r\n/g, '\n').trim()
}

function extractChatText(text?: string): string {
  const normalized = normalizeText(text)
  if (!normalized) return ''

  const wrappedText = extractMailWrappedChatText(normalized)
  if (wrappedText !== null) {
    return wrappedText
  }

  const boundaryIndex = findQuotedReplyBoundary(normalized)
  if (boundaryIndex === null) {
    return normalized
  }

  const stripped = normalized
    .split('\n')
    .slice(0, boundaryIndex)
    .join('\n')
    .trim()

  return stripped || normalized
}

function extractMailWrappedChatText(normalized: string): string | null {
  const lines = normalized.split('\n')
  const marker = findMailSectionMarker(lines)
  if (marker) {
    const quoteDepth = quotePrefixDepth(lines[marker.index])
    const mailLines = quoteDepth > 0
      ? lines.map((line, index) => index >= marker.index ? stripQuotePrefixes(line, quoteDepth) : line)
      : lines
    const intro = lines
      .slice(0, marker.index)
      .join('\n')
      .trim()

    if (marker.kind === 'original' && intro && !hasForwardingIntent(intro)) {
      return null
    }

    const bodyStart = forwardedBodyStartIndex(mailLines, marker.index + 1)
    const body = mailLines
      .slice(bodyStart)
      .join('\n')
      .trim()

    if (intro && body) {
      return `${intro}\n\n${body}`
    }
    if (body) return body
    if (intro && marker.kind === 'forwarded') return intro
    return normalized
  }

  const headerStart = leadingHeaderBlockIndex(lines)
  if (headerStart === null) return null

  const quoteDepth = quotePrefixDepth(lines[headerStart])
  const mailLines = quoteDepth > 0
    ? lines.map((line, index) => index >= headerStart ? stripQuotePrefixes(line, quoteDepth) : line)
    : lines
  const bodyStart = forwardedBodyStartIndex(mailLines, headerStart)
  const body = mailLines
    .slice(bodyStart)
    .join('\n')
    .trim()

  return body || normalized
}

function findQuotedReplyBoundary(normalized: string): number | null {
  const lines = normalized.split('\n')
  let seenContent = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    if (!seenContent) {
      if (!isQuotedLine(trimmed) && !isHeaderLine(trimmed) && !isOriginalMessageSeparator(trimmed) && !isTableHeaderLine(trimmed)) {
        seenContent = true
      }
      continue
    }

    if (
      isOriginalMessageSeparator(trimmed)
      || isAttributionLine(trimmed)
      || startsHeaderBlock(lines, index)
      || startsQuotedReplyBlock(lines, index)
    ) {
      return index
    }
  }

  return null
}

function isAttributionLine(line: string): boolean {
  return ATTRIBUTION_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function isForwardedMessageSeparator(line: string): boolean {
  return FORWARDED_SEPARATOR_PATTERNS.some((pattern) => pattern.test(line))
}

function findMailSectionMarker(lines: string[]): MailSectionMarker | null {
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = mailComparableLine(lines[index])
    if (!trimmed) continue

    const kind = mailSectionMarkerKind(trimmed)
    if (kind) {
      return { index, kind }
    }
  }

  return null
}

function mailSectionMarkerKind(line: string): MailSectionKind | null {
  if (isForwardedMessageSeparator(line)) return 'forwarded'
  if (isOriginalMessageSeparator(line)) return 'original'
  return null
}

function leadingHeaderBlockIndex(lines: string[]): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = mailComparableLine(lines[index])
    if (!trimmed) continue
    return startsHeaderBlock(lines, index) ? index : null
  }

  return null
}

function hasForwardingIntent(intro: string): boolean {
  const normalized = intro
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim()

  if (!normalized || normalized.length > 300) return false

  return [
    /\bfyi\b/i,
    /\bfwd?:/i,
    /\bforward(?:ed)?\b/i,
    /\bplease\s+(?:see|check|review)\b/i,
    /\bfor your reference\b/i,
    /转发/,
    /分享/,
    /帮我看/,
    /看下/,
    /看看/,
    /请看/,
    /供参考/,
    /参考一下/,
  ].some((pattern) => pattern.test(normalized))
}

function mailComparableLine(line: string): string {
  return stripQuotePrefixes(line, quotePrefixDepth(line)).trim()
}

function quotePrefixDepth(line: string): number {
  let rest = line.trimStart()
  let depth = 0
  while (rest.startsWith('>')) {
    depth += 1
    rest = rest.slice(1).trimStart()
  }
  return depth
}

function stripQuotePrefixes(line: string, depth: number): string {
  let rest = line
  for (let count = 0; count < depth; count += 1) {
    rest = rest.replace(/^\s*>\s?/, '')
  }
  return rest
}

function forwardedBodyStartIndex(lines: string[], startIndex: number): number {
  let index = startIndex
  let skippedHeader = false

  while (index < lines.length) {
    const trimmed = mailComparableLine(lines[index])
    if (!trimmed) {
      index += 1
      if (skippedHeader) {
        while (index < lines.length && !mailComparableLine(lines[index])) {
          index += 1
        }
        break
      }
      continue
    }

    if (isForwardedMessageSeparator(trimmed) || isOriginalMessageSeparator(trimmed)) {
      index += 1
      continue
    }

    if (isHeaderLine(trimmed) || isTableHeaderLine(trimmed)) {
      skippedHeader = true
      index += 1
      continue
    }

    if (skippedHeader && /^\s+\S/.test(lines[index])) {
      index += 1
      continue
    }

    break
  }

  return index
}

function isOriginalMessageSeparator(line: string): boolean {
  const escapedMarkers = REPLY_SEPARATOR_MARKERS.map(separatorMarkerPattern).join('|')
  return new RegExp(`^(?:[-_\\s]{2,})?(?:${escapedMarkers})\\s*[:：]?(?:[-_\\s]{2,})?$`, 'i').test(mailComparableLine(line))
}

function isHeaderLine(line: string): boolean {
  const escapedLabels = HEADER_LABEL_MARKERS.map((label) => escapeRegExp(label).replace(/\s+/g, '\\s*')).join('|')
  return new RegExp(`^(?:${escapedLabels})\\s*[:：]`, 'i').test(mailComparableLine(line))
}

function isTableHeaderLine(line: string): boolean {
  const escapedLabels = HEADER_LABEL_MARKERS.map((label) => escapeRegExp(label).replace(/\s+/g, '\\s*')).join('|')
  return new RegExp(`^\\|\\s*(?:${escapedLabels})\\s*\\|`, 'i').test(mailComparableLine(line))
}

function isQuotedLine(line: string): boolean {
  return /^>+\s?/.test(line)
}

function startsHeaderBlock(lines: string[], startIndex: number): boolean {
  let headerCount = 0

  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = mailComparableLine(lines[index])
    if (!trimmed) {
      if (headerCount > 0) break
      continue
    }
    if (isTableHeaderLine(trimmed)) {
      headerCount += 1
      if (headerCount >= 2) {
        return true
      }
      continue
    }
    if (!isHeaderLine(trimmed)) break

    headerCount += 1
    if (headerCount >= 2) {
      return true
    }
  }

  return false
}

function startsQuotedReplyBlock(lines: string[], startIndex: number): boolean {
  const unquotedLines: string[] = []

  for (let index = startIndex; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (unquotedLines.length > 0) {
        unquotedLines.push('')
      }
      continue
    }
    if (!isQuotedLine(trimmed)) break

    unquotedLines.push(stripQuotePrefixes(rawLine, quotePrefixDepth(rawLine)).trim())
  }

  const meaningfulLines = unquotedLines.filter((line) => line.length > 0)
  if (meaningfulLines.length < 3) return false

  if (meaningfulLines.some((line) => isAttributionLine(line))) {
    return true
  }

  if (leadingHeaderBlockIndex(unquotedLines) !== null) {
    return true
  }

  return findMailSectionMarker(unquotedLines) !== null
}

function htmlToText(html?: string): string {
  if (!html) return ''

  const withoutTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|table|section|article|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  return normalizeHtmlText(decodeHtmlEntities(withoutTags))
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, token: string) => {
    const lower = token.toLowerCase()
    if (lower === 'nbsp') return ' '
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return '\''

    if (lower.startsWith('#x')) {
      const value = Number.parseInt(lower.slice(2), 16)
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity
    }

    if (lower.startsWith('#')) {
      const value = Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity
    }

    return entity
  })
}

function normalizeHtmlText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function normalizePossiblyHtmlText(text?: string): string {
  const normalized = normalizeText(text)
  if (!normalized) return ''
  if (/<br\s*\/?>|<\/?[a-z][^>]*>/i.test(normalized)) {
    return htmlToText(normalized)
  }
  return normalized
}

function unpackEncodedUrlPayload(text?: string): string {
  const normalized = normalizeText(text)
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    return normalized
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(normalized)
  } catch {
    return normalized
  }
  if (!decoded || decoded === normalized) {
    return normalized
  }

  const firstBreakIndex = decoded.search(/<br\s*\/?>|\n/i)
  if (firstBreakIndex <= 0) {
    return normalized
  }

  const prefix = decoded.slice(0, firstBreakIndex).trim()
  if (!/^https?:\/\/\S+$/i.test(prefix)) {
    return normalized
  }

  return decoded
}

function selectPreferredSource(plainText: string, htmlText: string): string {
  if (!plainText) return htmlText
  if (!htmlText) return plainText

  const plainLooksLikeHTML = /<br\s*\/?>|<\/?[a-z][^>]*>/i.test(plainText)
  const htmlPreservesBreaksBetter = htmlText.includes('\n') && !plainText.includes('\n')

  if (plainLooksLikeHTML || htmlPreservesBreaksBetter) {
    return htmlText
  }

  return plainText
}

function normalizeRenderableHTMLSource(text?: string): string {
  const normalized = normalizeText(text)
  if (!normalized) return ''
  return containsRenderableHTMLMarkup(normalized) ? normalized : ''
}

function containsRenderableHTMLMarkup(text: string): boolean {
  return /<br\s*\/?>|<\/?(?:p|div|strong|b|em|i|code|pre|blockquote|ul|ol|li|a|h[1-6]|hr|img|table|thead|tbody|tfoot|tr|th|td)\b[^>]*>/i.test(text)
}

function separatorMarkerPattern(marker: string): string {
  if (containsCJK(marker)) {
    return Array.from(marker)
      .filter((char) => !/\s/.test(char))
      .map(escapeRegExp)
      .join('\\s*')
  }

  return escapeRegExp(marker).replace(/\s+/g, '\\s*')
}

function containsCJK(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
