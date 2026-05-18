let currentTab = 'active';
let refreshInterval;

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    renderDownloads();
  });
});

// Format bytes
function formatBytes(bytes) {
  if (!bytes || bytes === '0') return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

// Format speed
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === '0') return '0 B/s';
  return formatBytes(bytesPerSec) + '/s';
}

// Format ETA
function formatEta(completed, total, speed) {
  if (!speed || speed === '0' || !total || total === '0') return '--';
  const remaining = (total - completed) / speed;
  if (remaining < 60) return Math.round(remaining) + 's';
  if (remaining < 3600) return Math.round(remaining / 60) + 'm';
  return Math.round(remaining / 3600) + 'h';
}

// Get filename from download item
function getFilename(dl) {
  if (dl.files && dl.files[0]) {
    const path = dl.files[0].path;
    if (path) return path.split(/[\\/]/).pop();
  }
  if (dl.bittorrent && dl.bittorrent.info && dl.bittorrent.info.name) {
    return dl.bittorrent.info.name;
  }
  return 'Unknown file';
}

// Get status badge
function getStatusBadge(status) {
  const map = {
    active: '<span class="dl-status-badge badge-active">Downloading</span>',
    waiting: '<span class="dl-status-badge badge-waiting">Waiting</span>',
    paused: '<span class="dl-status-badge badge-paused">Paused</span>',
    complete: '<span class="dl-status-badge badge-complete">Done</span>',
    error: '<span class="dl-status-badge badge-error">Error</span>',
    removed: '<span class="dl-status-badge badge-error">Removed</span>'
  };
  return map[status] || '';
}

// Render download items
function renderDownloadItem(dl) {
  const total = parseInt(dl.totalLength) || 0;
  const completed = parseInt(dl.completedLength) || 0;
  const speed = parseInt(dl.downloadSpeed) || 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const filename = getFilename(dl);

  return `
    <div class="download-item">
      <div class="dl-filename">${escapeHtml(filename)} ${getStatusBadge(dl.status)}</div>
      <div class="dl-progress-bar">
        <div class="dl-progress-fill" style="width: ${percent}%"></div>
      </div>
      <div class="dl-info">
        <span>${formatBytes(completed)} / ${formatBytes(total)} (${percent}%)</span>
        ${dl.status === 'active' ? `
          <span class="speed">${formatSpeed(speed)}</span>
          <span class="eta">ETA: ${formatEta(completed, total, speed)}</span>
        ` : ''}
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Main render
function renderDownloads(data) {
  const list = document.getElementById('download-list');
  const empty = document.getElementById('no-downloads');
  const error = document.getElementById('error-msg');

  if (!data) return;

  if (data.error) {
    error.style.display = 'block';
    list.style.display = 'none';
    empty.style.display = 'none';
    document.getElementById('status').textContent = 'Disconnected';
    document.getElementById('status').className = 'status error';
    return;
  }

  error.style.display = 'none';
  document.getElementById('status').textContent = 'Connected';
  document.getElementById('status').className = 'status connected';

  let items = [];
  if (currentTab === 'active') items = data.active || [];
  else if (currentTab === 'waiting') items = data.waiting || [];
  else if (currentTab === 'completed') items = data.stopped || [];

  if (items.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
    const labels = {active: 'download aktif', waiting: 'download waiting', completed: 'download selesai'};
    empty.querySelector('p').textContent = `Tidak ada ${labels[currentTab]}`;
  } else {
    list.style.display = 'block';
    empty.style.display = 'none';
    list.innerHTML = items.map(renderDownloadItem).join('');
  }
}

// Fetch data from background
async function fetchDownloads() {
  try {
    const data = await chrome.runtime.sendMessage({action: 'getDownloads'});
    renderDownloads(data);
  } catch (e) {
    renderDownloads({error: e.message});
  }
}

// Init
fetchDownloads();
refreshInterval = setInterval(fetchDownloads, 1000);

// Cleanup on close
window.addEventListener('unload', () => {
  clearInterval(refreshInterval);
});
