# Blueprint repo ứng dụng

Đây là cấu trúc đề xuất cần tạo khi implementation; các thư mục `apps/` và `packages/` dưới đây chưa tồn tại trong kit.

| Đường dẫn repo | Trách nhiệm |
|---|---|
| `apps/desktop/src/main/` | Entry, IPC sender validation, profile services, SQLite single writer, SecretStore |
| `apps/desktop/src/preload/` | Typed API nhỏ qua contextBridge, không expose raw IPC/eval |
| `apps/desktop/src/renderer/` | Profile table, proxy pool, Sync Center, diagnostics |
| `apps/worker/src/` | Persistent context, relay, capture, action executor, heartbeat |
| `packages/contracts/` | Canonical schema/types; generate runtime validators và typings |
| `packages/domain/` | Pure state machines, policies, queue decisions, errors |
| `packages/storage/` | Migrations, repositories, transactions, redaction |
| `packages/proxy/` | Parser, URI normalization, relay adapter, preflight |
| `packages/sync/` | Canonicalization, FIFO, ACK, event dedup, barriers |
| `packages/browser/` | Playwright/CDP adapters, capabilities, page/frame registry |
| `packages/platform-windows/` | Job Object, verified process identity, tiling/DPI |
| `tests/fixtures/web/` | Form/canvas/navigation/frame/dialog/slow-page test sites |
| `tests/fixtures/proxy/` | HTTP(S)/SOCKS auth, TLS invalid, delay/drop/tunnel tests |
| `tests/e2e/windows/` | Real packaged app and real browser tests |
| `artifacts/` | Evidence, progress, benchmarks, capability reports, sanitized logs |
| `docs/adr/` | Accepted architectural changes |
| `release/` | Pinned manifests, signing config references, licenses |

## Dependency và process boundaries

Renderer chỉ gọi preload typed API. Main là nơi duy nhất thay metadata. Worker chỉ giữ config snapshot và secrets cần thiết trong RAM, không được sửa DB file trực tiếp. Domain không import Electron/Playwright để unit test độc lập. Browser adapter không biết UI component.

Controller spawn worker bằng utilityProcess với entrypoint đã đóng gói. Đăng ký process ownership/job trước khi cho worker spawn browser; worker báo ready sau khi được supervisor cho phép. Không cho renderer/trang tự chọn module path, executable hoặc launch args. G0 phải kiểm tra actual bundle layout vì browser binary và native modules thường không chạy trực tiếp trong ASAR; giải nén tài nguyên đúng vị trí do build config quản lý.

Dùng `playwright-core` nếu app chủ động quản lý engine path; full Playwright cho test/build có thể dùng nhưng không để downloader runtime quyết định revision. Lựa chọn package cụ thể phải đi cùng lockfile và browser revision, không đổi một nửa. Tắt default download auto-accept nếu chưa triển khai per-profile download manager.

## Script contract

Các tên script trong chương A3 của tài liệu chính phải tồn tại trong package.json ứng dụng và có semantics thực. `test:e2e:windows` phải fail rõ trên platform không hỗ trợ; không silently pass. `doctor` không ghi secret ra stdout. `bench` lưu hardware/version/scenario và counters, không chỉ thời gian wall-clock tổng.

## Evidence contract

Mỗi report có commit SHA hoặc source archive hash, app/build/engine revision, timestamp, OS, test IDs, actual commands, exit codes, kết quả và evidence paths. Screenshot chỉ từ fixture không có dữ liệu riêng. Report được log-redact trước khi export.

Không đưa file generated credentials/cookie vào git. Mẫu fixture dùng domain `.test`/`.example` và secrets giả. Worker/CDP endpoints không được log đầy đủ. Không tạo endpoint admin trên LAN để tiện debug.
