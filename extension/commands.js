export function parseCommand(raw) {
  const value = String(raw).replace(/\r\n?/g, '\n');
  const match = /^(NEW-POST|REPLY-TO|QUOTE):[ \t]?([\s\S]*)$/.exec(value);
  if (!match) throw Error('Start with NEW-POST:, REPLY-TO:, or QUOTE:');
  const action = match[1];
  if (action === 'NEW-POST') {
    if (!match[2].trim()) throw Error('Add the post text');
    return { action, text: match[2] };
  }
  const newline = match[2].indexOf('\n');
  if (newline < 0 || !match[2].slice(newline + 1).trim()) throw Error('Put the target URL on the first line and the text on the following line');
  return { action, url: match[2].slice(0, newline).trim(), text: match[2].slice(newline + 1) };
}
