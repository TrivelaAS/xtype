(() => {
  if (globalThis.TypedPostXDOM) return;
  const visible = element => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const readText = editor => {
    const blocks = editor?.querySelectorAll?.('[data-block="true"]');
    if (blocks?.length) return [...blocks].map(b => b.textContent ?? '').join('\n').replace(/\u200B/g, '').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
    return (editor.innerText ?? editor.textContent ?? '').replace(/\u200B/g, '').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n').replace(/^\n$/, '');
  };
  const statusId = url => /\/status\/(\d+)/.exec(url || '')?.[1];
  const timeLink = article => [...article.querySelectorAll('a[href*="/status/"]')].find(link => link.querySelector('time'));
  let session = null;
  const cTrace = (step, details = {}) => {
    try { globalThis.chrome?.runtime?.sendMessage({ type: 'content-trace', step, details }).catch(() => {}); } catch {}
  };

  function assertAccount(expected) {
    const lower = expected.toLowerCase();
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const handles = switcher?.textContent.match(/@[A-Za-z0-9_]{1,15}\b/g) || [];
    const hasHandleText = handles.some(handle => handle.slice(1).toLowerCase() === lower);
    const hasAvatar = [...document.querySelectorAll('[data-testid^="UserAvatar-Container-"]')].some(
      el => el.getAttribute('data-testid').slice('UserAvatar-Container-'.length).toLowerCase() === lower
    );
    const profileHref = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') || '';
    const hasProfileLink = profileHref.replace(/^\/+|\/+$/g, '').toLowerCase() === lower;
    if (!hasHandleText && !hasAvatar && !hasProfileLink) {
      cTrace('assertAccount.fail', { expected, switcherFound: Boolean(switcher), handlesFound: handles, profileHref });
      throw Error(`Cannot confirm X account @${expected}. Check login and the active account.`);
    }
  }
  function targetArticle(url) {
    const id = statusId(url);
    const candidates = all('article[data-testid="tweet"]').filter(article => statusId(timeLink(article)?.getAttribute('href')) === id);
    if (candidates.length !== 1) throw Error('Cannot identify the target post unambiguously');
    return candidates[0];
  }
  function emptyEditor() {
    let editors = all('[data-testid="tweetTextarea_0"][contenteditable="true"]');
    const dialogs = editors.filter(editor => editor.closest('[role="dialog"]'));
    if (dialogs.length) editors = dialogs;
    if (editors.length !== 1) {
      cTrace('emptyEditor.ambiguous_or_missing', { editorsCount: editors.length, dialogsCount: dialogs.length });
      throw Error('Composer is missing or ambiguous');
    }
    const current = readText(editors[0]);
    if (current !== '') {
      const snippet = current.length > 60 ? `${current.slice(0, 60)}…` : current;
      cTrace('emptyEditor.nonempty', { currentLen: current.length, snippet });
      throw Error(`An existing draft is present ("${snippet}"). Clear or save it yourself before continuing.`);
    }
    return editors[0];
  }
  async function waitFor(fn, ms = 15000) {
    const deadline = Date.now() + ms;
    let last;
    do {
      try { const result = fn(); if (result) return result; } catch (error) { last = error; }
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw last || Error('X did not show the expected control in time');
  }
  function requireTargetInComposer(job, scope) {
    if (job.action === 'NEW-POST') return;
    const id = statusId(job.url);
    const links = [...scope.querySelectorAll('a[href*="/status/"]')];
    if (!links.some(link => statusId(link.getAttribute('href')) === id)) throw Error('Cannot confirm the reply or quote target inside the composer');
  }
  function cleanup() {
    if (!session) return;
    session.controller.abort();
    session.titleObserver?.disconnect();
    clearInterval(session.titleTimer);
    if (document.title.startsWith(session.marker)) document.title = session.originalTitle;
    session = null;
  }
  function guard(marker, checkFocus = true) {
    if (!session || session.marker !== marker || session.interrupted) {
      cTrace('guard.interrupted', { hasSession: Boolean(session), markerMatch: session?.marker === marker, interrupted: session?.interrupted });
      throw Error('Typing session was interrupted');
    }
    if (!session.editor.isConnected) {
      cTrace('guard.editor_disconnected', {});
      throw Error('The editor changed or was closed');
    }
    if (checkFocus && document.activeElement !== session.editor && !session.editor.contains(document.activeElement)) {
      session.editor.focus();
    }
    if (checkFocus && (!document.hasFocus() || document.visibilityState !== 'visible' || (document.activeElement !== session.editor && !session.editor.contains(document.activeElement)))) {
      cTrace('guard.focus_lost', { hasFocus: document.hasFocus(), visibilityState: document.visibilityState, activeTag: document.activeElement?.tagName, activeIsEditor: document.activeElement === session.editor });
      throw Error('Editor focus changed; typing stopped');
    }
    if (!document.title.startsWith(marker)) {
      cTrace('guard.title_changed', { title: document.title, marker });
      throw Error('Page title changed; typing stopped');
    }
    assertAccount(session.expectedAccount);
    return { text: readText(session.editor) };
  }
  async function prepare({ job, marker, expectedAccount }) {
    cleanup();
    cTrace('prepare.start', { href: location.href, title: document.title, hasFocus: document.hasFocus(), visibilityState: document.visibilityState, activeTag: document.activeElement?.tagName });
    await waitFor(() => { assertAccount(expectedAccount); return true; });
    if (job.action !== 'NEW-POST') {
      const target = await waitFor(() => targetArticle(job.url));
      if (statusId(location.href) !== statusId(job.url)) throw Error('The current page is not the requested target post');
      const button = target.querySelector(job.action === 'REPLY-TO' ? '[data-testid="reply"]' : '[data-testid="retweet"]');
      if (!visible(button)) throw Error('The requested post action is unavailable');
      button.click();
      if (job.action === 'QUOTE') {
        const quote = await waitFor(() => {
          const choices = all('[role="menuitem"]').filter(item => /\/compose\/(post|tweet)/.test(item.getAttribute('href') || item.querySelector('a')?.getAttribute('href') || '') || /^(quote|quote post|siter|siter innlegg)$/i.test(item.textContent.trim()));
          return choices.length === 1 ? choices[0] : null;
        });
        quote.click();
      }
    }
    const editor = await waitFor(emptyEditor);
    const scope = editor.closest('[role="dialog"]') || editor.closest('[data-testid="primaryColumn"]');
    if (!scope) throw Error('Cannot identify the composer boundary');
    requireTargetInComposer(job, scope);
    const originalTitle = document.title;
    const controller = new AbortController();
    let updatingTitle = false;
    const enforceTitle = () => {
      if (updatingTitle || session?.marker !== marker) return;
      if (!document.title.startsWith(marker)) {
        updatingTitle = true;
        try { document.title = `${marker} — ${document.title || 'X'}`; } finally { updatingTitle = false; }
      }
    };
    const titleRoot = document.head || document.documentElement;
    const titleObserver = typeof MutationObserver === 'function' && titleRoot ? new MutationObserver(enforceTitle) : null;
    const titleTimer = setInterval(enforceTitle, 40);
    session = { job, marker, expectedAccount, editor, scope, originalTitle, controller, titleObserver, titleTimer, interrupted: false, beforeIds: new Set([...document.querySelectorAll('a[href*="/status/"]')].map(a => statusId(a.getAttribute('href')))) };
    const interrupt = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && (event.target === editor || editor.contains(event.target))) return;
      cTrace('prepare.interrupt', { eventType: event.type, key: event.key || null, targetTag: event.target?.tagName || null });
      if (session?.marker === marker) { session.interrupted = true; globalThis.chrome?.runtime?.sendMessage({ type: 'interrupted', marker }).catch(() => {}); }
    };
    editor.scrollIntoView({ behavior: 'instant', block: 'center' });
    editor.click();
    editor.focus();
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, interrupt, { capture: true, signal: controller.signal });
    updatingTitle = true;
    try { document.title = `${marker} — ${originalTitle || 'X'}`; } finally { updatingTitle = false; }
    if (titleObserver && titleRoot) titleObserver.observe(titleRoot, { childList: true, characterData: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 250));
    cTrace('prepare.ready', { title: document.title, editorConnected: editor.isConnected, hasFocus: document.hasFocus(), visibilityState: document.visibilityState, activeIsEditor: document.activeElement === editor || editor.contains(document.activeElement) });
    return guard(marker, false);
  }
  function publish({ marker, text }) {
    guard(marker);
    if (readText(session.editor) !== text) throw Error('Final editor content differs from the requested text');
    requireTargetInComposer(session.job, session.scope);
    const buttons = all('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]', session.scope);
    if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') throw Error('Post button is unavailable; check X character limits or validation');
    // This function is called once, only after the helper durably records submitting.
    buttons[0].click(); return { clicked: true };
  }
  async function publishedCandidate({ marker }) {
    if (!session || session.marker !== marker) throw Error('Session was lost after publication');
    const expected = session.expectedAccount.toLowerCase();
    const makeUrl = link => {
      const parsed = new URL(link.getAttribute('href'), location.origin);
      const match = /^\/([A-Za-z0-9_]+)\/status\/(\d+)$/.exec(parsed.pathname);
      return parsed.origin === 'https://x.com' && match && match[1].toLowerCase() === expected && !session.beforeIds.has(match[2]) ? `https://x.com${parsed.pathname}` : null;
    };
    return waitFor(() => {
      for (const link of all('[role="alert"] a[href*="/status/"], [data-testid="toast"] a[href*="/status/"]')) { const url = makeUrl(link); if (url) return { url }; }
      for (const article of all('article[data-testid="tweet"]')) {
        const link = timeLink(article); const url = link && makeUrl(link);
        if (url && readText(article.querySelector('[data-testid="tweetText"]') || article) === session.job.text) return { url };
      }
      return null;
    }, 20000);
  }
  async function verify({ url, expectedAccount, text }) {
    await waitFor(() => { assertAccount(expectedAccount); return true; });
    if (statusId(location.href) !== statusId(url)) throw Error('Result page does not match the new post');
    const article = await waitFor(() => targetArticle(url));
    const link = new URL(timeLink(article).getAttribute('href'), location.origin);
    if (link.pathname.split('/')[1].toLowerCase() !== expectedAccount.toLowerCase()) throw Error('Result author does not match expected account');
    const postedText = article.querySelector('[data-testid="tweetText"]');
    if (!postedText || readText(postedText) !== text) throw Error('Could not verify the exact published text; inspect X before retrying');
    return { url: `https://x.com${link.pathname}` };
  }
  globalThis.TypedPostXDOM = { assertAccount, targetArticle, emptyEditor, readText, prepare, guard, cleanup, publish, publishedCandidate, verify };
  globalThis.chrome?.runtime?.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'typed-postx') return;
    const methods = { prepare, guard: args => guard(args.marker), read: args => guard(args.marker), cleanup, publish, publishedCandidate, verify, ping: () => ({ ready: true }) };
    if (!methods[message.method]) return;
    Promise.resolve().then(() => methods[message.method](message.args || {})).then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message }));
    return true;
  });
})();
