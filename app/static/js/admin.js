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
            <option value="free"${plan === 'free' ? ' selected' : ''}>Free</option>
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

  function renderPcloud(state) {
    const st = state || {};
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const readOnly = Boolean(st.read_only);
    if (readOnly) {
      set('pcloud-configured', 'Yes (server environment)');
      set('pcloud-set', '—');
      set('pcloud-region', '—');
      set('pcloud-last-test', '—');
    } else {
      set('pcloud-configured', st.configured ? 'Yes' : 'No');
      set('pcloud-set', st.configured ? `${formatDate(st.set_at)} by ${st.set_by || '—'}` : '—');
      set('pcloud-region', st.configured ? String(st.region || '').toUpperCase() : '—');
      const lastTest = Number(st.last_test_at) || 0;
      set('pcloud-last-test', lastTest
        ? `${st.last_test_ok ? 'OK' : `Failed (${st.last_test_category || 'error'})`} — ${formatDate(lastTest)}`
        : '—');
    }
    const note = document.getElementById('pcloud-env-note');
    if (note) note.hidden = !readOnly;
    ['pcloud-token', 'pcloud-region-select', 'pcloud-save'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = readOnly;
    });
    const testBtn = document.getElementById('pcloud-test');
    if (testBtn) testBtn.disabled = readOnly || !st.configured;
    const removeBtn = document.getElementById('pcloud-remove');
    if (removeBtn) removeBtn.disabled = readOnly || !st.configured;
    const regionSel = document.getElementById('pcloud-region-select');
    if (regionSel && st.region) regionSel.value = st.region;
  }

  function pcloudMessage(text, isError) {
    const el = document.getElementById('pcloud-message');
    if (!el) return;
    el.textContent = text || '';
    el.className = isError ? 'error' : 'muted';
    el.hidden = !text;
  }

  async function loadPcloud() {
    const data = await api('/api/admin/pcloud-service');
    renderPcloud(data.pcloud);
  }

  async function runPcloud(action) {
    pcloudMessage('', false);
    const tokenEl = document.getElementById('pcloud-token');
    try {
      let data;
      if (action === 'save') {
        const token = tokenEl.value;
        tokenEl.value = '';
        data = await api('/api/admin/pcloud-service', {
          method: 'PUT',
          body: JSON.stringify({ token, region: document.getElementById('pcloud-region-select').value }),
        });
        pcloudMessage('Saved.', false);
      } else if (action === 'test') {
        data = await api('/api/admin/pcloud-service/test', { method: 'POST', body: '{}' });
        pcloudMessage(data.test_ok ? 'Connection OK.' : 'Connection failed.', !data.test_ok);
      } else {
        if (!window.confirm('Remove the pCloud backup connection?')) return;
        data = await api('/api/admin/pcloud-service', { method: 'DELETE' });
        pcloudMessage('Removed.', false);
      }
      renderPcloud(data.pcloud);
    } catch (e) {
      tokenEl.value = '';
      pcloudMessage(e.message || 'Request failed', true);
    }
  }

  document.getElementById('pcloud-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runPcloud('save');
  });
  document.getElementById('pcloud-test').addEventListener('click', () => runPcloud('test'));
  document.getElementById('pcloud-remove').addEventListener('click', () => runPcloud('remove'));

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
    await loadPcloud();
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
