// State
let allPorts = [];
let activeTunnels = {};
let tunnelStatus = {}; // port -> { state: 'live'|'reconnecting', attempt?, delay? }
let sortColumn = 'port';
let sortDirection = 'asc';
let logsPort = null;
let edge = { available: true, missing: [] };
let lastPortsAt = 0;
let currentLogs = [];
// Keys of actions in flight ('expose:3000', 'kill:1234', 'stop:3000'). Kept in
// module state, not on the button, so a stream tick re-rendering the table
// doesn't wipe the pending state mid-request.
const pending = new Set();

// Capture token from URL once, stash in sessionStorage, then strip from the address bar.
const TOKEN_KEY = 'ports.token';
(function captureToken() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    params.delete('token');
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
  }
})();

function authFetch(input, init) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const opts = Object.assign({}, init || {});
  const headers = new Headers((init && init.headers) || {});
  if (token) headers.set('Authorization', 'Bearer ' + token);
  opts.headers = headers;
  return fetch(input, opts);
}

// DOM Elements
const portsBody = document.getElementById('portsBody');
const searchInput = document.getElementById('searchInput');
const protocolFilter = document.getElementById('protocolFilter');
const stateFilter = document.getElementById('stateFilter');
const refreshBtn = document.getElementById('refreshBtn');
const showAllBtn = document.getElementById('showAllBtn');
const toast = document.getElementById('toast');
const lastUpdate = document.getElementById('lastUpdate');
const platform = document.getElementById('platform');
const logsPanel = document.getElementById('logsPanel');
const logsList = document.getElementById('logsList');
const logsTitle = document.getElementById('logsTitle');
const tunnelsSection = document.getElementById('tunnelsSection');
const tunnelsList = document.getElementById('tunnelsList');
const tunnelsCount = document.getElementById('tunnelsCount');
const connStatus = document.getElementById('connStatus');
const connLabel = document.getElementById('connLabel');
const edgeNotice = document.getElementById('edgeNotice');
const toastMessage = document.getElementById('toastMessage');
const toastClose = document.getElementById('toastClose');
const confirmSheet = document.getElementById('confirmSheet');
const confirmKicker = document.getElementById('confirmKicker');
const confirmTitle = document.getElementById('confirmTitle');
const confirmBody = document.getElementById('confirmBody');
const confirmOk = document.getElementById('confirmOk');
const confirmCancel = document.getElementById('confirmCancel');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  fetchPorts();
  setupEventListeners();
  updateSortIndicators();
  startStream();
  startStaleWatchdog();
});

let eventSource = null;

function startStream() {
  if (eventSource) eventSource.close();
  const token = sessionStorage.getItem(TOKEN_KEY);
  const url = '/api/stream' + (token ? '?token=' + encodeURIComponent(token) : '');
  eventSource = new EventSource(url);

  eventSource.onopen = () => setConnState('live');

  eventSource.addEventListener('ports', (e) => {
    const payload = JSON.parse(e.data);
    allPorts = payload.ports;
    lastPortsAt = Date.now();
    setConnState('live');
    applyEdge(payload.edge);
    lastUpdate.textContent = new Date(payload.timestamp).toLocaleTimeString();
    platform.textContent = payload.platform;
    activeTunnels = {};
    (payload.tunnels || []).forEach(t => { activeTunnels[t.port] = t; });
    // Drop status entries for tunnels that no longer exist.
    for (const port of Object.keys(tunnelStatus)) {
      if (!activeTunnels[port]) delete tunnelStatus[port];
    }
    renderTable();
    renderTunnels();
  });

  eventSource.addEventListener('log', (e) => {
    const { port } = JSON.parse(e.data);
    if (logsPort === port) refreshLogs();
  });

  eventSource.addEventListener('tunnel', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'reconnecting') {
      tunnelStatus[ev.port] = { state: 'reconnecting', attempt: ev.attempt, delay: ev.delay };
      renderTunnels();
    } else if (ev.type === 'reconnected' || ev.type === 'url-changed' || ev.type === 'opened') {
      tunnelStatus[ev.port] = { state: 'live' };
      if (ev.type === 'url-changed') {
        showToast(`Tunnel URL changed for port ${ev.port}`);
      }
    }
    fetchTunnels().then(() => { renderTable(); renderTunnels(); });
  });

  eventSource.onerror = () => {
    // EventSource auto-reconnects on its own, but the table is stale until it
    // does — say so rather than showing frozen data as if it were live.
    setConnState('stale');
  };
}

