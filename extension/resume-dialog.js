// Request data from background script
async function loadData() {
  let failed = [];
  let newFile = '';

  // Try message first (most reliable)
  try {
    const data = await chrome.runtime.sendMessage({action: 'getResumeDialogData'});
    if (data && data.failed) {
      failed = data.failed;
      newFile = data.newFile || '';
      console.log(`Got ${failed.length} items via message`);
    }
  } catch (e) {
    console.log('Message request failed:', e);
  }

  // Fallback to storage
  if (failed.length === 0) {
    try {
      const data = await chrome.storage.local.get('resumeDialogData');
      if (data.resumeDialogData) {
        failed = data.resumeDialogData.failed || [];
        newFile = data.resumeDialogData.newFile || '';
        console.log(`Got ${failed.length} items from storage`);
      }
    } catch (e) {
      console.log('Storage read failed:', e);
    }
  }

  renderList(failed, newFile);
}

function renderList(failed, newFile) {
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

  // Cleanup
  chrome.storage.local.remove('resumeDialogData');
}

loadData();

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
