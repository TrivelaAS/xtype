import { Job } from '../../shared/types';

interface PopupStateResponse {
  wsConnected: boolean;
  settings: {
    serverUrl: string;
    boundWindowId: number | null;
    boundTabId: number | null;
    defaultWpm: number;
    defaultTypoRate: number;
    defaultAutoSubmit: boolean;
    overrideServerProfile: boolean;
  };
  activeJob: Job | null;
}

const connDot = document.getElementById('connDot') as HTMLSpanElement;
const connLabel = document.getElementById('connLabel') as HTMLSpanElement;
const windowStatus = document.getElementById('windowStatus') as HTMLElement;
const openWindowBtn = document.getElementById('openWindowBtn') as HTMLButtonElement;
const bindWindowBtn = document.getElementById('bindWindowBtn') as HTMLButtonElement;
const jobSummary = document.getElementById('jobSummary') as HTMLDivElement;
const jobProgress = document.getElementById('jobProgress') as HTMLDivElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const serverUrlInput = document.getElementById('serverUrlInput') as HTMLInputElement;
const wpmSlider = document.getElementById('wpmSlider') as HTMLInputElement;
const wpmVal = document.getElementById('wpmVal') as HTMLSpanElement;
const typoSlider = document.getElementById('typoSlider') as HTMLInputElement;
const typoVal = document.getElementById('typoVal') as HTMLSpanElement;
const overrideCheck = document.getElementById('overrideCheck') as HTMLInputElement;
const testMockBtn = document.getElementById('testMockBtn') as HTMLButtonElement;

function renderState(state: PopupStateResponse): void {
  if (state.wsConnected) {
    connDot.classList.add('connected');
    connLabel.textContent = 'Connected';
  } else {
    connDot.classList.remove('connected');
    connLabel.textContent = 'Disconnected';
  }

  if (state.settings.boundWindowId !== null) {
    windowStatus.textContent = `Win #${state.settings.boundWindowId} (Tab #${state.settings.boundTabId ?? '?'})`;
  } else {
    windowStatus.textContent = 'Not bound';
  }

  if (document.activeElement !== serverUrlInput) {
    serverUrlInput.value = state.settings.serverUrl;
  }

  wpmSlider.value = String(state.settings.defaultWpm);
  wpmVal.textContent = String(state.settings.defaultWpm);

  const typoPct = Number((state.settings.defaultTypoRate * 100).toFixed(1));
  typoSlider.value = String(typoPct);
  typoVal.textContent = typoPct.toFixed(1);

  overrideCheck.checked = state.settings.overrideServerProfile;

  if (state.activeJob) {
    jobSummary.textContent = `${state.activeJob.type.toUpperCase()} — ${state.activeJob.status} (${state.activeJob.progress}%)`;
    jobProgress.style.width = `${state.activeJob.progress}%`;
    stopBtn.disabled = false;
  } else {
    jobSummary.textContent = 'Idle — waiting for jobs';
    jobProgress.style.width = '0%';
    stopBtn.disabled = true;
  }
}

async function refresh(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({
    type: 'popup:get-state',
  })) as PopupStateResponse;
  if (state) {
    renderState(state);
  }
}

async function savePatch(patch: Record<string, unknown>): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'popup:update-settings',
    patch,
  });
  await refresh();
}

openWindowBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'popup:open-dedicated-window',
    url: 'https://x.com/home',
  });
  await refresh();
});

bindWindowBtn.addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.windowId && activeTab?.id) {
    await chrome.runtime.sendMessage({
      type: 'popup:bind-current-window',
      windowId: activeTab.windowId,
      tabId: activeTab.id,
    });
    await refresh();
  }
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'popup:emergency-stop' });
  await refresh();
});

serverUrlInput.addEventListener('change', () => {
  void savePatch({ serverUrl: serverUrlInput.value.trim() || 'http://127.0.0.1:4110' });
});

wpmSlider.addEventListener('input', () => {
  wpmVal.textContent = wpmSlider.value;
});
wpmSlider.addEventListener('change', () => {
  void savePatch({ defaultWpm: Number(wpmSlider.value) });
});

typoSlider.addEventListener('input', () => {
  typoVal.textContent = Number(typoSlider.value).toFixed(1);
});
typoSlider.addEventListener('change', () => {
  void savePatch({ defaultTypoRate: Number(typoSlider.value) / 100 });
});

overrideCheck.addEventListener('change', () => {
  void savePatch({ overrideServerProfile: overrideCheck.checked });
});

testMockBtn.addEventListener('click', async () => {
  const baseUrl = (serverUrlInput.value.trim() || 'http://127.0.0.1:4110').replace(/\/+$/, '');
  testMockBtn.disabled = true;
  testMockBtn.textContent = 'Queuing mock test...';
  try {
    await chrome.runtime.sendMessage({
      type: 'popup:open-dedicated-window',
      url: `${baseUrl}/mock-x`,
    });
    await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'post',
        targetUrl: `${baseUrl}/mock-x`,
        text: 'Testing human typing cadence in an inactive Chrome window. Works cleanly!',
        autoSubmit: false,
        profile: {
          wpmMean: Number(wpmSlider.value),
          typoRate: Number(typoSlider.value) / 100,
        },
      }),
    });
  } finally {
    testMockBtn.disabled = false;
    testMockBtn.textContent = 'Run Mock X.com Typing Test';
    await refresh();
  }
});

void refresh();
window.setInterval(() => {
  void refresh();
}, 1000);