// onerror only fires when the connection actually breaks. A stream that hangs
// (sleeping laptop, idle proxy) stays "open" while the data rots, so also fall
// back to stale when ports stop arriving on their 5s cadence.
function startStaleWatchdog() {
  setInterval(() => {
    if (lastPortsAt && Date.now() - lastPortsAt > 15000) setConnState('stale');
  }, 5000);
}

function setConnState(state) {
  if (connStatus.dataset.state === state) return;
  connStatus.dataset.state = state;
  connLabel.textContent = state === 'live' ? 'Live' : 'Reconnecting...';
  connStatus.title = state === 'live'
    ? 'Streaming updates from the server'
    : 'Update stream is down - the ports below may be out of date';
}

function applyEdge(status) {
  if (!status) return;
  edge = status;
  if (edge.available) {
    edgeNotice.style.display = 'none';
  } else {
    edgeNotice.style.display = '';
    edgeNotice.textContent = `Tunnels unavailable - ${edgeMissingText()}. Set them and restart the server to expose ports.`;
  }
}

function edgeMissingText() {
  const missing = edge.missing || [];
  if (missing.length === 0) return 'the tunnel edge is not configured';
  return `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`;
}

// Runs one action at a time per key, re-rendering so the button shows its
// pending label for the whole round trip.
async function runAction(key, fn) {
  if (pending.has(key)) return;
  pending.add(key);
  renderTable();
  renderTunnels();
  try {
    await fn();
  } finally {
    pending.delete(key);
    renderTable();
    renderTunnels();
  }
}

/* An in-page confirmation, so a destructive action is described in this
   interface's words rather than the operating system's. */
let confirmResolve = null;
let confirmReturnFocus = null;

function askConfirm(options) {
  return new Promise(function (resolve) {
    confirmReturnFocus = document.activeElement;
    confirmKicker.textContent = options.kicker || 'Confirm';
    confirmTitle.textContent = options.title;
    confirmBody.textContent = options.body;
    confirmOk.textContent = options.action;
    confirmSheet.hidden = false;
    requestAnimationFrame(function () { confirmSheet.classList.add('open'); });
    confirmOk.focus();
    confirmResolve = resolve;
  });
}

function closeConfirm(answer) {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null;
  confirmSheet.classList.remove('open');
  setTimeout(function () {
    if (!confirmResolve) confirmSheet.hidden = true;
  }, 320);
  if (confirmReturnFocus && confirmReturnFocus.focus) confirmReturnFocus.focus();
  resolve(answer);
}

function isTypingTarget(el) {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function setupEventListeners() {
  refreshBtn.addEventListener('click', fetchPorts);
  toastClose.addEventListener('click', hideToast);
  searchInput.addEventListener('input', renderTable);
  protocolFilter.addEventListener('change', renderTable);
  stateFilter.addEventListener('change', renderTable);
  showAllBtn.addEventListener('click', () => {
    protocolFilter.value = '';
    stateFilter.value = '';
    searchInput.value = '';
    renderTable();
  });

  confirmOk.addEventListener('click', () => closeConfirm(true));
  confirmCancel.addEventListener('click', () => closeConfirm(false));
  confirmSheet.addEventListener('mousedown', (e) => {
    if (e.target === confirmSheet) closeConfirm(false);
  });

  document.addEventListener('keydown', (e) => {
    // The sheet owns the keyboard while it is open.
    if (confirmResolve) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
      else if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === confirmOk ? confirmCancel : confirmOk).focus();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (logsPanel.classList.contains('open')) {
        closeLogs();
      } else if (document.activeElement === searchInput && searchInput.value) {
        searchInput.value = '';
        renderTable();
      }
      return;
    }
    // '/' focuses search, unless the user is already typing somewhere.
    if (e.key === '/' && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Sort headers
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.dataset.sort;
      if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = column;
        sortDirection = 'asc';
      }
      updateSortIndicators();
      renderTable();
    });
  });
}

async function fetchPorts() {
  try {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: -2px; animation: spin 1s linear infinite;">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
        <path d="M16 21h5v-5"/>
      </svg>
      Loading...
    `;

    const response = await authFetch('/api/ports');
    const result = await response.json();

    if (result.success) {
      allPorts = result.data.ports;
      lastPortsAt = Date.now();
      applyEdge(result.data.edge);
      lastUpdate.textContent = new Date(result.data.timestamp).toLocaleTimeString();
      platform.textContent = result.data.platform;
      await fetchTunnels();
      renderTable();
      renderTunnels();
    } else {
      showToast('Error: ' + result.error, 'error');
    }
  } catch (error) {
    showToast('Failed to fetch ports: ' + error.message, 'error');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: -2px;">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
        <path d="M16 21h5v-5"/>
      </svg>
      Refresh
    `;
  }
}

