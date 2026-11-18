import sys

f = r'e:\Antigravity Project\Tools New\multiprofile\apps\desktop\public\index.html'
with open(f, 'r', encoding='utf-8') as fh:
    content = fh.read()

print(f'File length: {len(content)}')

# ---- 1. Replace applyTiling stub ----
old_fn = "async function applyTiling() {\n      alert('\u0110\xe3 g\u1eedi l\u1ec7nh ph\xe2n b\u1ed5 b\u1ed1 tr\xed c\u1eeda s\u1ed5 theo k\xedch th\u01b0\u1edbc m\xe0n h\xecnh Windows hi\u1ec7n t\u1ea1i.');\n    }"
print(f'old_fn in content: {old_fn in content}')

new_fn = """async function applyTiling() {
      // Use master/follower from active sync session, or fall back to all READY profiles
      let masterProfileId = null;
      let followerProfileIds = [];

      if (typeof currentSyncSessionId !== 'undefined' && currentSyncSessionId) {
        const statusRes = await callIpc('sync.status', { session_id: currentSyncSessionId });
        if (statusRes.ok && statusRes.data) {
          masterProfileId = statusRes.data.master_profile_id;
          followerProfileIds = statusRes.data.follower_ids || [];
        }
      }

      if (!masterProfileId) {
        const listRes = await callIpc('profile.list');
        if (listRes.ok && listRes.data) {
          const running = listRes.data.filter(p => p.runtime_state === 'READY');
          if (running.length === 0) {
            showTileMessage('\u0110\u1ecb kh\xf4ng c\xf3 profile n\xe0o \u0111ang ch\u1ea1y (READY) \u0111\u1ec3 x\u1ebfp l\u01b0\u1edbi.', true);
            return;
          }
          masterProfileId = running[0].id;
          followerProfileIds = running.slice(1).map(p => p.id);
        }
      }

      showTileMessage('\u23f3 \u0110ang x\u1ebfp l\u01b0\u1edbi c\u1eeda s\u1ed5...', false);

      const gridVal = document.getElementById('tileGridSelect') ? document.getElementById('tileGridSelect').value : '2x2';
      const gridCols = gridVal === '3x3' ? 3 : 2;
      const gridRows = gridCols;

      const res = await callIpc('window.tile', { masterProfileId, followerProfileIds, gridCols, gridRows });

      if (!res.ok) {
        showTileMessage('\u274c L\u1ed7i x\u1ebfp l\u01b0\u1edbi: ' + (res.error ? res.error.message : 'Kh\xf4ng x\xe1c \u0111\u1ecbnh'), true);
        return;
      }
      const d = res.data;
      const failed = (d.results || []).filter(r => !r.success);
      if (failed.length === 0) {
        showTileMessage('\u2705 \u0110\xe3 x\u1ebfp l\u01b0\u1edbi ' + d.successCount + '/' + d.totalCount + ' c\u1eeda s\u1ed5 th\xe0nh c\xf4ng!', false);
      } else {
        const errSummary = failed.map(r => r.profileId.substring(0, 8) + ': ' + (r.error || 'th\u1ea5t b\u1ea1i')).join('\\n');
        showTileMessage('\u26a0\ufe0f X\u1ebfp l\u01b0\u1edbi ' + d.successCount + '/' + d.totalCount + ' c\u1eeda s\u1ed5 OK. Th\u1ea5t b\u1ea1i:\\n' + errSummary, true);
      }
    }

    function showTileMessage(text, isError) {
      const el = document.getElementById('tileMessage');
      if (!el) return;
      el.textContent = text;
      el.style.color = isError ? 'var(--danger)' : 'var(--success)';
    }

    // Standalone tile from Profiles tab (uses checkbox selection)
    async function tileSelectedProfiles() {
      const ids = selectedProfileIds();
      if (ids.length === 0) {
        showProfilesMessage(['\u0048\xe3y t\xedch ch\u1ecdn \xedt nh\u1ea5t 1 profile \u0111ang ch\u1ea1y \u0111\u1ec3 x\u1ebfp l\u01b0\u1edbi.']);
        return;
      }
      showProfilesMessage(['\u23f3 \u0110ang x\u1ebfp l\u01b0\u1edbi c\u1eeda s\u1ed5 profile \u0111\xe3 ch\u1ecdn...']);
      const masterProfileId = ids[0];
      const followerProfileIds = ids.slice(1);
      const res = await callIpc('window.tile', { masterProfileId, followerProfileIds });
      if (!res.ok) {
        showProfilesMessage(['\u274c L\u1ed7i x\u1ebfp l\u01b0\u1edbi: ' + (res.error ? res.error.message : 'Kh\xf4ng x\xe1c \u0111\u1ecbnh')]);
        return;
      }
      const d = res.data;
      showProfilesMessage(['\u2705 \u0110\xe3 x\u1ebfp l\u01b0\u1edbi ' + d.successCount + '/' + d.totalCount + ' c\u1eeda s\u1ed5. Profile \u0111\u1ea7u ti\xean l\xe0 Master.']);
    }

    // Layout view: load running profiles into checkbox list
    async function loadTileProfileList() {
      const listEl = document.getElementById('tileProfileList');
      if (!listEl) return;
      listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">\u0110ang t\u1ea3i...</div>';
      const res = await callIpc('profile.list');
      if (!res.ok || !res.data) {
        listEl.innerHTML = '<div style="color: var(--danger); font-size: 12px;">Kh\xf4ng th\u1ec3 t\u1ea3i danh s\xe1ch profile.</div>';
        return;
      }
      const running = res.data.filter(p => p.runtime_state === 'READY');
      if (running.length === 0) {
        listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Kh\xf4ng c\xf3 profile n\xe0o \u0111ang READY. H\xe3y kh\u1edfi ch\u1ea1y \xedt nh\u1ea5t 1 profile.</div>';
        return;
      }
      listEl.innerHTML = running.map((p, i) =>
        '<label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; padding: 4px 0;">' +
        '<input type="checkbox" class="tile-profile-cb" value="' + esc(p.id) + '" ' + (i < 4 ? 'checked' : '') + ' />' +
        '<span>' + colorDot(p.preset && p.preset.color, 10) + esc(p.name) + ' <span style="color: var(--text-muted); font-size: 11px;">(' + esc(p.id.substring(0, 8)) + ')</span></span>' +
        (i === 0 ? '<span class="pill pill-required" style="font-size:10px;">&#x1F451; Master</span>' : '') +
        '</label>'
      ).join('');
    }

    // Layout view: apply tiling to chosen profiles
    async function tileFromLayoutView() {
      const checked = Array.from(document.querySelectorAll('.tile-profile-cb:checked')).map(el => el.value);
      if (checked.length === 0) {
        const msgEl = document.getElementById('tileLayoutMessage');
        if (msgEl) { msgEl.textContent = 'H\xe3y ch\u1ecdn \xedt nh\u1ea5t 1 profile.'; msgEl.style.color = 'var(--danger)'; }
        return;
      }
      const msgEl = document.getElementById('tileLayoutMessage');
      if (msgEl) { msgEl.textContent = '\u23f3 \u0110ang x\u1ebfp l\u01b0\u1edbi...'; msgEl.style.color = 'var(--text-muted)'; }

      const gridVal = document.getElementById('tileGridSelect') ? document.getElementById('tileGridSelect').value : '2x2';
      const gridCols = gridVal === '3x3' ? 3 : 2;
      const gridRows = gridCols;

      const res = await callIpc('window.tile', {
        masterProfileId: checked[0],
        followerProfileIds: checked.slice(1),
        gridCols,
        gridRows
      });
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = '\u274c ' + (res.error ? res.error.message : 'L\u1ed7i kh\xf4ng x\xe1c \u0111\u1ecbnh'); msgEl.style.color = 'var(--danger)'; }
        return;
      }
      const d = res.data;
      const failed = (d.results || []).filter(r => !r.success);
      const text = failed.length === 0
        ? '\u2705 \u0110\xe3 x\u1ebfp l\u01b0\u1edbi ' + d.successCount + '/' + d.totalCount + ' c\u1eeda s\u1ed5 th\xe0nh c\xf4ng!'
        : '\u26a0\ufe0f ' + d.successCount + '/' + d.totalCount + ' OK. Th\u1ea5t b\u1ea1i:\\n' + failed.map(r => r.profileId.substring(0, 8) + ': ' + (r.error || 'th\u1ea5t b\u1ea1i')).join('\\n');
      if (msgEl) { msgEl.textContent = text; msgEl.style.color = failed.length === 0 ? 'var(--success)' : 'var(--warning)'; }
    }"""

