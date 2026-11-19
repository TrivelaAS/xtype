import { parseCommand } from './commands.js';
const $ = id => document.getElementById(id);
let settingsLoaded = false;
let currentPaused = false;
function message(payload) {
  return chrome.runtime.sendMessage(payload).then(response => { if (!response?.ok) throw Error(response?.error || 'Extension did not respond'); return response.result; });
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; }
function element(tag, className, text) { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; }
function renderJobs(jobs) {
  $('jobs').replaceChildren();
  if (!jobs.length) { const empty = element('div', 'empty', 'Your next post starts above.'); empty.append(element('span', '', 'Commands and their results will appear here.')); $('jobs').append(empty); return; }
  for (const job of jobs) {
    const row = element('div', 'job', ''); row.append(element('div', 'job-kind', job.action));
    const body = element('div', '', ''); body.append(element('div', 'job-text', job.text)); body.append(element('div', 'job-id', job.id));
    if (job.error) body.append(element('div', 'job-error', job.error)); row.append(body);
    const state = element('div', 'job-state', job.status.replaceAll('-', ' '));
    state.append(element('div', 'job-time', new Date(job.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    if (job.resultUrl && /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(job.resultUrl)) { const link = element('a', '', 'View post ↗'); link.href = job.resultUrl; link.target = '_blank'; link.rel = 'noreferrer'; state.append(link); }
    if (job.status === 'queued') { const cancel = element('button', 'secondary', 'Cancel'); cancel.onclick = () => control({ action: 'cancel', id: job.id }); state.append(document.createElement('br'), cancel); }
    if (['needs-attention', 'cancelled'].includes(job.status)) { const retry = element('button', 'secondary', 'Retry'); retry.onclick = () => control({ action: 'retry', id: job.id }); state.append(document.createElement('br'), retry); }
    row.append(state); $('jobs').append(row);
  }
}
async function refresh(quiet = false) {
  try {
    const state = await message({ type: 'status' });
    currentPaused = Boolean(state.paused);
    $('connection').textContent = state.connected ? (state.paused ? 'Connected · paused' : 'Connected · ready') : 'Helper running · extension connecting';
    $('connection').className = `connection ${state.paused ? 'paused' : state.connected ? 'online' : ''}`;
    $('queue-state').textContent = state.activeJob ? `Working on ${state.activeJob}` : state.paused ? 'Paused — inspect any draft before resuming' : state.expectedAccount ? `Ready for @${state.expectedAccount}` : 'Set your expected X account to begin';
    if (!settingsLoaded) { $('account').value = state.expectedAccount; $('delay').value = state.delayMs; $('setup').open = !(state.connected && state.expectedAccount); settingsLoaded = true; }
    else if (state.connected && state.expectedAccount && $('setup').dataset.wasDisconnected === '1') { $('setup').open = false; delete $('setup').dataset.wasDisconnected; }
    renderJobs(state.jobs);
  } catch (error) { $('connection').textContent = 'Helper disconnected'; $('connection').className = 'connection'; $('setup').open = true; $('setup').dataset.wasDisconnected = '1'; if (!quiet) notice(error.message, true); }
}
async function control(value) { try { await message({ type: 'control', control: value }); await refresh(); } catch (error) { notice(error.message, true); } }
$('pair-form').onsubmit = async event => {
  event.preventDefault(); try { await message({ type: 'pair', token: $('token').value }); $('token').value = ''; notice('Paired. Save your expected X account, then send a command.'); await refresh(); } catch (error) { notice(error.message, true); }
};
$('settings-form').onsubmit = async event => {
  event.preventDefault(); try { await message({ type: 'settings', settings: { expectedAccount: $('account').value, delayMs: Number($('delay').value) } }); notice('Account and typing interval saved.'); await refresh(); } catch (error) { notice(error.message, true); }
};
$('compose-form').onsubmit = async event => {
  event.preventDefault(); $('send').disabled = true;
  try {
    const command = parseCommand($('command').value);
    const job = await message({ type: 'submit', job: { id: crypto.randomUUID(), ...command, mode: $('draft').checked ? 'draft' : 'publish' } });
    notice(
      currentPaused
        ? `Queued ${job.action}, but the queue is paused — click "Resume queue" above to start typing.`
        : `Queued ${job.action}. Keep the X tab in the foreground while it types.`,
      currentPaused
    );
    await refresh();
  } catch (error) { notice(error.message, true); } finally { $('send').disabled = false; }
};
for (const button of document.querySelectorAll('[data-template]')) button.onclick = () => {
  const action = button.dataset.template;
  // Keep text the user has already written when changing the command type.
  let current = ''; try { current = parseCommand($('command').value).text; } catch { current = $('command').value.replace(/^(REPLY-TO|QUOTE):[ \t]*https?:\/\/\S*[ \t]*\r?\n?/, '').replace(/^(NEW-POST|REPLY-TO|QUOTE):[ \t]*/, ''); }
  $('command').value = action === 'NEW-POST' ? `NEW-POST: ${current}` : `${action}: https://x.com/username/status/123\n${current}`;
  for (const item of document.querySelectorAll('[data-template]')) item.classList.toggle('selected', item === button);
  updateCount(); $('command').focus();
};
function updateCount() { let text = ''; try { text = parseCommand($('command').value).text; } catch { /* Incomplete command. */ } $('count').textContent = `${Array.from(text).length} characters`; }
$('command').addEventListener('input', updateCount);
$('pause').onclick = () => control({ action: 'pause' }); $('resume').onclick = () => control({ action: 'resume' }); $('refresh').onclick = () => refresh();
$('copy-trace').onclick = async () => {
  try {
    const trace = await message({ type: 'trace' });
    const lines = trace?.lines || [];
    if (!lines.length) { notice('Trace log is empty yet. Try running or retrying a job first.'); return; }
    await navigator.clipboard.writeText(lines.join('\n'));
    notice(`Copied ${lines.length} trace lines to clipboard (saved at ${trace.exeLogPath || trace.logPath}).`);
  } catch (error) { notice(error.message, true); }
};
void refresh(true); setInterval(() => void refresh(true), 2500);
