# Prompt khởi động cho Antigravity

Dán nội dung khối dưới đây trong workspace của repo dự án. Có thể dùng planning mode hoặc lệnh `/plan` nếu phiên bản Antigravity của bạn hỗ trợ. Kit không dựa vào extension riêng hay workflow đa agent bắt buộc.

```text
Hãy triển khai ứng dụng Windows MultiProfile Studio theo hồ sơ đi kèm.

Mục tiêu bắt buộc:
1. Tạo/import nhiều profile Chromium độc lập, dữ liệu phiên bền vững.
2. Nhập và gán proxy riêng; hỗ trợ HTTP/HTTPS Basic auth và SOCKS5
   username-password qua local forwarder; không fallback direct khi lỗi.
3. Mở nhiều profile cùng lúc, quản lý lifecycle/tài nguyên.
4. Chọn một Master và nhiều Followers để đồng bộ DOM hoặc coordinate;
   có text tiếng Việt/IME, queue tuần tự, ACK, navigation barrier,
   pause/resume và emergency stop.

Trước khi code, đọc:
- MultiProfile_PC_Plan_Specs_Runbook_VI.md
- docs/REPOSITORY_BLUEPRINT.md, docs/SYNC_ALGORITHMS.md
- contracts/, qa/acceptance.csv và config/version-matrix.template.json.
Nếu repo đã tồn tại, đọc hướng dẫn repo và thay đổi hiện có trước.
Không phá thay đổi người dùng, không tự chuyển stack mà không ghi ADR.

Chọn baseline Electron + TypeScript + React, worker/profile,
Playwright persistent context + Chromium được pin, SQLite, OS SecretStore.
Website ngoài chạy trong Chromium riêng, không có Node integration.

Triển khai theo G0 → G5. G0 phải chạy spike trên Windows thật:
packaged worker/browser, auth proxy, isolated-world capture, IME,
viewport/DPI, Job Object và secret backend. Điền version matrix bằng
phiên bản đã kiểm tra, không bịa số hoặc ghi latest.

Không thay core bằng mock UI. Mock chỉ dùng cho unit tests/fixture rõ ràng.
Không coi isTrusted là chống phát hiện; không thêm Canvas Noise,
WebGL spoof hoặc cơ chế vượt CAPTCHA/anti-bot vào phạm vi này.
Không gửi cookie, mật khẩu, text nhập hoặc proxy credentials vào logs.
Không tự chạy action browser chưa biết kết quả lần hai sau timeout.

Hãy tạo implementation plan, task checklist và ADR cần thiết trước.
Sau đó triển khai từng milestone trong phạm vi đã được cho phép.
Tôn trọng review policy đang có của workspace, không tự tạo thêm vòng
xác nhận cho các thao tác lập trình thường lệ đã được yêu cầu.
Chỉ hỏi khi thiếu quyết định thực sự chặn công việc; nếu là lựa chọn
implementation đã có default trong tài liệu, sử dụng default và ghi lại.

Sau mỗi gate, cập nhật artifacts/progress.md với:
- yêu cầu/test IDs hoàn thành;
- file đã đổi và hành vi đạt được;
- lệnh thực sự chạy, exit code, evidence path;
- vấn đề còn lại và bước kế tiếp.
Không ghi PASS cho browser/Windows/provider test chưa thực hiện.
Nếu môi trường thiếu Windows/proxy thật, hoàn thành phần độc lập bằng
fixture, giữ gate tương ứng chưa đạt và mô tả cách tái hiện.

Kết quả cuối cần mã nguồn build được, migrations, test fixtures,
installer Windows, version manifest, validation report, limitations
và runbook khớp UI. Bộ docs hiện tại chỉ là đầu vào thiết kế.
```

## Prompt tiếp tục sau khi gián đoạn

```text
Tiếp tục MultiProfile Studio từ trạng thái hiện tại.
Đọc artifacts/progress.md, implementation plan, git status và test report.
Đối soát bằng mã nguồn/thực tế, không tin checklist cũ nếu không có evidence.
Giữ nguyên mục tiêu FR-01…FR-16; hoàn tất gate đang làm trước gate kế tiếp.
Không tự mở lại browser/sync hoặc replay action UNKNOWN từ phiên cũ.
```

## Prompt review trước phát hành

```text
Review repo MultiProfile Studio theo qa/acceptance.csv và release checklist.
Ưu tiên lỗi profile isolation, no-direct-fallback, secret exposure,
duplicate effects, IME, stale document, process orphan và update rollback.
Đánh dấu test chưa chạy là NOT_RUN; đừng suy PASS từ code đọc được.
Đưa reproduction và sửa lỗi trong phạm vi repo; tạo report có evidence.
Không phát hành installer như production-ready khi P0 còn fail hoặc skipped.
```
