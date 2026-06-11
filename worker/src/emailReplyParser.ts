/*
 * Worker-safe adaptation of crisp-oss/email-reply-parser (MIT).
 * We keep the core fragment-parsing algorithm, but avoid Node-only RE2 loading
 * so it can run safely inside Cloudflare Workers.
 */

interface FragmentDTO {
  lines: string[]
  isHidden: boolean
  isSignature: boolean
  isQuoted: boolean
}

interface ParsedFragment {
  content: string
  isHidden: boolean
  isQuoted: boolean
}

const QUOTE_REGEX = /(>+)$/;
const LEADING_WHITESPACE_REGEX = /^\s+/;
const LEADING_NEWLINE_REGEX = /^\n/g;
const CRLF_NEWLINE_REGEX = /\r\n/g;
const NEWLINE_REGEX = /\n/g;
const TRAILING_TILDE_REGEX = /~*$/;

const QUOTE_HEADER_REGEXES = [
  /^-*\s*(On\s.+\s.+\n?wrote:{0,1})\s{0,1}-*$/m,
  /^-*\s*(Le\s.+\s.+\n?écrit\s?:{0,1})\s{0,1}-*$/m,
  /^-*\s*(El\s.+\s.+\n?escribió:{0,1})\s{0,1}-*$/m,
  /^-*\s*(Il\s.+\s.+\n?scritto:{0,1})\s{0,1}-*$/m,
  /^-*\s*(Em\s.+\s.+\n?escreveu:{0,1})\s{0,1}-*$/m,
  /^\s*(Am\s.+\s)\n?\n?schrieb.+\s?(\[|<).+(\]|>):$/m,
  /^\s*(Op\s[\s\S]+?\n?schreef[\s\S]+:)$/m,
  /^\s*((W\sdniu|Dnia)\s[\s\S]+?(pisze|napisał(\(a\))?):)$/mu,
  /^\s*(Den\s.+\s\n?skrev\s.+:)$/m,
  /^\s*(pe\s.+\s.+\n?kirjoitti:)$/m,
  /^\s*(Am\s.+\sum\s.+\s\n?schrieb\s.+:)$/m,
  /^\s*(ср\,\s.+\n? г\. в\s.+,\s.+[\[|<].+[\]|>]:)$/m,
  /^(在[\s\S]+写道：)$/m,
  /^(20[0-9]{2}\..+\s작성:)$/m,
  /^(20[0-9]{2}\/.+のメッセージ:)$/m,
  /^(.+\s<.+>\sschrieb:)$/m,
  /^(.+\son.*at.*wrote:)$/m,
  /^\s*(From\s?:.+\s?\n?\s*[\[|<].+[\]|>])/m,
  /^\s*(Von\s?:.+\s?\n?\s*[\[|<].+[\]|>])/m,
  /^\s*(De\s?:.+\s?\n?\s*(\[|<).+(\]|>))/m,
  /^\s*(Van\s?:.+\s?\n?\s*(\[|<).+(\]|>))/m,
  /^\s*(Da\s?:.+\s?\n?\s*(\[|<).+(\]|>))/m,
  /^(20[0-9]{2})-([0-9]{2}).([0-9]{2}).([0-9]{2}):([0-9]{2})\n?(.*)>:$/m,
  /^\s*([a-z]{3,4}\.\s[\s\S]+\sskrev\s[\s\S]+:)$/m,
  /^([0-9]{2}).([0-9]{2}).(20[0-9]{2})(.*)(([0-9]{2}).([0-9]{2}))(.*)\"( *)<(.*)>( *):$/m,
  /^[0-9]{2}:[0-9]{2}(.*)[0-9]{4}(.*)\"( *)<(.*)>( *):$/,
  /^(.*)[0-9]{4}(.*)from(.*)<(.*)>:$/,
  /^-{1,12} ?(O|o)riginal (M|m)essage ?-{1,12}$/i,
  /^-{1,12} ?(O|o)prindelig (B|b)esked ?-{1,12}$/i,
  /^-{1,12} ?(M|m)essage d'origine ?-{1,12}$/i,
  /^-{1,12} ?(U|u)rsprüngliche (N|n)achricht ?-{0,12}$/i,
  /^At\s.+wrote:\s*$/i,
  /^At\s.+,\s*[^\s<>@]+@[^\s<>]+\s+wrote:\s*$/i,
  /^.+<[^>]+>\s*于.+写道：\s*$/i,
  /^<[^>]+>\s*于.+写道：\s*$/i,
  /^[^<\n>]*\s*于.+写道：\s*$/i,
  /^.+<[^>]+>\s*於.+寫道：\s*$/i,
  /^<[^>]+>\s*於.+寫道：\s*$/i,
  /^[^<\n>]*\s*於.+寫道：\s*$/i,
  /^在\s*.+<[^>]+>\s*写道：\s*$/i,
  /^在\s*.+<[^>]+>\s*寫道：\s*$/i,
  /^在\s*.+，[^\s<>@]+@[^\s<>]+\s*写道：\s*$/i,
  /^在\s*.+，[^\s<>@]+@[^\s<>]+\s*寫道：\s*$/i,
  /^.+<[^>]+>\s*が.+書きました[:：]\s*$/i,
  /^<[^>]+>\s*が.+書きました[:：]\s*$/i,
  /^.+<[^>]+>\s*님이.+작성[:：]\s*$/i,
  /^<[^>]+>\s*님이.+작성[:：]\s*$/i,
]

