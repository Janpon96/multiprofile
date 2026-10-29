# Release Checklist - MultiProfile Studio (Windows 11 x64)

Trang thai thuc te sau khi doi chieu voi `qa/acceptance.csv` (PASS / PARTIAL / NOT_RUN / FAIL).

- [ ] FR-01..FR-16 co evidence; moi P0 PASS tren Windows that.
- [ ] G0 version matrix dien day du (Electron chua cai, hash chua kiem).
- [x] Cookie/localStorage/IndexedDB tach roi giua 3 profile Chromium that (AT-002).
- [ ] Double-launch bi chan, StartMany, 20 vong start/stop (AT-003, AT-011: NOT_RUN).
- [ ] Matrix HTTP/HTTPS/SOCKS5 trong browser that (AT-006: PARTIAL, assert long).
- [ ] Sync Master -> Follower trong browser that (AT-014..AT-026: PARTIAL, logic-level).
- [ ] Single/double click, SPA/BFCache, frame/popup (AT-016, AT-021, AT-022: NOT_RUN).
- [ ] Secret backend OS-backed, khong plaintext fallback (AT-035: LocalSecretStore chi giu trong RAM).
- [ ] Job Object + startup reconciliation (AT-033: NOT_RUN).
- [ ] Installer may sach, khong can Node (AT-036: NOT_RUN, chua co installer).
- [ ] Soak 10 profile 60 phut (AT-037: NOT_RUN, bench chua do that).
- [ ] V1 khong mo cong dieu khien (AT-040: FAIL, dang co HTTP server localhost).

**Release decision:** NOT READY. Con P0 o trang thai PARTIAL / NOT_RUN / FAIL.
