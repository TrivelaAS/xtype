import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const commands = await import('../extension/commands.js').catch(() => ({}));
const contentPath = new URL('../extension/content.js', import.meta.url);
function fixture(extra = '') {
  assert.ok(existsSync(contentPath), 'content adapter must exist');
  const dom = new JSDOM(`<button data-testid="SideNav_AccountSwitcher_Button">Hans <span>@hans</span></button>${extra}`, { url: 'https://x.com/person/status/123', runScripts: 'outside-only', pretendToBeVisual: true });
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