content = content.replace(old_fn, new_fn)
print(f'After replace 1 - length: {len(content)}')

# ---- 2. Add tileMessage div and standalone panel to layout view ----
# Find the applyTiling button closing
old_panel_end = '          <button class="btn" onclick="applyTiling()">📐 Áp Dụng Xếp Lưới Cửa Sổ</button>\n        </div>\n      </div>'
if old_panel_end in content:
    new_panel = """          <button class="btn" onclick="applyTiling()">📐 Áp Dụng Xếp Lưới Cửa Sổ</button>
          <div id="tileMessage" style="margin-top: 12px; font-size: 12px; white-space: pre-line;"></div>
        </div>

        <div style="background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 20px; max-width: 500px; margin-top: 20px;">
          <div class="view-title" style="font-size: 14px; margin-bottom: 10px;">🪟 Xếp Cửa Sổ Độc Lập</div>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
            Chọn các profile đang chạy bên dưới (profile đầu tiên sẽ làm Master) rồi bấm Xếp.
          </p>
          <div id="tileProfileList" style="background: #0f172a; border: 1px solid var(--border); border-radius: 6px; padding: 10px; max-height: 180px; overflow-y: auto; margin-bottom: 14px;">
            <div style="color: var(--text-muted); font-size: 12px;">Đang tải...</div>
          </div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button class="btn btn-secondary" onclick="loadTileProfileList()">🔄 Làm mới danh sách</button>
            <button class="btn" onclick="tileFromLayoutView()">🪟 Xếp Cửa Sổ Đã Chọn</button>
          </div>
          <div id="tileLayoutMessage" style="margin-top: 12px; font-size: 12px; white-space: pre-line;"></div>
        </div>
      </div>"""
    content = content.replace(old_panel_end, new_panel)
    print('Layout panel added OK')
