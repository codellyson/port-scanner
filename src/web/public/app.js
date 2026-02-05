// State
let allPorts = [];
let sortColumn = 'port';
let sortDirection = 'asc';
let autoRefreshInterval = null;

// DOM Elements
const portsBody = document.getElementById('portsBody');
const searchInput = document.getElementById('searchInput');
const protocolFilter = document.getElementById('protocolFilter');
const stateFilter = document.getElementById('stateFilter');
const refreshBtn = document.getElementById('refreshBtn');
const autoRefreshCheckbox = document.getElementById('autoRefresh');
const toast = document.getElementById('toast');

// Stats elements
const totalPorts = document.getElementById('totalPorts');
const tcpPorts = document.getElementById('tcpPorts');
const udpPorts = document.getElementById('udpPorts');
const listeningPorts = document.getElementById('listeningPorts');
const establishedPorts = document.getElementById('establishedPorts');
const lastUpdate = document.getElementById('lastUpdate');
const platform = document.getElementById('platform');

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
  autoRefreshCheckbox.addEventListener('change', toggleAutoRefresh);

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
      updateStats(result.data);
      lastUpdate.textContent = `Last updated: ${new Date(result.data.timestamp).toLocaleTimeString()}`;
      platform.textContent = `Platform: ${result.data.platform}`;
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

function updateStats(data) {
  const ports = data.ports;
  totalPorts.textContent = ports.length;
  tcpPorts.textContent = ports.filter(p => p.protocol === 'tcp').length;
  udpPorts.textContent = ports.filter(p => p.protocol === 'udp').length;
  listeningPorts.textContent = ports.filter(p => p.state.toUpperCase() === 'LISTEN').length;
  establishedPorts.textContent = ports.filter(p => p.state.toUpperCase() === 'ESTABLISHED').length;
}

function filterPorts() {
  const search = searchInput.value.toLowerCase();
  const protocol = protocolFilter.value;
  const state = stateFilter.value;

  return allPorts.filter(port => {
    // Protocol filter
    if (protocol && port.protocol !== protocol) return false;

    // State filter
    if (state && !port.state.toUpperCase().includes(state.toUpperCase())) return false;

    // Search filter
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

    // Handle null values
    if (aVal === null) aVal = '';
    if (bVal === null) bVal = '';

    // Numeric sort for port and pid
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
    portsBody.innerHTML = '<tr><td colspan="10" class="loading">No ports found matching the criteria.</td></tr>';
    return;
  }

  portsBody.innerHTML = sorted.map(port => `
    <tr>
      <td><strong>${port.port}</strong></td>
      <td class="protocol-${port.protocol}">${port.protocol.toUpperCase()}</td>
      <td><span class="state-${port.state.toLowerCase()}">${port.state}</span></td>
      <td>${port.pid || '<span class="text-muted">-</span>'}</td>
      <td>${port.process || '<span class="text-muted">-</span>'}</td>
      <td>${port.user || '<span class="text-muted">-</span>'}</td>
      <td>${port.localAddress}</td>
      <td>${port.remoteAddress || '<span class="text-muted">-</span>'}</td>
      <td class="source-cell" title="${port.source || ''}">${port.source || '<span class="text-muted">-</span>'}</td>
      <td>
        <button class="copy-btn" onclick="copyPort(${port.port})">Copy</button>
        ${port.pid ? `<button class="kill-btn" onclick="killProcess(${port.pid}, ${port.port}, '${port.process || 'process'}')">Kill</button>` : ''}
      </td>
    </tr>
  `).join('');
}

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function copyPort(port) {
  navigator.clipboard.writeText(String(port)).then(() => {
    showToast(`Port ${port} copied to clipboard`);
  }).catch(() => {
    showToast('Failed to copy to clipboard');
  });
}

function toggleAutoRefresh() {
  if (autoRefreshCheckbox.checked) {
    autoRefreshInterval = setInterval(fetchPorts, 5000);
    showToast('Auto-refresh enabled');
  } else {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    showToast('Auto-refresh disabled');
  }
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

// Make functions available globally
window.copyPort = copyPort;
window.killProcess = killProcess;

// Add spin animation for loading state
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
