(() => {
  const HOST_ID = 'xtype-status-pill-host';
  let hideTimer: number | null = null;

  function ensureBadge(): { update: (state: string, detail?: string) => void } {
    let host = document.getElementById(HOST_ID);
    let shadow: ShadowRoot;

    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.position = 'fixed';
      host.style.right = '14px';
      host.style.bottom = '14px';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          .pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-radius: 999px;
            background: rgba(15, 20, 25, 0.9);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: #e7e9ea;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12px;
            font-weight: 500;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(6px);
            transition: opacity 0.2s ease;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #1d9bf0;
          }
          .pill[data-state="typing"] .dot { background: #00ba7c; }
          .pill[data-state="reading"] .dot { background: #ffd400; }
          .pill[data-state="failed"] .dot,
          .pill[data-state="cancelled"] .dot { background: #f4212e; }
          .hidden { opacity: 0; }
        </style>
        <div class="pill hidden" data-state="idle">
          <span class="dot"></span>
          <span class="label">XType</span>
        </div>
      `;
      document.documentElement.appendChild(host);
    } else {
      shadow = host.shadowRoot!;
    }

    const pill = shadow.querySelector('.pill') as HTMLDivElement;
    const label = shadow.querySelector('.label') as HTMLSpanElement;

    return {
      update(state: string, detail?: string) {
        if (hideTimer !== null) {
          window.clearTimeout(hideTimer);
          hideTimer = null;
        }
        pill.setAttribute('data-state', state.toLowerCase());
        label.textContent = detail ? `XType • ${detail}` : `XType • ${state}`;
        pill.classList.remove('hidden');

        if (state === 'completed' || state === 'idle' || state === 'cancelled') {
          hideTimer = window.setTimeout(() => {
            pill.classList.add('hidden');
          }, 6000);
        }
      },
    };
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'xtype:badge') {
      ensureBadge().update(String(msg.state ?? 'idle'), msg.detail ? String(msg.detail) : undefined);
    }
  });
})();
