// Read data from storage (set by background.js)
chrome.storage.local.get('resumeDialogData', (data) => {
  const info = data.resumeDialogData || {failed: [], newFile: ''};
  const failed = info.failed || [];
  const newFile = info.newFile || '';

  document.getElementById('count').textContent = failed.length;

  if (newFile) {
    document.getElementById('new-info').style.display = 'block';
    document.getElementById('new-filename').textContent = newFile;
  }

  const list = document.getElementById('list');
  if (failed.length === 0) {
    list.innerHTML = '<div class="empty">Tidak ada download gagal</div>';
    return;
  }

  list.innerHTML = '';
  failed.forEach(dl => {
    const mb = Math.round((parseInt(dl.completedLength) || 0) / 1024 / 1024);
    const totalMB = Math.round((parseInt(dl.totalLength) || 0) / 1024 / 1024);
    const name = dl.filename || 'Unknown';
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="item-info">
        <div class="item-name" title="${name}">${name}</div>
        <div class="item-meta">${mb}MB / ${totalMB}MB &middot; ${dl.status}</div>
      </div>
      <button class="btn btn-resume" data-gid="${dl.gid}">Resume</button>
    `;
    list.appendChild(div);
  });

  // Cleanup storage after reading
  chrome.storage.local.remove('resumeDialogData');
});

// Event delegation for resume buttons
document.getElementById('list').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-resume');
  if (!btn) return;
  const gid = btn.dataset.gid;
  chrome.runtime.sendMessage({action: 'resumeChoice', choice: 'resume', gid: gid});
  window.close();
});

document.getElementById('skip').addEventListener('click', () => {
  chrome.runtime.sendMessage({action: 'resumeChoice', choice: 'new'});
  window.close();
});