async function fetchTunnels() {
  try {
    const response = await authFetch('/api/tunnels');
    const result = await response.json();
    if (result.success) {
      activeTunnels = {};
      result.data.tunnels.forEach(t => {
        activeTunnels[t.port] = t;
      });
    }
  } catch {
    // silent fail
  }
}

function filterPorts() {
  const search = searchInput.value.toLowerCase();
  const protocol = protocolFilter.value;
  const state = stateFilter.value;

  return allPorts.filter(port => {
    if (protocol && port.protocol !== protocol) return false;
    if (state && !port.state.toUpperCase().includes(state.toUpperCase())) return false;

    if (search) {
      const searchFields = [
        String(port.port),
        port.protocol,
        port.state,
        String(port.pid || ''),
        port.process || '',
        port.user || '',
        port.localAddress,
        port.remoteAddress || '',
        port.source || ''
      ].join(' ').toLowerCase();

      if (!searchFields.includes(search)) return false;
    }

    return true;
  });
}

function sortPorts(ports) {
  return [...ports].sort((a, b) => {
    let aVal = a[sortColumn];
    let bVal = b[sortColumn];

    if (aVal === null) aVal = '';
    if (bVal === null) bVal = '';

    if (sortColumn === 'port' || sortColumn === 'pid') {
      aVal = Number(aVal) || 0;
      bVal = Number(bVal) || 0;
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });
}

function dedupPorts(ports) {
  // Collapse rows that differ only by address family (IPv4 vs IPv6 dual-binding):
  // same protocol + port + pid + state → one row.
  const seen = new Map();
  for (const p of ports) {
    const key = `${p.protocol}|${p.port}|${p.pid ?? ''}|${p.state}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return Array.from(seen.values());
}

function renderTable() {
  const filtered = dedupPorts(filterPorts());
  const sorted = sortPorts(filtered);

  if (sorted.length === 0) {
    portsBody.innerHTML = '<tr><td colspan="6" class="loading">No ports found matching the criteria.</td></tr>';
    return;
  }

  portsBody.innerHTML = sorted.map(port => {
    const tunnel = activeTunnels[port.port];
    const isListening = port.state.toUpperCase() === 'LISTEN';
    const processName = (port.process || 'process').replace(/'/g, "\\'");

    let actions = '';
    if (port.pid) {
      const killing = pending.has('kill:' + port.pid);
      actions += `<button class="kill-btn" ${killing ? 'disabled' : ''} onclick="killProcess(${port.pid}, ${port.port}, '${processName}')">${killing ? 'Killing...' : 'Kill'}</button>`;
    }
    if (tunnel) {
      // Copy/Logs/Stop live on the tunnel card above - the row just links out.
      const status = tunnelStatus[port.port];
      actions += status && status.state === 'reconnecting'
        ? `<span class="tunnel-badge badge-reconnecting" title="Tunnel is reconnecting (attempt ${status.attempt})">Reconnecting</span>`
        : `<a class="tunnel-badge" href="${escapeHtml(tunnel.url)}" target="_blank" rel="noopener" title="${escapeHtml(tunnel.url)}">Live &#8599;</a>`;
    } else if (isListening) {
      const exposing = pending.has('expose:' + port.port);
      const blocked = !edge.available;
      const title = blocked ? `Tunnels unavailable - ${edgeMissingText()}` : `Expose port ${port.port} through the tunnel edge`;
      actions += `<button class="expose-btn" title="${escapeHtml(title)}" ${exposing || blocked ? 'disabled' : ''} onclick="exposeTunnel(${port.port})">${exposing ? 'Exposing...' : 'Expose'}</button>`;
    }

    return `
    <tr>
      <td><strong>${port.port}</strong></td>
      <td class="protocol-${port.protocol}">${port.protocol.toUpperCase()}</td>
      <td><span class="state-${port.state.toLowerCase()}">${port.state}</span></td>
      <td>${port.pid || '<span class="text-muted">-</span>'}</td>
      <td>${port.process || '<span class="text-muted">-</span>'}</td>
      <td><div class="actions-group">${actions}</div></td>
    </tr>
  `;
  }).join('');
}

