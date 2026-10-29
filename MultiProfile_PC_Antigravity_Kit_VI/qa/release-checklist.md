# Release checklist

Tất cả mục dưới đây chưa được thực hiện trong kit thiết kế.

- [ ] FR-01…FR-16 có evidence; mọi P0 PASS trên target Windows đã chốt.
- [ ] G0 version matrix điền đầy đủ bằng phiên bản/revision thật; dependency lock có checksum.
- [ ] Profile cookies/localStorage/IndexedDB/service worker độc lập; double-launch bị chặn.
- [ ] HTTP/HTTPS/SOCKS5 auth/no-auth matrix; browser egress; required không fallback direct.
- [ ] DNS/IPv6/WebRTC/QUIC/WS/service worker/loopback được đo, ghi đúng phạm vi đảm bảo.
- [ ] Capture source/context xác thực; renderer/trang không có raw shell/file/CDP API.
- [ ] Text IME, emoji, selected replace, undo/paste không trùng và không lộ logs.
- [ ] FIFO/epoch/navigation/dedup/UNKNOWN/timeout/queue overflow và emergency stop.
- [ ] Variables map theo ID; preview thiếu dữ liệu; CSV export chống formula injection.
- [ ] Multi-monitor DPI; thực tế viewport; không thu cửa sổ làm sai coordinate âm thầm.
- [ ] Job Object và startup reconciliation; không còn orphan, không kill Chrome cá nhân.
- [ ] Backup nhất quán; restore dữ liệu mã hóa; thử update/rollback matching engine.
- [ ] Installer chạy trên máy sạch, không cần Node global; browser resources/ABI/ký binary hợp lệ.
- [ ] Soak 10 profile 60 phút có CPU/RAM/queue/latency report; 20-profile stress ghi riêng.
- [ ] Canary secrets không xuất hiện trong logs/diagnostics; mặc định không có HAR/screenshot/text.
- [ ] Release notes mô tả capabilities/unsupported; không có nút giả hoặc tuyên bố chống bot 100%.
- [ ] Người vận hành thực hiện được runbook B và recovery theo C mà không cần sửa code.

**Release decision:** NOT_READY cho tới khi các mục bắt buộc có evidence. Đây là trạng thái của dự án chưa triển khai, không phải một lỗi của kit tài liệu.
