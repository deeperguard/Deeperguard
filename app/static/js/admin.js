(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatDate(ts) {
    const n = Number(ts) || 0;
    if (!n) return '—';
    return new Date(n * 1000).toLocaleString();
  }

  function quotaMb(user) {
    const q = Number(user.storage_quota_bytes) || 0;
    return q > 0 ? Math.round(q / (1024 * 1024)) : 0;
  }

  let csrf = '';

  async function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (csrf && opts.method && opts.method !== 'GET') {
      opts.headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function renderUsers(users) {
    const body = document.getElementById('admin-users-body');
    if (!users.length) {
      body.innerHTML = '<tr><td colspan="10" class="muted">No users yet.</td></tr>';
      return;
    }
    body.innerHTML = users.map((user) => {
      const used = formatBytes(user.storage_used_bytes);
      const quota = quotaMb(user);
      const pct = user.storage_percent != null ? ` (${user.storage_percent}%)` : '';
      const envLocked = Boolean(user.admin_env_locked);
      const adminChecked = user.is_admin ? 'checked' : '';
      const adminDisabled = envLocked ? 'disabled title="Admin via NOTES_ADMIN_EMAILS"' : '';
      const envBadge = envLocked ? ' <span class="admin-env-badge">env</span>' : '';
      const plan = String(user.plan || 'pro').toLowerCase();
      return `<tr data-user-id="${user.id}">
        <td>${escapeHtml(user.email)}${envBadge}</td>
        <td>
          <select class="admin-plan-select">
            <option value="basic"${plan === 'basic' ? ' selected' : ''}>Basic</option>
            <option value="pro"${plan === 'pro' ? ' selected' : ''}>Pro</option>
          </select>
        </td>
        <td>${escapeHtml(used)}${escapeHtml(pct)}</td>
        <td>
          <input type="number" min="0" step="1" class="admin-quota-input" value="${quota}" title="0 = unlimited">
        </td>
        <td>${user.active_items} <span class="muted">/ ${user.item_count}</span></td>
        <td>${user.totp_enabled ? 'Yes' : '—'}</td>
        <td>${user.passkey_count || 0}</td>
        <td><input type="checkbox" class="admin-admin-toggle" ${adminChecked} ${adminDisabled}></td>
        <td>${escapeHtml(formatDate(user.created_at))}</td>
        <td class="admin-actions">
          <button type="button" class="btn subtle admin-save">Save</button>
          <button type="button" class="btn subtle admin-delete">Delete</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderOps(data) {
    const ops = data?.ops || {};
    const healthEl = document.getElementById('ops-health');
    if (healthEl) {
      healthEl.textContent = ops.health_ok ? 'OK' : 'Check disk or database';
    }
    const reg = document.getElementById('ops-registration');
    if (reg) reg.textContent = ops.registration_open ? 'Open' : 'Closed';
    const smtp = document.getElementById('ops-smtp');
    if (smtp) smtp.textContent = ops.smtp_configured ? 'Configured' : 'Not configured';
    const ocr = document.getElementById('ops-ocr');
    if (ocr) {
      ocr.textContent = ops.ocr_mode === 'server'
        ? 'Server OCR (legacy)'
        : (ops.ocr_ephemeral ? 'Client OCR (ephemeral index)' : 'Client OCR (stored index)');
    }
    const backups = document.getElementById('ops-backups');
    if (backups) backups.textContent = 'Daily cron — see deploy/cron/deeperguard-backup';
  }

  function renderServerStats(data) {
    const server = data?.server || {};
    const build = String(data?.build || '').trim();
    document.getElementById('stat-build').textContent = build ? build.slice(0, 8) : '—';
    const free = Number(server.disk_free_bytes) || 0;
    const total = Number(server.disk_total_bytes) || 0;
    document.getElementById('stat-disk-free').textContent = total
      ? `${formatBytes(free)} of ${formatBytes(total)}`
      : formatBytes(free);
    document.getElementById('stat-disk-total').textContent = formatBytes(total);
    document.getElementById('stat-db-size').textContent = formatBytes(server.db_bytes || 0);
    const ocrEphemeral = Boolean(server.ocr_ephemeral);
    const ocrTotal = Number(server.ocr_bytes_total) || 0;
    document.getElementById('stat-ocr-total').textContent = ocrEphemeral
      ? 'Ephemeral (not stored)'
      : formatBytes(ocrTotal);
    const updated = document.getElementById('admin-server-updated');
    const computedAt = Number(server.computed_at) || Number(data?.generated_at) || 0;
    if (updated) {
      if (computedAt > 0) {
        updated.hidden = false;
        updated.textContent = `Server stats as of ${formatDate(computedAt)}`;
      } else {
        updated.hidden = true;
        updated.textContent = '';
      }
    }
  }

  async function loadOverview() {
    const err = document.getElementById('admin-error');
    err.hidden = true;
    const data = await api('/api/admin/overview');
    csrf = data.csrf || csrf;
    document.getElementById('stat-users').textContent = String(data.user_count || 0);
    document.getElementById('stat-storage').textContent = formatBytes(data.total_storage_used_bytes || 0);
    renderServerStats(data);
    renderOps(data);
    renderUsers(data.users || []);
  }

  async function saveRow(row) {
    const id = Number(row.dataset.userId);
    const quotaMbVal = Number(row.querySelector('.admin-quota-input').value);
    const planVal = String(row.querySelector('.admin-plan-select')?.value || 'pro');
    const toggle = row.querySelector('.admin-admin-toggle');
    const isAdmin = toggle ? toggle.checked : false;
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ storage_quota_mb: quotaMbVal, plan: planVal, is_admin: isAdmin }),
    });
    await loadOverview();
  }

  async function deleteRow(row) {
    const id = Number(row.dataset.userId);
    const email = row.querySelector('td')?.textContent?.replace(/\s*env\s*$/, '').trim() || 'this user';
    if (!window.confirm(`Delete ${email}? This removes all encrypted data permanently.`)) return;
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    await loadOverview();
  }

  document.getElementById('admin-users-body').addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    const row = btn.closest('tr[data-user-id]');
    if (!row) return;
    if (btn.classList.contains('admin-save')) {
      saveRow(row).catch((e) => {
        const err = document.getElementById('admin-error');
        err.textContent = e.message || 'Save failed';
        err.hidden = false;
      });
    }
    if (btn.classList.contains('admin-delete')) {
      deleteRow(row).catch((e) => {
        const err = document.getElementById('admin-error');
        err.textContent = e.message || 'Delete failed';
        err.hidden = false;
      });
    }
  });

  document.getElementById('admin-refresh').addEventListener('click', () => {
    loadOverview().catch((e) => {
      const err = document.getElementById('admin-error');
      err.textContent = e.message || 'Load failed';
      err.hidden = false;
    });
  });

  loadOverview().catch((e) => {
    const err = document.getElementById('admin-error');
    err.textContent = e.message || 'Load failed';
    err.hidden = false;
  });
})();
