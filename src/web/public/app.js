// State
let allPorts = [];
let activeTunnels = {};
let sortColumn = 'port';
let sortDirection = 'asc';
let logsPort = null;
let logsInterval = null;

// DOM Elements
const portsBody = document.getElementById('portsBody');
const searchInput = document.getElementById('searchInput');
const protocolFilter = document.getElementById('protocolFilter');
const stateFilter = document.getElementById('stateFilter');
const refreshBtn = document.getElementById('refreshBtn');
const toast = document.getElementById('toast');
const lastUpdate = document.getElementById('lastUpdate');
const platform = document.getElementById('platform');
const logsPanel = document.getElementById('logsPanel');
const logsList = document.getElementById('logsList');
const logsTitle = document.getElementById('logsTitle');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  fetchPorts();
  setupEventListeners();
});

function setupEventListeners() {
  refreshBtn.addEventListener('click', fetchPorts);
  searchInput.addEventListener('input', renderTable);
  protocolFilter.addEventListener('change', renderTable);
  stateFilter.addEventListener('change', renderTable);

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

    const response = await fetch('/api/ports');
    const result = await response.json();

    if (result.success) {
      allPorts = result.data.ports;
      lastUpdate.textContent = `Last updated: ${new Date(result.data.timestamp).toLocaleTimeString()}`;
      platform.textContent = `Platform: ${result.data.platform}`;
      await fetchTunnels();
      renderTable();
    } else {
      showToast('Error: ' + result.error);
    }
  } catch (error) {
    showToast('Failed to fetch ports: ' + error.message);
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
    const response = await fetch('/api/tunnels');
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

function renderTable() {
  const filtered = filterPorts();
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
      actions += `<button class="kill-btn" onclick="killProcess(${port.pid}, ${port.port}, '${processName}')">Kill</button>`;
    }
    if (tunnel) {
      actions += `
        <span class="tunnel-url" title="${tunnel.url}">${tunnel.url}</span>
        <button class="copy-url-btn" onclick="copyTunnelUrl('${tunnel.url}')">Copy</button>
        <button class="logs-btn" onclick="viewLogs(${port.port})">Logs</button>
        <button class="stop-tunnel-btn" onclick="stopTunnel(${port.port})">Stop</button>
      `;
    } else if (isListening) {
      actions += `<button class="expose-btn" onclick="exposeTunnel(${port.port})">Expose</button>`;
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

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

async function killProcess(pid, port, processName) {
  if (!confirm(`Are you sure you want to kill "${processName}" (PID: ${pid}) on port ${port}?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/kill/${pid}`, { method: 'POST' });
    const result = await response.json();

    if (result.success) {
      showToast(`Process ${processName} (PID: ${pid}) killed successfully`);
      fetchPorts();
    } else {
      showToast('Error: ' + result.error);
    }
  } catch (error) {
    showToast('Failed to kill process: ' + error.message);
  }
}

async function exposeTunnel(port) {
  try {
    showToast(`Exposing port ${port}...`);
    const response = await fetch(`/api/expose/${port}`, { method: 'POST' });
    const result = await response.json();

    if (result.success) {
      showToast(`Port ${port} exposed: ${result.data.url}`);
      await fetchTunnels();
      renderTable();
    } else {
      showToast('Error: ' + result.error);
    }
  } catch (error) {
    showToast('Failed to expose port: ' + error.message);
  }
}

async function stopTunnel(port) {
  try {
    const response = await fetch(`/api/expose/${port}`, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      showToast(`Tunnel for port ${port} closed`);
      if (logsPort === port) closeLogs();
      await fetchTunnels();
      renderTable();
    } else {
      showToast('Error: ' + result.error);
    }
  } catch (error) {
    showToast('Failed to stop tunnel: ' + error.message);
  }
}

function copyTunnelUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('URL copied to clipboard');
  });
}

// Logs panel
async function viewLogs(port) {
  logsPort = port;
  logsPanel.classList.add('open');
  logsTitle.textContent = `Request Logs — Port ${port}`;
  await refreshLogs();
  // Poll every 2 seconds
  if (logsInterval) clearInterval(logsInterval);
  logsInterval = setInterval(refreshLogs, 2000);
}

function closeLogs() {
  logsPort = null;
  logsPanel.classList.remove('open');
  if (logsInterval) {
    clearInterval(logsInterval);
    logsInterval = null;
  }
}

async function refreshLogs() {
  if (!logsPort) return;
  try {
    const response = await fetch(`/api/tunnels/${logsPort}/logs`);
    const result = await response.json();
    if (result.success) {
      renderLogs(result.data.logs);
    }
  } catch {
    // silent
  }
}

async function clearLogs() {
  if (!logsPort) return;
  try {
    await fetch(`/api/tunnels/${logsPort}/logs`, { method: 'DELETE' });
    await refreshLogs();
    showToast('Logs cleared');
  } catch {
    showToast('Failed to clear logs');
  }
}

function statusClass(code) {
  if (code >= 200 && code < 300) return 'status-2xx';
  if (code >= 300 && code < 400) return 'status-3xx';
  if (code >= 400 && code < 500) return 'status-4xx';
  return 'status-5xx';
}

function renderLogs(logs) {
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
window.toggleLogDetail = toggleLogDetail;

// Add spin animation for loading state
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
