import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const commands = await import('../extension/commands.js').catch(() => ({}));
const contentPath = new URL('../extension/content.js', import.meta.url);
function fixture(extra = '', url = 'https://x.com/person/status/123') {
  assert.ok(existsSync(contentPath), 'content adapter must exist');
  const dom = new JSDOM(`<button data-testid="SideNav_AccountSwitcher_Button">Hans <span>@hans</span></button>${extra}`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{}]; };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  dom.window.eval(readFileSync(contentPath, 'utf8'));
  return dom.window;
}
const editor = text => `<div role="dialog"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true">${text}</div><button data-testid="tweetButton">Post</button></div>`;

test('command notation preserves content and separates target URL', () => {
  assert.equal(typeof commands.parseCommand, 'function');
  assert.deepEqual(commands.parseCommand('NEW-POST: hello\nsecond line'), { action: 'NEW-POST', text: 'hello\nsecond line' });
  assert.deepEqual(commands.parseCommand('REPLY-TO: https://x.com/person/status/123\nHei æøå 👋'), { action: 'REPLY-TO', url: 'https://x.com/person/status/123', text: 'Hei æøå 👋' });
  assert.throws(() => commands.parseCommand('REPLY-TO: https://x.com/a/status/1'), /text/i);
});

test('account validation refuses missing or wrong accounts', () => {
  const win = fixture();
  assert.doesNotThrow(() => win.TypedPostXDOM.assertAccount('hans'));
  assert.throws(() => win.TypedPostXDOM.assertAccount('someoneelse'), /account/i);
  win.document.querySelector('button').remove();
  assert.throws(() => win.TypedPostXDOM.assertAccount('hans'), /login|account/i);
});

test('target lookup excludes different posts and nested quoted links', () => {
  const win = fixture('<article data-testid="tweet"><a href="/other/status/999"><time>now</time></a><div role="link"><a href="/person/status/123"><time>old</time></a></div></article>');
  assert.throws(() => win.TypedPostXDOM.targetArticle('https://x.com/person/status/123'), /target/i);
  const article = win.document.createElement('article'); article.dataset.testid = 'tweet'; article.innerHTML = '<a href="/person/status/123"><time>now</time></a>';
  win.document.body.append(article);
  assert.equal(win.TypedPostXDOM.targetArticle('https://x.com/person/status/123'), article);
});

test('nonempty drafts and ambiguous composers are refused', () => {
  let win = fixture(editor('existing draft'));
  assert.throws(() => win.TypedPostXDOM.emptyEditor(), /draft|empty/i);
  win = fixture(editor('') + editor(''));
  assert.throws(() => win.TypedPostXDOM.emptyEditor(), /ambiguous/i);
  win = fixture(editor(''));
  assert.equal(win.TypedPostXDOM.emptyEditor().getAttribute('role'), 'textbox');
});

test('readback preserves spaces, emoji and normalizes only line endings', () => {
  const win = fixture(editor(' hello æøå 👋\nworld '));
  assert.equal(win.TypedPostXDOM.readText(win.document.querySelector('[role=textbox]')), ' hello æøå 👋\nworld ');
});

test('requireTargetInComposer confirms modal reply and quote previews without status links', () => {
  const replyJob = { action: 'REPLY-TO', url: 'https://x.com/person/status/123' };
  let win = fixture('<div role="dialog" id="dlg">Replying to <a href="/person">@person</a><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div></div>', 'https://x.com/compose/post');
  assert.doesNotThrow(() => win.TypedPostXDOM.requireTargetInComposer(replyJob, win.document.getElementById('dlg')));

  const quoteJob = { action: 'QUOTE', url: 'https://x.com/person/status/123' };
  win = fixture('<div role="dialog" id="dlg"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><div data-testid="attachments"><span>Person</span><span>@person</span><time datetime="2026-11-18T10:00:00.000Z">1h</time></div></div>', 'https://x.com/compose/post');
  assert.doesNotThrow(() => win.TypedPostXDOM.requireTargetInComposer(quoteJob, win.document.getElementById('dlg')));
});

test('requireTargetInComposer rejects blank dialogs and wrong or prefix-matching handles', () => {
  const replyJob = { action: 'REPLY-TO', url: 'https://x.com/person/status/123' };
  let win = fixture('<div role="dialog" id="dlg"><div data-testid="UserAvatar-Container-person"></div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div></div>');
  assert.throws(() => win.TypedPostXDOM.requireTargetInComposer(replyJob, win.document.getElementById('dlg')), /confirm/i);

  win = fixture('<div role="dialog" id="dlg">Replying to <a href="/someoneelse">@someoneelse</a></div>');
  assert.throws(() => win.TypedPostXDOM.requireTargetInComposer(replyJob, win.document.getElementById('dlg')), /confirm/i);

  win = fixture('<div role="dialog" id="dlg">Replying to <a href="/person_2">@person_2</a></div>');
  assert.throws(() => win.TypedPostXDOM.requireTargetInComposer(replyJob, win.document.getElementById('dlg')), /confirm/i);
});

test('targetArticle and verify ignore nested quote card links and text', async () => {
  const quoteArticle = '<article data-testid="tweet"><div data-testid="tweetText">My outer commentary</div><div role="link"><a href="/melvynx/status/123"><time>old</time></a><div data-testid="tweetText">Quoted original text</div></div><a href="/hans/status/999"><time>now</time></a></article>';
  const win = fixture(quoteArticle, 'https://x.com/hans/status/999');
  const article = win.TypedPostXDOM.targetArticle('https://x.com/hans/status/999');
  assert.equal(article.tagName, 'ARTICLE');
  const verified = await win.TypedPostXDOM.verify({ url: 'https://x.com/hans/status/999', expectedAccount: 'hans', text: 'My outer commentary' });
  assert.equal(verified.url, 'https://x.com/hans/status/999');
});

test('prepare ignores background inline composer and guard recovers focus from modal button', async () => {
  const html = [
    '<div data-testid="primaryColumn"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" tabindex="0"></div></div>',
    '<article data-testid="tweet"><a href="/person/status/123"><time datetime="2026-11-18T10:00:00.000Z">1h</time></a><button data-testid="reply">Reply</button></article>'
  ].join('');
  const win = fixture(html, 'https://x.com/person/status/123');
  win.document.hasFocus = () => true;
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  win.Element.prototype.scrollIntoView = () => {};

  const replyBtn = win.document.querySelector('[data-testid="reply"]');
  replyBtn.addEventListener('click', () => {
    const dlg = win.document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.innerHTML = '<button data-testid="app-bar-close">Close</button><span>Replying to <a href="/person">@person</a></span><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" tabindex="0"></div><button data-testid="tweetButton">Post</button>';
    win.document.body.append(dlg);
    dlg.querySelector('[data-testid="app-bar-close"]').focus();
  });

  try {
    await win.TypedPostXDOM.prepare({
      job: { action: 'REPLY-TO', url: 'https://x.com/person/status/123', text: 'Hello' },
      marker: 'TypedPostX:m1',
      expectedAccount: 'hans'
    });
    const modalEditor = win.document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]');
    const closeBtn = win.document.querySelector('[data-testid="app-bar-close"]');
    assert.equal(win.document.activeElement, modalEditor);

    closeBtn.focus();
    assert.equal(win.document.activeElement, closeBtn);

    const state = await win.TypedPostXDOM.guard('TypedPostX:m1');
    assert.equal(state.text, '');
    assert.equal(win.document.activeElement, modalEditor);
  } finally {
    win.TypedPostXDOM.cleanup();
  }
});