function renderTunnels() {
  const entries = Object.values(activeTunnels);
  if (entries.length === 0) {
    tunnelsSection.style.display = 'none';
    return;
  }
  tunnelsSection.style.display = '';
  tunnelsCount.textContent = `(${entries.length})`;
  entries.sort((a, b) => a.port - b.port);
  tunnelsList.innerHTML = entries.map(t => {
    const status = tunnelStatus[t.port] || { state: 'live' };
    const portInfo = allPorts.find(p => p.port === t.port);
    const procName = portInfo ? (portInfo.process || '') : '';
    const statusHtml = status.state === 'reconnecting'
      ? `<span class="tunnel-status status-reconnecting">Reconnecting (attempt ${status.attempt})</span>`
      : `<span class="tunnel-status status-live">Live</span>`;
    const safeUrl = escapeHtml(t.url);
    return `
      <div class="tunnel-card">
        <div class="tunnel-card-head">
          <span class="tunnel-port">:${t.port}</span>
          ${procName ? `<span class="tunnel-proc">${escapeHtml(procName)}</span>` : ''}
          ${statusHtml}
        </div>
        <a class="tunnel-card-url" href="${safeUrl}" target="_blank" rel="noopener" title="${safeUrl}">${safeUrl}</a>
        <div class="tunnel-card-actions">
          <button class="btn" onclick="copyTunnelUrl('${t.url.replace(/'/g, "\\'")}')">Copy URL</button>
          <button class="btn" onclick="viewLogs(${t.port})">Logs</button>
          <button class="btn stop-tunnel-btn" ${pending.has('stop:' + t.port) ? 'disabled' : ''} onclick="stopTunnel(${t.port})">${pending.has('stop:' + t.port) ? 'Stopping...' : 'Stop'}</button>
        </div>
      </div>
    `;
  }).join('');
}

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

let toastTimer = null;

