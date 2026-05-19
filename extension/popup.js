let currentTab = 'active';
let refreshInterval;
let lastData = null;

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    renderDownloads(lastData);
  });
});

// Event delegation for action buttons - works even after innerHTML replace
document.getElementById('download-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();

  const command = btn.dataset.command;
  const gid = btn.dataset.gid;
  const path = btn.dataset.path;

  if (command === 'openFile' && path) {
    openFile(path);
  } else if (command && gid) {
    controlDownload(command, gid);
  }
});

function formatBytes(bytes) {
  if (!bytes || bytes === '0') return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === '0') return '0 B/s';
  return formatBytes(bytesPerSec) + '/s';
}

function formatEta(completed, total, speed) {
  if (!speed || speed === '0' || !total || total === '0') return '--';
  const remaining = (total - completed) / speed;
  if (remaining < 60) return Math.round(remaining) + 's';
  if (remaining < 3600) return Math.round(remaining / 60) + 'm';
  return Math.round(remaining / 3600) + 'h';
}

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

function getFilePath(dl) {
  if (dl.files && dl.files[0] && dl.files[0].path) {
    return dl.files[0].path;
  }
  return '';
}

function getActionButtons(dl) {
  const gid = dl.gid;
  const filePath = getFilePath(dl);
  if (dl.status === 'active') {
    return `
      <button class="btn btn-pause" data-command="pause" data-gid="${gid}">Pause</button>
      <button class="btn btn-cancel" data-command="cancel" data-gid="${gid}">Cancel</button>
    `;
  }
  if (dl.status === 'paused') {
    return `
      <button class="btn btn-resume" data-command="unpause" data-gid="${gid}">Resume</button>
      <button class="btn btn-cancel" data-command="cancel" data-gid="${gid}">Cancel</button>
    `;
  }
  if (dl.status === 'waiting') {
    return `
      <button class="btn btn-cancel" data-command="cancel" data-gid="${gid}">Cancel</button>
    `;
  }
  if (dl.status === 'complete' && filePath) {
    return `
      <button class="btn btn-open" data-command="openFile" data-path="${escapeHtml(filePath)}">Open</button>
    `;
  }
  // Error/removed: no retry button (token expired would create Unknown file)
  // User should re-download from source, resume dialog will handle it
  if (dl.status === 'error' || dl.status === 'removed') {
    return '';
  }
  return '';
}

function renderDownloadItem(dl) {
  const total = parseInt(dl.totalLength) || 0;
  const completed = parseInt(dl.completedLength) || 0;
  const speed = parseInt(dl.downloadSpeed) || 0;
  const rawPercent = total > 0 ? (completed / total) * 100 : 0;
  // Show 1 decimal when >99% to avoid showing "100%" for incomplete downloads
  const percent = rawPercent >= 99 && rawPercent < 100
    ? rawPercent.toFixed(1)
    : Math.round(rawPercent);
  const filename = getFilename(dl);

  return `
    <div class="download-item">
      <div class="dl-header">
        <div class="dl-filename">${escapeHtml(filename)} ${getStatusBadge(dl.status)}</div>
        <div class="dl-actions">${getActionButtons(dl)}</div>
      </div>
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
  if (currentTab === 'active') items = (data.active || []).reverse();
  else if (currentTab === 'waiting') items = (data.waiting || []).reverse();
  else if (currentTab === 'completed') items = (data.stopped || []).reverse();

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

async function openFile(path) {
  try {
    await chrome.runtime.sendMessage({action: 'openFile', path: path});
  } catch (e) {
    console.error('Open file error:', e);
  }
}

async function controlDownload(command, gid) {
  // Visual feedback
  const btns = document.querySelectorAll('.btn');
  btns.forEach(b => {
    b.disabled = true;
    b.dataset.originalText = b.textContent;
    b.textContent = '...';
  });

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'controlDownload',
      command: command,
      gid: gid
    });
    console.log('Control response:', response);
  } catch (e) {
    console.error('Control error:', e);
  }

  // Refresh
  fetchDownloads();
  setTimeout(fetchDownloads, 500);
  setTimeout(fetchDownloads, 1000);
}

async function fetchDownloads() {
  try {
    const data = await chrome.runtime.sendMessage({action: 'getDownloads'});
    lastData = data;
    renderDownloads(data);
  } catch (e) {
    renderDownloads({error: e.message});
  }
}

// Init
fetchDownloads();
refreshInterval = setInterval(fetchDownloads, 1000);

window.addEventListener('unload', () => {
  clearInterval(refreshInterval);
});