else:
    # Try unicode-escaped version
    old_panel_end2 = '          <button class="btn" onclick="applyTiling()">\u00f0\u009f\u0094 \u00c3\u2026p D\u1ee5ng X\u1ebfp L\u01b0\u1edbi C\u1eeda S\u1ed5</button>\n        </div>\n      </div>'
    print(f'Panel end fallback search: {old_panel_end2 in content}')
    # Search by partial
    idx = content.find('onclick="applyTiling()"')
    print(f'Button at {idx}:', repr(content[idx:idx+150]))

# ---- 3. Add tiling button to profiles toolbar ----
old_tb = 'onclick="stopSelected()">⏹️ Dừng mục đã chọn</button>\n            <button class="btn" onclick="openNewProfileModal()">'
new_tb = 'onclick="stopSelected()">⏹️ Dừng mục đã chọn</button>\n            <button class="btn btn-secondary" onclick="tileSelectedProfiles()">🪟 Xếp Cửa Sổ</button>\n            <button class="btn" onclick="openNewProfileModal()">'
if old_tb in content:
    content = content.replace(old_tb, new_tb)
    print('Toolbar button added OK')
else:
    # Check if already added
    if 'tileSelectedProfiles' in content:
        print('tileSelectedProfiles already in toolbar')
    else:
        print('WARNING: toolbar pattern not matched')
        idx = content.find('stopSelected()')
        print('stopSelected at:', idx, repr(content[idx:idx+120]))

# ---- 4. Wire switchView layout ----
old_sw = "if (viewName === 'sync') populateSyncSelectors();"
new_sw = "if (viewName === 'sync') populateSyncSelectors();\n      if (viewName === 'layout') loadTileProfileList();"
if old_sw in content and new_sw not in content:
    content = content.replace(old_sw, new_sw)
    print('switchView wired OK')
elif new_sw in content:
    print('switchView already wired')
else:
    print('WARNING: switchView not matched')

with open(f, 'w', encoding='utf-8') as fh:
    fh.write(content)

print(f'Done. Final length: {len(content)}')
