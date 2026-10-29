# MultiProfile Studio — Implementation Kit

Bộ hồ sơ ngày 29/10/2026 cho công cụ PC quản lý nhiều profile, proxy riêng và đồng bộ thao tác. **Đây là bộ plan/specs/runbook, chưa phải ứng dụng hoặc installer.**

## Bắt đầu

1. Đọc [ANTIGRAVITY_START_HERE.md](ANTIGRAVITY_START_HERE.md) và dán phần prompt vào Antigravity trong repo dự án.
2. Tài liệu chuẩn: [MultiProfile_PC_Plan_Specs_Runbook_VI.md](MultiProfile_PC_Plan_Specs_Runbook_VI.md). Khi có khác biệt, sửa hợp đồng bằng ADR, không âm thầm thay yêu cầu.
3. Thực hiện G0 → G5; xem [qa/acceptance.csv](qa/acceptance.csv). Mọi test ứng dụng hiện có trạng thái NOT_RUN.

## Cấu trúc

| Đường dẫn | Mục đích |
|---|---|
| `MultiProfile_PC_Plan_Specs_Runbook_VI.md` | Plan, specs, vận hành, sự cố và nguồn kỹ thuật |
| `ANTIGRAVITY_START_HERE.md` | Prompt triển khai, quy tắc bằng chứng, cách tiếp tục |
| `docs/REPOSITORY_BLUEPRINT.md` | Cấu trúc repo ứng dụng đề xuất |
| `docs/SYNC_ALGORITHMS.md` | Pseudocode thứ tự, dispatch và recovery |
| `docs/ADR_001_CORE.md` | Những quyết định đã chốt và điều kiện đổi |
| `contracts/*.schema.json` | JSON Schema Draft-07 cho metadata/events tham chiếu |
| `contracts/migrations/001_initial.sql` | SQLite DDL tham chiếu, không chứa dữ liệu người dùng |
| `examples/` | Ví dụ giả; không có proxy hoặc credentials sử dụng được |
| `config/version-matrix.template.json` | Điền phiên bản thật ở G0; null nghĩa chưa xác minh |
| `qa/` | Acceptance, checklist, mẫu benchmark và báo cáo kiểm tra kit |
| `scripts/validate_kit.py` | Kiểm tra tính nhất quán kit bằng Python chuẩn |
| `MANIFEST.sha256` | Hash từng file để kiểm tra tính toàn vẹn khi bàn giao |

## Kiểm tra bộ tài liệu

```text
python scripts/validate_kit.py
```

Script này kiểm tra JSON, subset JSON Schema được dùng trong kit, fixtures dương/âm, SQLite constraints và truy vết FR→test. Nó không mở Chromium, không kiểm tra proxy thật, không thay thế trình validator JSON Schema chuẩn hoặc suite của ứng dụng. Trong repo ứng dụng, dùng validator chuẩn và generate types từ một nguồn contract duy nhất.

Không cần thêm tài khoản hoặc proxy thật để đọc kit. Chỉ nhập credentials vào ứng dụng sau khi SecretStore và log-redaction đã được triển khai/kiểm thử. Mẫu có `example` và `demo` chỉ để giải thích cấu trúc.
