import { Job, JobStatus, TypingProfile, WsExtensionMessage, WsServerMessage } from '../../shared/types';
import {
  buildKeystrokePlan,
  executeKeystrokePlan,
  JobCancelledError,
  randomBetween,
} from './humanTyper';
import { extractStatusId, X_SELECTORS } from './xSelectors';

interface ExtensionSettings {
  serverUrl: string;
  boundWindowId: number | null;
  boundTabId: number | null;
  defaultWpm: number;
  defaultTypoRate: number;
  defaultAutoSubmit: boolean;
  overrideServerProfile: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: 'http://127.0.0.1:4110',
  boundWindowId: null,
  boundTabId: null,
  defaultWpm: 68,
  defaultTypoRate: 0.02,
  defaultAutoSubmit: false,
  overrideServerProfile: false,
};

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let wsConnected = false;
let activeJob: Job | null = null;
let cancelRequestedJobId: string | null = null;
let creatingOffscreen: Promise<void> | null = null;
const attachedTabs = new Set<number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWsUrl(serverUrl: string): string {
  const clean = serverUrl.trim().replace(/\/+$/, '');
  if (clean.startsWith('https://')) {
    return `wss://${clean.slice('https://'.length)}/ws`;
  }
  if (clean.startsWith('http://')) {
    return `ws://${clean.slice('http://'.length)}/ws`;
  }
  return `ws://${clean}/ws`;
}

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settings = {
    serverUrl: typeof stored.serverUrl === 'string' ? stored.serverUrl : DEFAULT_SETTINGS.serverUrl,
    boundWindowId: typeof stored.boundWindowId === 'number' ? stored.boundWindowId : null,
    boundTabId: typeof stored.boundTabId === 'number' ? stored.boundTabId : null,
    defaultWpm: typeof stored.defaultWpm === 'number' ? stored.defaultWpm : DEFAULT_SETTINGS.defaultWpm,
    defaultTypoRate:
      typeof stored.defaultTypoRate === 'number'
        ? stored.defaultTypoRate
        : DEFAULT_SETTINGS.defaultTypoRate,
    defaultAutoSubmit:
      typeof stored.defaultAutoSubmit === 'boolean'
        ? stored.defaultAutoSubmit
        : DEFAULT_SETTINGS.defaultAutoSubmit,
    overrideServerProfile:
      typeof stored.overrideServerProfile === 'boolean'
        ? stored.overrideServerProfile
        : DEFAULT_SETTINGS.overrideServerProfile,
  };
  return settings;
}

async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set(patch);
  return settings;
}

async function sendWs(payload: WsExtensionMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'offscreen:send-ws', payload });
  } catch {
    // Offscreen may not be ready yet; ignore transient error
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (contexts.length > 0) {
        return;
      }

      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'Maintain a persistent WebSocket connection to the local XType server without stealing window focus.',
      });
    } finally {
      creatingOffscreen = null;
    }
  })();

  await creatingOffscreen;
  await chrome.runtime
    .sendMessage({
      type: 'offscreen:set-url',
      wsUrl: toWsUrl(settings.serverUrl),
    })
    .catch(() => {});
}

async function verifyBoundWindow(): Promise<{ windowId: number; tabId: number } | null> {
  if (settings.boundWindowId === null) {
    return null;
  }

  try {
    const win = await chrome.windows.get(settings.boundWindowId, { populate: true });
    const tabs = win.tabs ?? [];
    if (tabs.length === 0) {
      return null;
    }

    const matchingTab =
      (settings.boundTabId !== null
        ? tabs.find((t) => t.id === settings.boundTabId)
        : undefined) ??
      tabs.find((t) => t.active) ??
      tabs[0];

    if (!matchingTab?.id || !win.id) {
      return null;
    }

    if (matchingTab.id !== settings.boundTabId) {
      await saveSettings({ boundTabId: matchingTab.id });
    }

    return { windowId: win.id, tabId: matchingTab.id };
  } catch {
    await saveSettings({ boundWindowId: null, boundTabId: null });
    return null;
  }
}

