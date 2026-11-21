function tidyText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function stripMarkdown(text) {
  return tidyText(
    text
      .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/^>\s?/gm, ''),
  );
}

function toBullets(text) {
  const lines = tidyText(text)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[-*•\d.]+\s*/, ''))
    .map(l => `- ${l}`);
  return lines.join('\n');
}

function quoteReply(text) {
  return tidyText(text)
    .split('\n')
    .map(l => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

function countWords(text) {
  const m = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u3400-\u4dbf\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};
  if (kind !== 'action' || contribution !== 'text.transform') {
    throw new Error('不支持的动作');
  }
  const { mode, text } = input;
  let result;
  if (mode === 'tidy') result = tidyText(text);
  else if (mode === 'strip_markdown') result = stripMarkdown(text);
  else if (mode === 'to_bullets') result = toBullets(text);
  else if (mode === 'quote_reply') result = quoteReply(text);
  else throw new Error('未知模式');

  const lines = result ? result.split('\n').length : 0;
  return {
    result,
    chars: Array.from(result).length,
    words: countWords(result),
    lines,
  };
}