const SIGNATURE_REGEXES = [
  /^\s*-{2,4}$/,
  /^\s*_{2,4}$/,
  /^-- $/,
  /^\+{2,4}$/,
  /^\={2,4}$/,
  /^________________________________$/,
  /^Sent from (?:\s*.+)$/,
  /^Get Outlook for (?:\s*.+).*/m,
  /^Cheers,?!?$/mi,
  /^Best wishes,?!?$/mi,
  /^\w{0,20}\s?(\sand\s)?Regards,?!?！?$/mi,
  /^Von (?:\s*.+) gesendet$/,
  /^Gesendet von (?:\s*.+) für (?:\s*.+)$/,
  /^Sendt fra (?:\s*.+)$/,
  /^Envoyé depuis (?:\s*.+)$/,
  /^Envoyé de mon (?:\s*.+)$/,
  /^Envoyé à partir de (?:\s*.+)$/,
  /^Télécharger Outlook pour (?:\s*.+).*/m,
  /^Bien . vous,?!?$/mi,
  /^\w{0,20}\s?cordialement,?!?$/mi,
  /^Bonne (journ.e|soir.e)!?$/mi,
  /^Enviado desde (?:\s*.+)$/,
  /^-*\s*(In\sdata\s.+\s.+\n?scritto:{0,1})\s{0,1}-*$/m,
  /^Verzonden vanaf (?:\s*.+)$/,
  /^Verstuurd vanaf (?:\s*.+)$/,
]

export function parseVisibleReply(text: string): string {
  if (!text) return ''

  const normalized = text.replace(CRLF_NEWLINE_REGEX, '\n')
  const fragments = parseFragments(fixBrokenQuoteHeaders(normalized))
  const visible = fragments
    .filter((fragment) => !fragment.isHidden)
    .map((fragment) => fragment.content)
    .join('\n')
    .replace(TRAILING_TILDE_REGEX, '')

  return visible.trim()
}