async function ensureDedicatedXWindow(
  initialUrl = 'https://x.com/home'
): Promise<{ windowId: number; tabId: number }> {
  const existing = await verifyBoundWindow();
  if (existing) {
    return existing;
  }

  // Create dedicated window WITHOUT stealing OS window focus
  const created = await chrome.windows.create({
    url: initialUrl,
    focused: false,
    width: 1180,
    height: 880,
  });

  const windowId = created.id;
  const tabId = created.tabs?.[0]?.id;
  if (!windowId || !tabId) {
    throw new Error('Failed to create dedicated unfocused Chrome window');
  }

  await saveSettings({ boundWindowId: windowId, boundTabId: tabId });
  await sendWs({ type: 'window:bound', windowId, tabId });
  return { windowId, tabId };
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) {
    return;
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Another debugger is already attached')) {
      // Check if our extension is the attached target or external DevTools is open
      const targets = await chrome.debugger.getTargets();
      const target = targets.find((t) => t.tabId === tabId);
      if (target?.attached) {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
          attachedTabs.add(tabId);
          return;
        } catch {
          throw new Error(
            'Chrome DevTools is already open on the dedicated X window. Please close DevTools on that tab so XType can type.'
          );
        }
      }
      attachedTabs.add(tabId);
      return;
    }
    throw error;
  }
}

async function updateBadge(tabId: number, state: string, detail?: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'xtype:badge', state, detail });
  } catch {
    // Content script may not be loaded on blank/error pages
  }
}

async function reportJobStatus(
  jobId: string,
  status: JobStatus,
  progress?: number,
  error?: string
): Promise<void> {
  await sendWs({
    type: 'job:status',
    jobId,
    status,
    progress,
    error,
  });
}

async function navigateTab(
  tabId: number,
  targetUrl: string,
  shouldAbort: () => boolean
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timeoutId) clearTimeout(timeoutId);
      if (pollId) clearInterval(pollId);
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    timeoutId = setTimeout(() => {
      finish(new Error(`Timed out waiting for navigation to ${targetUrl}`));
    }, 25000);

    pollId = setInterval(() => {
      if (shouldAbort()) {
        finish(new JobCancelledError());
      }
    }, 150);

    chrome.tabs.update(tabId, { url: targetUrl, active: true }).catch((err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // Give X.com SPA hydration a moment after network load completes
  await sleep(Math.round(randomBetween(700, 1300)));
  if (shouldAbort()) {
    throw new JobCancelledError();
  }
}

interface ElementBoxResult {
  found: boolean;
  x?: number;
  y?: number;
  tweetWordCount: number;
}

async function findElementBoxOnce(
  tabId: number,
  selectors: readonly string[],
  statusId?: string
): Promise<ElementBoxResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [[...selectors], statusId ?? null],
    func: async (sels: string[], tweetStatusId: string | null): Promise<ElementBoxResult> => {
      let scope: ParentNode = document;
      let tweetWordCount = 0;

      if (tweetStatusId) {
        const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
        const focalArticle = articles.find((article) =>
          Boolean(article.querySelector(`a[href*="/status/${tweetStatusId}"]`))
        );
        if (focalArticle) {
          scope = focalArticle;
        }
      }

      const focalText =
        (scope !== document
          ? scope.querySelector('[data-testid="tweetText"]')
          : document.querySelector('article[data-testid="tweet"] [data-testid="tweetText"]')) ??
        document.querySelector('[data-testid="tweetText"]');

      if (focalText?.textContent) {
        tweetWordCount = focalText.textContent.trim().split(/\s+/).filter(Boolean).length;
      }

      for (const selector of sels) {
        let el = scope.querySelector(selector) as HTMLElement | null;
        if (!el && scope !== document) {
          el = document.querySelector(selector) as HTMLElement | null;
        }
        if (el) {
          const initialRect = el.getBoundingClientRect();
          if (initialRect.width > 0 && initialRect.height > 0) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            await new Promise((r) => setTimeout(r, 220));
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width * (0.25 + Math.random() * 0.5);
            const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
            return { found: true, x, y, tweetWordCount };
          }
        }
      }

      return { found: false, tweetWordCount };
    },
  });

  return results[0]?.result ?? { found: false, tweetWordCount: 0 };
}

