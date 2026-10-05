function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ');
}

function longestBacktickRun(value) {
  let longest = 0;
  for (const match of value.matchAll(/\x60+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

export function markdownCodeSpan(value) {
  const text = normalizeInlineText(value);
  const marker = String.fromCharCode(96).repeat(longestBacktickRun(text) + 1);
  const padding = /^[\x60 ]|[\x60 ]$/u.test(text) ? ' ' : '';
  return marker + padding + text + padding + marker;
}

export function markdownCodeFence(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
  const marker = String.fromCharCode(96).repeat(Math.max(3, longestBacktickRun(text) + 1));
  return marker + '\n' + text + '\n' + marker;
}