export function hasReplyParserMarkers(text: string): boolean {
  if (!text) return false

  const normalized = text.replace(CRLF_NEWLINE_REGEX, '\n')
  if (QUOTE_HEADER_REGEXES.some((regex) => regex.test(normalized))) {
    return true
  }

  const lines = normalized.split('\n')
  for (const line of lines) {
    const candidate = stripLeadingQuotePrefixes(line).trim()
    if (!candidate) continue
    if (QUOTE_HEADER_REGEXES.some((regex) => regex.test(candidate))) {
      return true
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const current = stripLeadingQuotePrefixes(lines[index] ?? '').trim()
    const next = stripLeadingQuotePrefixes(lines[index + 1] ?? '').trim()
    if (!current || !next) continue
    if (/^At\s.+,\s*[^\s<>@]+@[^\s<>]+\s+wrote:\s*$/i.test(current) && /^>/.test(lines[index + 1] ?? '')) {
      return true
    }
    if (/^[^<\n>]*\s*[于於].+写道：\s*$/i.test(current) && /^>/.test(lines[index + 1] ?? '')) {
      return true
    }
  }

  const tail = lines
    .map((line) => stripLeadingQuotePrefixes(line).trim())
    .filter(Boolean)
    .slice(-3)

  return tail.some((line) => SIGNATURE_REGEXES.some((regex) => regex.test(line)))
}

function parseFragments(text: string): ParsedFragment[] {
  const fragmentDTOs: FragmentDTO[] = []
  let fragment: FragmentDTO | null = null

  for (const line of reverseString(text).split('\n')) {
    let nextLine = rtrimChar(line, '\n')
    if (!isSignature(nextLine)) {
      nextLine = nextLine.replace(LEADING_WHITESPACE_REGEX, '')
    }

    if (fragment) {
      const last = fragment.lines[fragment.lines.length - 1] ?? ''
      if (isSignature(last)) {
        fragment.isSignature = true
        addFragment(fragmentDTOs, fragment)
        fragment = null
      } else if (nextLine === '' && isQuoteHeader(last)) {
        fragment.isQuoted = true
        addFragment(fragmentDTOs, fragment)
        fragment = null
      }
    }

    const quoted = QUOTE_REGEX.test(nextLine)
    if (fragment === null || !isFragmentLine(fragment, nextLine, quoted)) {
      if (fragment !== null) {
        addFragment(fragmentDTOs, fragment)
      }
      fragment = {
        lines: [],
        isHidden: false,
        isSignature: false,
        isQuoted: quoted,
      }
    }

    fragment.lines.push(nextLine)
  }

  if (fragment !== null) {
    addFragment(fragmentDTOs, fragment)
  }

  return fragmentDTOs
    .reverse()
    .map((entry) => ({
      content: reverseString(entry.lines.join('\n')).replace(LEADING_NEWLINE_REGEX, ''),
      isHidden: entry.isHidden,
      isQuoted: entry.isQuoted,
    }))
}

function fixBrokenQuoteHeaders(text: string): string {
  let next = text

  for (const regex of QUOTE_HEADER_REGEXES) {
    const matches = next.match(regex)
    const matchGroup = matches?.[1]
    if (!matchGroup) continue
    next = next.replace(matchGroup, matchGroup.replace(NEWLINE_REGEX, ' '))
  }

  return next
}

function isQuoteHeader(line: string): boolean {
  const restored = reverseString(line)
  return QUOTE_HEADER_REGEXES.some((regex) => regex.test(restored))
}

function isSignature(line: string): boolean {
  const restored = reverseString(line)
  return SIGNATURE_REGEXES.some((regex) => regex.test(restored))
}

function isFragmentLine(fragment: FragmentDTO, line: string, isQuoted: boolean): boolean {
  return fragment.isQuoted === isQuoted
    || (fragment.isQuoted && (isQuoteHeader(line) || line === ''))
}

function addFragment(fragments: FragmentDTO[], fragment: FragmentDTO): void {
  if (fragment.isQuoted || fragment.isSignature || isEmpty(fragment)) {
    fragment.isHidden = true
  }
  fragments.push(fragment)
}

function isEmpty(fragment: FragmentDTO): boolean {
  return fragment.lines.join('') === ''
}

function reverseString(text: string): string {
  let result = ''
  for (let index = text.length - 1; index >= 0; index -= 1) {
    result += text.substring(index, index + 1)
  }
  return result
}

function rtrimChar(text: string, mask: string): string {
  let next = text
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (mask !== next.charAt(index)) {
      next = next.substring(0, index + 1)
      break
    }
  }
  return next
}

function stripLeadingQuotePrefixes(line: string): string {
  return line.replace(/^\s*(?:>\s*)+/, '')
}