async function waitForElementBox(
  tabId: number,
  selectors: readonly string[],
  timeoutMs: number,
  shouldAbort: () => boolean,
  statusId?: string
): Promise<{ x: number; y: number; tweetWordCount: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) {
      throw new JobCancelledError();
    }
    const res = await findElementBoxOnce(tabId, selectors, statusId);
    if (res.found && typeof res.x === 'number' && typeof res.y === 'number') {
      return { x: res.x, y: res.y, tweetWordCount: res.tweetWordCount };
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for X.com element (${selectors[0]})`);
}

async function cdpClick(tabId: number, x: number, y: number): Promise<void> {
  const startX = x + randomBetween(-35, 35);
  const startY = y + randomBetween(-25, 25);
  const steps = 4;

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(startX + (x - startX) * t),
      y: Math.round(startY + (y - startY) * t),
    });
    await sleep(Math.round(randomBetween(12, 28)));
  }

  await sleep(Math.round(randomBetween(35, 95)));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    x: Math.round(x),
    y: Math.round(y),
    clickCount: 1,
  });
  await sleep(Math.round(randomBetween(45, 90)));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    x: Math.round(x),
    y: Math.round(y),
    clickCount: 1,
  });
}

async function simulateReadingDelay(
  profile: TypingProfile,
  tweetWordCount: number,
  shouldAbort: () => boolean
): Promise<void> {
  const [minDelay, maxDelay] = profile.readingDelayMs;
  const baseWait = randomBetween(minDelay, maxDelay);
  const wordScale = Math.min(2500, tweetWordCount * 35);
  const totalWait = Math.round(baseWait + wordScale);
  const chunkMs = 150;
  let elapsed = 0;
  while (elapsed < totalWait) {
    if (shouldAbort()) {
      throw new JobCancelledError();
    }
    const next = Math.min(chunkMs, totalWait - elapsed);
    await sleep(next);
    elapsed += next;
  }
}

async function submitComposer(
  tabId: number,
  preferred: 'inline' | 'modal',
  shouldAbort: () => boolean
): Promise<void> {
  await sleep(Math.round(randomBetween(650, 1450)));
  if (shouldAbort()) {
    throw new JobCancelledError();
  }

  const primary =
    preferred === 'inline' ? X_SELECTORS.inlineSubmitButton : X_SELECTORS.modalSubmitButton;
  const secondary =
    preferred === 'inline' ? X_SELECTORS.modalSubmitButton : X_SELECTORS.inlineSubmitButton;

  const box = await waitForElementBox(tabId, [...primary, ...secondary], 6000, shouldAbort);
  await cdpClick(tabId, box.x, box.y);
}

async function runHumanTyping(
  tabId: number,
  job: Job,
  profile: TypingProfile,
  startPct: number,
  initialLabel: string,
  shouldAbort: () => boolean
): Promise<void> {
  await reportJobStatus(job.id, 'typing', startPct);
  await updateBadge(tabId, 'typing', initialLabel);

  const steps = buildKeystrokePlan(job.text, profile);
  const span = 98 - startPct;
  await executeKeystrokePlan({
    tabId,
    steps,
    shouldAbort,
    onProgress: (done, total) => {
      const pct = Math.min(98, startPct + Math.round((done / Math.max(1, total)) * span));
      void updateBadge(tabId, 'typing', `Typing ${pct}%`);
      if (done % 10 === 0 || done === total) {
        void reportJobStatus(job.id, 'typing', pct);
      }
    },
  });
}

async function executeJob(job: Job): Promise<void> {
  activeJob = job;
  cancelRequestedJobId = null;

  const shouldAbort = () => cancelRequestedJobId === job.id;
  const effectiveProfile: TypingProfile = settings.overrideServerProfile
    ? {
        ...job.profile,
        wpmMean: settings.defaultWpm,
        typoRate: settings.defaultTypoRate,
      }
    : job.profile;

  let targetTabId: number | null = null;

  try {
    const initialUrl =
      job.targetUrl ?? (job.type === 'post' ? 'https://x.com/home' : 'https://x.com/home');
    const winInfo = await ensureDedicatedXWindow(initialUrl);
    const tabId = winInfo.tabId;
    targetTabId = tabId;

    await reportJobStatus(job.id, 'navigating', 5);
    await updateBadge(tabId, 'navigating', 'Navigating...');
    await navigateTab(tabId, initialUrl, shouldAbort);
    await ensureDebuggerAttached(tabId);

    const statusId = extractStatusId(job.targetUrl);

    if (job.type === 'post') {
      const box = await waitForElementBox(
        tabId,
        X_SELECTORS.composerTextarea,
        15000,
        shouldAbort
      );
      await sleep(Math.round(randomBetween(300, 750)));
      await cdpClick(tabId, box.x, box.y);
      await sleep(Math.round(randomBetween(180, 420)));

      await runHumanTyping(tabId, job, effectiveProfile, 10, 'Typing 0%', shouldAbort);

      if (job.autoSubmit) {
        await submitComposer(tabId, 'inline', shouldAbort);
      }
    } else if (job.type === 'reply') {
      await reportJobStatus(job.id, 'reading', 10);
      await updateBadge(tabId, 'reading', 'Reading post...');

      // Wait for focal post or inline reply textarea
      const preTarget = await waitForElementBox(
        tabId,
        [...X_SELECTORS.tweetText, ...X_SELECTORS.replyButton],
        15000,
        shouldAbort,
        statusId
      );
      await simulateReadingDelay(effectiveProfile, preTarget.tweetWordCount, shouldAbort);

      // Prefer inline reply composer if immediately visible; else click Reply button
      let composerBox: { x: number; y: number } | null = null;
      const inlineCheck = await findElementBoxOnce(tabId, X_SELECTORS.composerTextarea);
      if (inlineCheck.found && typeof inlineCheck.x === 'number' && typeof inlineCheck.y === 'number') {
        composerBox = { x: inlineCheck.x, y: inlineCheck.y };
      } else {
        const replyBtn = await waitForElementBox(
          tabId,
          X_SELECTORS.replyButton,
          8000,
          shouldAbort,
          statusId
        );
        await cdpClick(tabId, replyBtn.x, replyBtn.y);
        await sleep(Math.round(randomBetween(350, 750)));
        composerBox = await waitForElementBox(
          tabId,
          X_SELECTORS.modalComposerTextarea,
          8000,
          shouldAbort
        );
      }

      await cdpClick(tabId, composerBox.x, composerBox.y);
      await sleep(Math.round(randomBetween(220, 450)));

      await runHumanTyping(tabId, job, effectiveProfile, 15, 'Typing reply...', shouldAbort);

      if (job.autoSubmit) {
        await submitComposer(tabId, inlineCheck.found ? 'inline' : 'modal', shouldAbort);
      }
    } else if (job.type === 'repost') {
      await reportJobStatus(job.id, 'reading', 20);
      await updateBadge(tabId, 'reading', 'Reading post...');

      const retweetBtn = await waitForElementBox(
        tabId,
        X_SELECTORS.retweetButton,
        15000,
        shouldAbort,
        statusId
      );
      await simulateReadingDelay(effectiveProfile, retweetBtn.tweetWordCount, shouldAbort);

      await cdpClick(tabId, retweetBtn.x, retweetBtn.y);
      await sleep(Math.round(randomBetween(350, 750)));

      const confirmBtn = await waitForElementBox(
        tabId,
        X_SELECTORS.retweetConfirmButton,
        8000,
        shouldAbort
      );
      await cdpClick(tabId, confirmBtn.x, confirmBtn.y);
    } else if (job.type === 'quote') {
      await reportJobStatus(job.id, 'reading', 10);
      await updateBadge(tabId, 'reading', 'Reading post...');

      const retweetBtn = await waitForElementBox(
        tabId,
        X_SELECTORS.retweetButton,
        15000,
        shouldAbort,
        statusId
      );
      await simulateReadingDelay(effectiveProfile, retweetBtn.tweetWordCount, shouldAbort);

      await cdpClick(tabId, retweetBtn.x, retweetBtn.y);
      await sleep(Math.round(randomBetween(350, 750)));

      const quoteOption = await waitForElementBox(
        tabId,
        X_SELECTORS.quoteMenuItem,
        8000,
        shouldAbort
      );
      await cdpClick(tabId, quoteOption.x, quoteOption.y);
      await sleep(Math.round(randomBetween(350, 700)));

      const composerBox = await waitForElementBox(
        tabId,
        X_SELECTORS.modalComposerTextarea,
        10000,
        shouldAbort
      );
      await cdpClick(tabId, composerBox.x, composerBox.y);
      await sleep(Math.round(randomBetween(200, 420)));

      await runHumanTyping(tabId, job, effectiveProfile, 15, 'Typing quote...', shouldAbort);

      if (job.autoSubmit) {
        await submitComposer(tabId, 'modal', shouldAbort);
      }
    }

    await reportJobStatus(job.id, 'completed', 100);
    await updateBadge(tabId, 'completed', 'Done');
  } catch (error) {
    if (error instanceof JobCancelledError) {
      await reportJobStatus(job.id, 'cancelled', job.progress, 'Cancelled');
      if (targetTabId !== null) {
        await updateBadge(targetTabId, 'cancelled', 'Stopped');
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await reportJobStatus(job.id, 'failed', job.progress, message);
      if (targetTabId !== null) {
        await updateBadge(targetTabId, 'failed', 'Error');
      }
    }
  } finally {
    activeJob = null;
    cancelRequestedJobId = null;
  }
}

async function handleWsServerMessage(msg: WsServerMessage): Promise<void> {
  if (msg.type === 'ping') {
    await sendWs({
      type: 'pong',
      boundWindowId: settings.boundWindowId,
      boundTabId: settings.boundTabId,
    });
    return;
  }

  if (msg.type === 'job:cancel') {
    if (activeJob && activeJob.id === msg.jobId) {
      cancelRequestedJobId = msg.jobId;
    }
    return;
  }

  if (msg.type === 'job:dispatch') {
    if (activeJob) {
      await reportJobStatus(
        msg.job.id,
        'failed',
        0,
        'Extension already executing another job'
      );
      return;
    }
    void executeJob(msg.job);
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === settings.boundWindowId) {
    void saveSettings({ boundWindowId: null, boundTabId: null }).then(() =>
      sendWs({ type: 'window:bound', windowId: null, tabId: null })
    );
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'xtype-keepalive') {
    void loadSettings().then(() => ensureOffscreenDocument());
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().then(async () => {
    await chrome.alarms.create('xtype-keepalive', { periodInMinutes: 0.4 });
    await ensureOffscreenDocument();
  });
});

chrome.runtime.onStartup.addListener(() => {
  void loadSettings().then(async () => {
    await chrome.alarms.create('xtype-keepalive', { periodInMinutes: 0.4 });
    await ensureOffscreenDocument();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  if (msg.type === 'offscreen:ws-connected') {
    wsConnected = true;
    void verifyBoundWindow().then((win) =>
      sendWs({
        type: 'hello',
        boundWindowId: win?.windowId ?? null,
        boundTabId: win?.tabId ?? null,
      })
    );
    return false;
  }

  if (msg.type === 'offscreen:ws-disconnected') {
    wsConnected = false;
    return false;
  }

  if (msg.type === 'offscreen:keepalive') {
    wsConnected = Boolean(msg.connected);
    return false;
  }

  if (msg.type === 'offscreen:ws-message') {
    void handleWsServerMessage(msg.data as WsServerMessage);
    return false;
  }

  if (msg.type === 'popup:get-state') {
    void (async () => {
      await loadSettings();
      await ensureOffscreenDocument();
      const verified = await verifyBoundWindow();
      const offscreenStatus = (await chrome.runtime
        .sendMessage({ type: 'offscreen:get-status' })
        .catch(() => null)) as { connected?: boolean } | null;
      if (offscreenStatus && typeof offscreenStatus.connected === 'boolean') {
        wsConnected = offscreenStatus.connected;
      }
      sendResponse({
        wsConnected,
        settings: {
          ...settings,
          boundWindowId: verified?.windowId ?? null,
          boundTabId: verified?.tabId ?? null,
        },
        activeJob,
      });
    })();
    return true;
  }

  if (msg.type === 'popup:update-settings') {
    void (async () => {
      const updated = await saveSettings(msg.patch as Partial<ExtensionSettings>);
      await ensureOffscreenDocument();
      await chrome.runtime
        .sendMessage({
          type: 'offscreen:set-url',
          wsUrl: toWsUrl(updated.serverUrl),
        })
        .catch(() => {});
      sendResponse({ ok: true, settings: updated });
    })();
    return true;
  }

  if (msg.type === 'popup:bind-current-window') {
    void (async () => {
      const windowId = typeof msg.windowId === 'number' ? msg.windowId : null;
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      const updated = await saveSettings({ boundWindowId: windowId, boundTabId: tabId });
      await sendWs({ type: 'window:bound', windowId, tabId });
      sendResponse({ ok: true, settings: updated });
    })();
    return true;
  }

  if (msg.type === 'popup:open-dedicated-window') {
    void (async () => {
      try {
        const targetUrl =
          typeof msg.url === 'string' && msg.url.length > 0 ? msg.url : 'https://x.com/home';
        const win = await ensureDedicatedXWindow(targetUrl);
        sendResponse({ ok: true, ...win });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'popup:emergency-stop') {
    void (async () => {
      if (activeJob) {
        cancelRequestedJobId = activeJob.id;
        sendResponse({ ok: true, cancelledJobId: activeJob.id });
      } else {
        sendResponse({ ok: true, cancelledJobId: null });
      }
    })();
    return true;
  }

  return false;
});

// Bootstrap on worker wake-up
void loadSettings().then(async () => {
  await chrome.alarms.create('xtype-keepalive', { periodInMinutes: 0.4 });
  await ensureOffscreenDocument();
});