function showToast(message, type) {
  clearTimeout(toastTimer);
  toastMessage.textContent = message;
  toast.classList.toggle('toast-error', type === 'error');
  toast.classList.add('show');
  // Failures stick around until dismissed; a 3s flash is too easy to miss.
  if (type !== 'error') toastTimer = setTimeout(hideToast, 3000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast.classList.remove('show');
}

async function killProcess(pid, port, processName) {
  if (pending.has('kill:' + pid)) return;

  const go = await askConfirm({
    kicker: 'Port ' + port,
    title: 'Kill ' + processName + '?',
    body: 'PID ' + pid + ' is sent SIGTERM first and gets two seconds to exit. If it ignores that, it is force-killed.',
    action: 'Kill process',
  });
  if (!go) return;

  await runAction('kill:' + pid, async () => {
    try {
      const response = await authFetch(`/api/kill/${pid}`, { method: 'POST' });
      const result = await response.json();

      if (result.success) {
        showToast(result.data && result.data.signal === 'SIGKILL'
          ? `${processName} (PID: ${pid}) ignored SIGTERM - force-killed`
          : `${processName} (PID: ${pid}) stopped`);
        await fetchPorts();
      } else {
        showToast('Error: ' + result.error, 'error');
      }
    } catch (error) {
      showToast('Failed to kill process: ' + error.message, 'error');
    }
  });
}

async function exposeTunnel(port) {
  if (!edge.available) {
    showToast(`Tunnels unavailable - ${edgeMissingText()}`, 'error');
    return;
  }

  await runAction('expose:' + port, async () => {
    try {
      const response = await authFetch(`/api/expose/${port}`, { method: 'POST' });
      const result = await response.json();

      if (result.success) {
        showToast(`Port ${port} exposed: ${result.data.url}`);
        await fetchTunnels();
      } else {
        showToast('Error: ' + result.error, 'error');
      }
    } catch (error) {
      showToast('Failed to expose port: ' + error.message, 'error');
    }
  });
}

async function stopTunnel(port) {
  await runAction('stop:' + port, async () => {
    try {
      const response = await authFetch(`/api/expose/${port}`, { method: 'DELETE' });
      const result = await response.json();

      if (result.success) {
        showToast(`Tunnel for port ${port} closed`);
        if (logsPort === port) closeLogs();
        delete tunnelStatus[port];
        await fetchTunnels();
      } else {
        showToast('Error: ' + result.error, 'error');
      }
    } catch (error) {
      showToast('Failed to stop tunnel: ' + error.message, 'error');
    }
  });
}

function copyTunnelUrl(url) {
  copyText(url, 'URL copied to clipboard');
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch (error) {
    showToast('Copy failed: ' + error.message, 'error');
  }
}

// curl sets these itself, and they're hop-by-hop anyway.
const CURL_SKIP_HEADERS = new Set(['content-length', 'connection', 'transfer-encoding']);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Targets the local port, matching what Replay does - and keeps the tunnel's
// access token out of the clipboard.
function toCurl(log, port) {
  const parts = ['curl'];
  const method = (log.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push(`-X ${method}`);

  for (const [key, value] of Object.entries(log.requestHeaders || {})) {
    if (CURL_SKIP_HEADERS.has(key.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      parts.push(`-H ${shellQuote(`${key}: ${v}`)}`);
    }
  }

  if (log.requestBody) parts.push(`--data-raw ${shellQuote(log.requestBody)}`);
  parts.push(shellQuote(`http://localhost:${port}${log.path}`));
  return parts.join(' \\\n  ');
}

function copyAsCurl(logId) {
  const log = currentLogs.find(l => l.id === logId);
  if (!log || logsPort === null) return;
  copyText(toCurl(log, logsPort), 'Copied as cURL');
}

// Logs panel
async function viewLogs(port) {
  logsPort = port;
  logsPanel.classList.add('open');
  logsTitle.textContent = `Request Logs — Port ${port}`;
  await refreshLogs();
  // SSE pushes new logs; no polling needed.
}

function closeLogs() {
  logsPort = null;
  logsPanel.classList.remove('open');
}

async function refreshLogs() {
  if (!logsPort) return;
  try {
    const response = await authFetch(`/api/tunnels/${logsPort}/logs`);
    const result = await response.json();
    if (result.success) {
      renderLogs(result.data.logs);
    }
  } catch {
    // silent
  }
}

async function replayRequest(logId) {
  if (!logsPort) return;
  try {
    const response = await authFetch(`/api/tunnels/${logsPort}/replay/${encodeURIComponent(logId)}`, { method: 'POST' });
    const result = await response.json();
    if (result.success) {
      showToast(`Replayed → ${result.data.statusCode}`);
      await refreshLogs();
    } else {
      showToast('Replay failed: ' + result.error, 'error');
    }
  } catch (error) {
    showToast('Replay failed: ' + error.message, 'error');
  }
}

async function clearLogs() {
  if (!logsPort) return;
  try {
    await authFetch(`/api/tunnels/${logsPort}/logs`, { method: 'DELETE' });
    await refreshLogs();
    showToast('Logs cleared');
  } catch {
    showToast('Failed to clear logs', 'error');
  }
}

function statusClass(code) {
  if (code >= 200 && code < 300) return 'status-2xx';
  if (code >= 300 && code < 400) return 'status-3xx';
  if (code >= 400 && code < 500) return 'status-4xx';
  return 'status-5xx';
}

function renderLogs(logs) {
  currentLogs = logs;
  if (logs.length === 0) {
    logsList.innerHTML = '<div class="logs-empty">No requests yet. Send a request to the tunnel URL to see it here.</div>';
    return;
  }

  logsList.innerHTML = logs.slice().reverse().map(log => `
    <div class="log-entry" onclick="toggleLogDetail(this)">
      <div class="log-summary">
        <span class="log-method method-${log.method.toLowerCase()}">${log.method}</span>
        <span class="log-path">${log.path}</span>
        <span class="log-status ${statusClass(log.statusCode)}">${log.statusCode}</span>
        <span class="log-duration">${log.duration}ms</span>
        <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
        <span class="log-actions">
          <button class="curl-btn" title="Copy as a curl command against localhost:${logsPort}" onclick="event.stopPropagation(); copyAsCurl('${log.id}')">cURL</button>
          <button class="replay-btn" onclick="event.stopPropagation(); replayRequest('${log.id}')">Replay</button>
        </span>
      </div>
      <div class="log-detail">
        <div class="log-section">
          <div class="log-section-title">Request Headers</div>
          <pre class="log-body">${formatHeaders(log.requestHeaders)}</pre>
        </div>
        ${log.requestBody ? `
        <div class="log-section">
          <div class="log-section-title">Request Body</div>
          <pre class="log-body">${escapeHtml(formatBody(log.requestBody))}</pre>
        </div>` : ''}
        ${log.responseBody ? `
        <div class="log-section">
          <div class="log-section-title">Response Body</div>
          <pre class="log-body">${escapeHtml(formatBody(log.responseBody))}</pre>
        </div>` : ''}
      </div>
    </div>
  `).join('');
}

function toggleLogDetail(el) {
  el.classList.toggle('expanded');
}

function formatHeaders(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `<span class="header-key">${escapeHtml(k)}</span>: ${escapeHtml(String(v))}`)
    .join('\n');
}

function formatBody(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.killProcess = killProcess;
window.exposeTunnel = exposeTunnel;
window.stopTunnel = stopTunnel;
window.copyTunnelUrl = copyTunnelUrl;
window.viewLogs = viewLogs;
window.closeLogs = closeLogs;
window.clearLogs = clearLogs;
window.replayRequest = replayRequest;
window.toggleLogDetail = toggleLogDetail;
window.hideToast = hideToast;
window.copyAsCurl = copyAsCurl;

// Add spin animation for loading state
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
