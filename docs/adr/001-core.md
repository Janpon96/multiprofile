# ADR-001 — Baseline Windows và mô hình ownership

**Status:** Accepted as design baseline, pending empirical G0 checks.  
**Date:** 29/10/2026.

| Quyết định | Vì sao | Hệ quả |
|---|---|---|
| Electron/TypeScript | Cùng ngôn ngữ UI/controller/browser | Chi phí RAM Dashboard; phải làm renderer isolation |
| Một worker + browser/profile | Lifecycle và data ownership rõ | Nhiều profile tốn RAM; cần admission control |
| Persistent data dir riêng | Giữ login, tránh trộn state | OS lock, backup stopped-state, restore/version handling |
| Tất cả proxy qua local relay | Một đường xử lý auth/health/tunnels | Thêm process I/O; cần throughput/secret/no-direct tests |
| DOM default, Coordinate opt-in | DOM chịu layout khác nhau tốt hơn | Không tự fallback khi locator thất bại |
| FIFO/Follower + fan-out | Giữ thứ tự, cô lập follower chậm | Không phải transaction cả nhóm |
| UNKNOWN không auto retry | Tránh effect trùng khi mất ACK | Người vận hành phải đối soát một số lỗi |
| Capture isolated world | Giảm bridge exposure tới page JS | CDP context/frame lifecycle phức tạp, cần G0 |
| Local-only control | Không cần auth server/remote surface | Remote API là một thiết kế riêng trong V2 |

## Không chọn trong V1

Không tự fork Chromium; không dùng extension auth làm tuyến mặc định; không dùng `asyncio.create_task` hoặc Promise không giới hạn cho event; không mở profile Chrome cá nhân; không bán lời hứa fingerprint độc nhất hay vượt anti-bot.

## Khi nào xem xét đổi

G0 chứng minh utilityProcess packaging/capture/relay không đáp ứng. Đề xuất ADR mới có reproduction, phương án khác, ảnh hưởng contracts/runbook, test chuyển đổi và chi phí bảo trì. Không chỉ đổi công nghệ vì agent quen framework khác.
