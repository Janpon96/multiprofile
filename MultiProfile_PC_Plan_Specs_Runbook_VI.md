# MultiProfile Studio PC — Plan, Specs & Runbook cho Antigravity

**Phiên bản:** 1.0 • **Ngày:** 29/10/2026 • **Ngôn ngữ:** Tiếng Việt  
**Trạng thái:** Hồ sơ thiết kế để triển khai; chưa có ứng dụng chạy, chưa có kết quả benchmark thực tế.  
**Nền tảng phát hành đầu tiên:** Windows 11 x64. Windows khác, macOS và Linux là các đích kiểm thử/phát hành riêng.

## 0. Quyết định sản phẩm và cách dùng tài liệu

Xây dựng ứng dụng PC quản lý nhiều phiên duyệt web độc lập: mỗi profile có dữ liệu riêng, proxy riêng, mở đồng thời và có thể nhận thao tác từ một cửa sổ điều khiển. Tên đề xuất: **MultiProfile Studio**. Trong giao diện dùng **Master / Follower**; Follower tương ứng Slave trong bản tham khảo.

Ba kết quả bắt buộc:

1. Người dùng tạo hoặc nhập profile, gán proxy có/không có xác thực và duyệt web qua tuyến proxy đã kiểm tra.
2. Mở nhiều cửa sổ Chromium cùng lúc, duy trì đăng nhập riêng sau khi đóng/mở app, quản lý tài nguyên và dừng đúng từng profile.
3. Chọn một Master và nhiều Follower; đồng bộ click, nhập chữ, cuộn, phím điều khiển và các lệnh mở trang được hỗ trợ; nhìn thấy kết quả từng profile, tạm dừng và xử lý lệch trạng thái.

**Không dùng tên “anti-detect” như cam kết kỹ thuật.** Cô lập dữ liệu không tạo ra máy tính hay danh tính phần cứng độc lập. Proxy, CDP và thay User-Agent không bảo đảm vượt hệ thống chống bot. Phạm vi này là quản lý profile, định tuyến mạng và tương tác đồng bộ có thể kiểm chứng. Các preset môi trường dùng cho tương thích/kiểm thử; không đặt mục tiêu né Cloudflare/Akamai, CAPTCHA hoặc cơ chế chống lạm dụng.

**Hồ sơ giao Antigravity:** đọc tài liệu này theo thứ tự Plan → Specs → Runbook; dùng `contracts/` làm hợp đồng dữ liệu tham chiếu, `qa/acceptance.csv` làm bảng nghiệm thu và `ANTIGRAVITY_START_HERE.md` làm prompt khởi động. Các file mẫu và mã kiểm tra trong kit không phải mã nguồn ứng dụng.

**Quy ước:** MUST = bắt buộc để nghiệm thu; SHOULD = mặc định khuyến nghị có thể thay bằng ADR; MAY = tùy chọn. Các ngưỡng hiệu năng và thời gian dưới đây là mục tiêu thiết kế, không phải kết quả đã đo. Nguồn [S01]–[S16] ở cuối tài liệu xác nhận cơ chế nền tảng; kiến trúc, chính sách và chỉ tiêu là đề xuất cho sản phẩm này.

## 1. Hiệu chỉnh các nhận định trong bản tham khảo

| Nhận định/ý tưởng | Kết luận dùng để triển khai |
|---|---|
| Mỗi profile chỉ là một tab hoặc context tạm | Chọn một persistent context và một cây tiến trình Chromium riêng cho mỗi profile, thư mục dữ liệu riêng; nhiều tab nằm bên trong profile đó. Không dùng chung thư mục giữa hai tiến trình. [S01] |
| Có thể dùng profile Chrome chính đang đăng nhập | App tạo thư mục riêng. Không đọc hoặc tái sử dụng thư mục Chrome cá nhân mặc định; Chrome đã thay đổi điều kiện remote debugging từ phiên bản 136. [S09] |
| `proxy.username/password` giải quyết mọi loại proxy | Playwright cung cấp trường xác thực cho HTTP(S); Chromium không hỗ trợ xác thực SOCKS5 trực tiếp. Chọn local forwarder có hỗ trợ upstream SOCKS5 auth và kiểm thử riêng. [S01][S02][S03][S11] |
| CDP Input tương đương chuột/phím vật lý ở OS | CDP gửi sự kiện qua trình duyệt. `isTrusted` phản ánh nguồn dispatch của user agent theo chuẩn DOM, không chứng minh có người điều khiển và không bảo đảm không bị phát hiện. [S04][S05] |
| Cùng viewport là pixel-perfect mọi website | Chỉ giảm một nguồn sai lệch; zoom, frame, font, trạng thái trang, scroll, nội dung động và canvas scaling vẫn ảnh hưởng. Bắt buộc kiểm tra layout và giới hạn vùng phát lại. |
| Jitter, offset và tốc độ gõ ngẫu nhiên bảo đảm tránh khóa | Không có bảo đảm đó. V1 dùng pacing có giới hạn để giảm tải và giữ thứ tự; offset mặc định 0. Random seed chỉ dành cho bài kiểm thử khả năng chịu lệch có thể tái lập. |
| JS Canvas Noise/WebGL spoof tạo fingerprint độc lập | Không coi là chức năng cốt lõi. V1 chỉ có preset được browser hỗ trợ: viewport, locale, timezone, color scheme; UA mặc định đi theo engine. Không monkey-patch Canvas/WebGL. |
| `gather()`/`create_task()` cho từng event là đủ | Chỉ thích hợp demo rất nhỏ. Sản phẩm cần thứ tự theo Follower, giới hạn queue, ACK, navigation barrier, dedup và xử lý trạng thái không biết thao tác đã xảy ra hay chưa. |
| Kiểm tra IP thành công là không rò mạng | Chỉ chứng minh đường đi của yêu cầu được kiểm tra. DNS, WebRTC, IPv6, UDP/QUIC, bypass localhost và lưu lượng nền phải kiểm thử riêng; không gọi proxy browser là VPN toàn hệ điều hành. [S03] |

## 2. PLAN — Phạm vi phát hành

### 2.1. Giả định mặc định

- PC cá nhân, dữ liệu lưu cục bộ, một người vận hành; không cần server cloud để quản lý profile.
- Cài Chromium do ứng dụng quản lý theo revision đã chốt; không phụ thuộc Chrome tự cập nhật của máy.
- Chuẩn nghiệm thu ban đầu: 10 profile hoạt động trên máy tham chiếu Windows 11 x64, CPU 8 logical cores, RAM 16 GB, SSD; 20 profile là bài stress trên máy 32 GB. Đây là cấu hình thử nghiệm đề xuất, không phải cam kết mọi website chạy được 10/20 profile.
- Mặc định tối đa 2 profile khởi động đồng thời, 1 tab thao tác/profile, tối đa 5 tab/profile; có cấu hình tăng khi đã đo tài nguyên.
- Website ngoài dùng Chromium bên ngoài Dashboard. Dashboard chỉ tải nội dung đóng gói của app.
- Không tự chia sẻ cookie, local storage, mật khẩu hay nội dung clipboard giữa các profile.

### 2.2. Ma trận chức năng và truy vết

| ID | Chức năng | Phiên bản | Tiêu chí đầu ra |
|---|---|---|---|
| FR-01 | Tạo/sửa/nhóm/tìm kiếm/import/export profile | V1 | ID bền vững, preview import, không đè dữ liệu ngầm |
| FR-02 | Cô lập và lưu phiên duyệt | V1 | Cookie, local storage, IndexedDB và service worker không dùng chung |
| FR-03 | Nhập proxy có/không auth; gán riêng/hàng loạt | V1 | HTTP, HTTPS upstream và SOCKS5 đi qua adapter đã kiểm thử |
| FR-04 | Proxy preflight, trạng thái tuyến, xử lý lỗi | V1 | Không tự đổi sang direct khi profile cấu hình required |
| FR-05 | Start/stop/restart nhiều profile | V1 | Giới hạn launch; kết quả từng profile; không ảnh hưởng Chrome cá nhân |
| FR-06 | Tạo nhóm sync, chọn Master/Follower | V1 | Một profile chỉ tham gia một nhóm sync hoạt động |
| FR-07 | Smart DOM và Coordinate Mode | V1 | Click, double-click, hover được chọn, scroll; không tự click tọa độ khi DOM lỗi |
| FR-08 | Nhập text/IME, sửa/xóa, phím điều khiển | V1 | Không nhân đôi ký tự; tiếng Việt/emoji; có báo không hỗ trợ |
| FR-09 | Navigation/tab/frame mapping | V1 cơ bản | Tab được chọn; same-origin iframe; barrier theo document; popup phức tạp/cross-origin frame ở V1.1 |
| FR-10 | ACK, thứ tự, backpressure, pause/resume, emergency stop | V1 | Không replay lại thao tác mơ hồ sau crash |
| FR-11 | Biến riêng theo profile, paste văn bản | V1 | Khóa `profile_id`, preview; không làm thay đổi clipboard OS hàng loạt |
| FR-12 | Chia lưới cửa sổ, chọn màn hình | V1 | Master đúng vị trí; xử lý DPI/viewport; không thu nhỏ mất vùng click |
| FR-13 | Preset môi trường duyệt | V1 | Cấu hình cố định; đổi cần restart; không quảng cáo fingerprint độc nhất |
| FR-14 | Backup/restore/update/recovery | V1 | Khôi phục profile đã dừng; kiểm tra version; không hạ revision bừa bãi |
| FR-15 | Diagnostics, metric, redaction | V1 | Có báo cáo điều tra; không chứa secrets/text nhập mặc định |
| FR-16 | Installer, dependency lock, license inventory | V1 | Máy sạch dùng được; runtime không tải browser không kiểm soát |
| FR-17 | Cross-origin iframe, multi-tab tự động, rich editor, drag nâng cao | V1.1 | Capability báo theo site/frame; fixture riêng trước khi bật |
| FR-18 | Điều khiển từ máy khác, remote API, scheduling | V2 | Không mở cổng điều khiển từ xa trong V1 |

V1 vẫn mở được website có frame/popup phức tạp bằng tay. Chỉ hành vi đồng bộ nằm ngoài capability sẽ tạm dừng và nêu lý do. Việc chạy nhiều profile không phụ thuộc bật sync.

### 2.3. UX bắt buộc

| Màn hình | Thành phần chính | Hành vi quan trọng |
|---|---|---|
| Profiles | Tên, nhóm, trạng thái, proxy, IP kiểm tra gần nhất, RAM, vai trò sync | Chọn nhiều; Open, Stop, Restart, Assign Proxy, Add to Sync, Tile |
| Proxy Pool | Scheme/host/port, auth mask, auth/connect/target status, thời điểm kiểm tra | Import preview, test riêng/batch, gán theo ID hoặc thứ tự đã preview |
| Profile Editor | General, Proxy, Browser Preset, Data, Variables | Thay proxy/viewport ở phiên đang mở thành pending; chỉ hiệu lực sau restart |
| Sync Center | Master, Follower, tab mapping, mode, route, pending/ACK | Arm → Start; Pause; Stop; badge từng follower và lý do lệch |
| Variable Preview | Bảng profile × biến; locator mục tiêu; giá trị mask | Chỉ gửi các hàng hợp lệ; không dồn hàng khi thiếu dữ liệu |
| Window Layout | Màn hình, grid, Master placement, actual viewport | Cảnh báo không đủ diện tích; dùng nhiều trang bố trí hoặc màn hình phụ |
| Diagnostics | Timeline metadata, queue depth, lỗi, version matrix | Export bản đã lọc; screenshots chỉ khi người vận hành chủ động yêu cầu |

Thanh sync hiển thị liên tục: **Master P001 → 4 Followers • DOM • RUNNING • 4/4 synchronized**. Màu vàng là đang chờ, đỏ là lỗi; không chỉ dùng màu, luôn kèm chữ và số. Có global hotkey dừng mặc định `Ctrl+Alt+Shift+S`, cho đổi nếu bị trùng; nút Stop luôn có trong Dashboard/tray.

Không hiển thị “Đã đồng bộ” khi chỉ mới đưa event vào queue. Hiển thị riêng `queued`, `dispatched`, `verified`, `blocked`, `unknown`.

### 2.4. Roadmap và điều kiện qua cổng

| Mốc | Hạng mục | Cổng nghiệm thu | Ước lượng công sức |
|---|---|---|---|
| G0 | Spike packaged worker/browser, auth proxy, capture, IME, DPI | Chạy 3 profile trên Windows thật; chốt version matrix và ADR; rủi ro có reproduction | 3–5 ngày công |
| G1 | Profile CRUD, persistence, secrets, lifecycle | FR-01/02/05; 20 vòng start/stop; không dùng chung data dir | 4–6 ngày công |
| G2 | Proxy pool/forwarder/preflight/import | FR-03/04; HTTP(S) auth và SOCKS5 auth/no-auth; tắt proxy không đi direct | 4–6 ngày công |
| G3 | Sync DOM/Coordinate/text cơ bản | FR-06/07/08/10; 1 Master + 4 Followers; IME và queue đúng | 7–10 ngày công |
| G4 | Tab/frame barrier, variables, tiling, UI | FR-09/11/12/13; mapping bền; DPI đa màn hình; import lỗi có preview | 5–7 ngày công |
| G5 | Crash recovery, backup, performance, installer | FR-14/15/16; matrix QA đầy đủ; soak; update/rollback có bằng chứng | 6–9 ngày công |

Tổng tham chiếu: 29–43 ngày công kỹ thuật, cộng thời gian QA và dự phòng theo kết quả G0. Không diễn giải là cam kết ngày phát hành; prototype một buổi tối chỉ chứng minh ý tưởng. Không qua cổng bằng mock/demo nếu tiêu chí yêu cầu browser thật. V1.1 là backlog riêng, không âm thầm gộp vào cam kết V1.

## 3. SPECS — Kiến trúc được chọn

### 3.1. Tech stack

| Lớp | Chọn | Lý do và ràng buộc |
|---|---|---|
| Desktop | Electron + TypeScript + React | Một ngôn ngữ xuyên suốt; UI native shell; renderer không có Node integration |
| Controller | Electron main + domain services | Quản lý DB, secrets, lifecycle, commands; không chạy công việc nặng trên UI loop |
| Profile worker | `utilityProcess` riêng/profile | Sở hữu Chromium, capture, executor, proxy forwarder; crash được cô lập [S14] |
| Browser | Playwright + Chromium revision được pin | `launchPersistentContext`; headed windows; dùng API cao cấp cho DOM, CDP cho capture/input đặc thù |
| Proxy relay | Adapter bọc thư viện `proxy-chain` được pin | Một listener loopback/profile; hỗ trợ upstream auth; không tự viết SOCKS parser [S11] |
| Metadata | SQLite, migrations, một writer | Transaction ngắn; bảng config tách runtime; không đồng bộ DB qua folder cloud |
| Secrets | OS-backed SecretStore adapter | Windows DPAPI thông qua API tương thích của Electron; không lưu plain text trong DB |
| IPC | MessagePort/typed IPC | Không cần HTTP/WebSocket server control; validate schema và sender |
| Native helper | Windows Job Object và window adapter nếu cần | Chỉ helper đóng gói, ký và kiểm thử; không shell-exec chuỗi từ trang web |
| Test | Unit + integration + browser fixtures + Windows packaging E2E | Có proxy giả lập lỗi và website kiểm thử do team kiểm soát |

Không trộn Python/FastAPI vào V1 trừ khi repo có sẵn nền tảng bắt buộc; khi đó phải viết ADR cập nhật toàn bộ lifecycle/IPC/runbook. Không xây nhân Chromium tùy chỉnh trong V1.

### 3.2. Sơ đồ sở hữu và luồng

```mermaid
flowchart TD
  UI["Dashboard và tray"] --> CORE["Controller: profiles, lifecycle, sync"]
  CORE --> DB["SQLite và SecretStore"]
  CORE --> MASTER["Worker Master"]
  CORE --> FOLLOW["Các worker Follower"]
  MASTER --> CAP["Chromium: capture trong trang"]
  CAP --> CORE
  FOLLOW --> EXEC["Chromium: DOM hoặc CDP replay"]
  MASTER --> RELAY["Relay loopback riêng mỗi profile"]
  FOLLOW --> RELAY
  RELAY --> UP["Upstream proxy được gán"]
  UP --> WEB["Website"]
```

Relay trong sơ đồ là một loại thành phần, không phải một proxy cấu hình dùng chung. Mỗi worker có listener, token và upstream assignment riêng.

**Luồng launch:** DB snapshot → lock profile → mở relay → kiểm tra tuyến → launch browser trắng → gắn hooks → browser preflight → mở start URL → READY. Config snapshot có revision; sửa UI trong lúc launch không làm thay đổi nửa chừng cấu hình đang dùng.

**Luồng sync:** Capture từ Master → xác minh nguồn/document → canonical action → sequence của controller → FIFO từng Follower → resolve/precondition → dispatch → postcondition/ACK → trạng thái UI. Fan-out song song giữa các Follower; tuần tự bên trong mỗi Follower.

### 3.3. Ranh giới tin cậy

Website là dữ liệu không tin cậy. Trang không được gọi shell, đọc filesystem, nhận secrets proxy, truy cập DB hoặc chọn profile đích. Capture chỉ phát sự kiện trang trong nhóm đang được người vận hành bật; controller quyết định người nhận và quyền thực thi.

Electron renderer MUST dùng `nodeIntegration:false`, `contextIsolation:true`, sandbox; CSP chặt, chỉ assets nội bộ; preload chỉ expose API typed nhỏ. Validate IPC sender và payload ở main. Không nhúng website ngoài vào renderer có đặc quyền. [S06]

CDP do worker nắm qua transport nội bộ. Không publish websocket endpoint/debug port ra LAN; không cung cấp endpoint điều khiển công khai. Nếu công cụ debug phát triển cần port, chỉ loopback, tạm thời và tắt trong bản release; không ghi URL debug có token vào log.

## 4. Profile lifecycle, lưu trữ và tài nguyên

### 4.1. Dữ liệu trên Windows

`%LOCALAPPDATA%/MultiProfileStudio/` là root do app quản lý. Metadata ở `state/app.sqlite`; user data ở `profiles/<uuid>/browser-data/`; downloads ở `profiles/<uuid>/downloads/`; log metadata ở `logs/`; browser binary versioned ở `engines/<revision>/`. Không đặt secret trong tên thư mục hoặc command line.

Profile ID là UUID, tên hiển thị được đổi độc lập. Path được tạo từ root + UUID do app cấp; import không được tự chỉ `userDataDir`. Reject traversal, UNC path và symlink/reparse point thoát root. Hai profile không cùng canonical path. Bảo vệ thư mục bằng quyền user hiện tại; dữ liệu phiên trình duyệt vẫn nhạy cảm dù secret proxy được mã hóa.

Duplicate profile mặc định **chỉ sao chép cấu hình**, tạo UUID mới, browser-data rỗng, không sao chép cookie/login. Backup phục hồi là chức năng khác. Xóa profile yêu cầu đã dừng; trước tiên chuyển vào trash có hạn giữ 7 ngày, xóa vĩnh viễn là hành động riêng.

### 4.2. State machine

| State | Vào khi | Ra khi / xử lý |
|---|---|---|
| STOPPED | Chưa chạy hoặc đã đóng hoàn tất | Start → VALIDATING |
| VALIDATING | Kiểm tra config, lock, version, capacity, secrets | Hợp lệ → STARTING; không → ERROR |
| STARTING | Relay + Chromium đang khởi tạo | Preflight đạt → READY; timeout/lỗi → STOPPING → ERROR |
| READY | Browser sống và preflight đạt | Stop → STOPPING; proxy/network lỗi → DEGRADED; crash → ERROR |
| DEGRADED | Tuyến lỗi hoặc browser không đáp ứng | Pause sync; phục hồi qua explicit retry/restart; không tự resume |
| STOPPING | Đã ngắt nguồn capture và queue | Context close + tree exit + relay close + unlock → STOPPED/ERROR |
| ERROR | Có mã lỗi và cleanup đã được xác minh | Retry từ VALIDATING; lỗi chưa cleanup chặn mở lại |

Sync state độc lập với lifecycle: profile READY có thể đang không tham gia nhóm. Không lưu state RUNNING trong config như bằng chứng tiến trình còn sống sau restart app.

### 4.3. Lock và crash

- Controller giữ một launch mutex theo UUID và lock OS/exclusive file handle suốt vòng đời. PID + birth time + executable path + session nonce là metadata đối soát, không dùng mỗi PID để giết tiến trình.
- Không xóa `SingletonLock`/lock Chromium chỉ vì UI nghĩ profile đã dừng. Kiểm tra chủ sở hữu và process tree trước.
- Stop: khóa capture mới → pause group nếu là Master → hủy queued actions chưa dispatch → release keys/pointer tốt nhất có thể → đóng context → đợi tối đa 10 giây → terminate đúng job/process tree của app nếu cần → đóng relay → nhả lock.
- Windows Job Object với kill-on-close bảo vệ orphan; helper phải chứng minh browser descendants vào job, không thừa kế handle ngoài ý muốn và tương thích sandbox Chromium. [S15] Nếu chưa chứng minh được, G5 chưa đạt; startup reconciliation vẫn cần.
- Sau crash: mọi action đang dispatch mà thiếu ACK thành `UNKNOWN`; không tự phát lại. Không tự start lại toàn bộ browser và resume sync. Dashboard cho chọn recovery từng profile.

### 4.4. Capacity

Admission check trước khi start: số slot, bộ nhớ khả dụng, dung lượng đĩa, phiên đang shutdown. Ngưỡng đề xuất: không launch thêm nếu RAM khả dụng <2 GB hoặc <15%, disk root <2 GB; UI cho thấy lý do. Đây là cấu hình sản phẩm có thể chỉnh sau benchmark.

Không tự kill profile để cứu RAM. Giảm refresh metrics/thumbnail, dừng launch mới, đề xuất người dùng đóng bớt. Minimized windows có thể bị throttling hoặc rendering khác; mặc định không minimize Follower đang sync. Tải video/webgame nặng được đo riêng.

## 5. Proxy — nhập, phân phối, xác thực, định tuyến

### 5.1. Capability matrix

| Upstream | Auth V1 | Đường triển khai | Điều kiện |
|---|---|---|---|
| HTTP | None / Basic user-pass | Chromium → local HTTP relay → upstream | Kiểm thử HTTP, CONNECT HTTPS, WS/WSS |
| HTTPS proxy | None / Basic user-pass | Local relay → TLS đến upstream | Kiểm tra certificate upstream; không disable TLS verification |
| SOCKS5 | None / username-password | Local HTTP relay → SOCKS5 upstream | Remote target DNS phải có bằng chứng ở adapter đã pin |
| SOCKS4/4a, PAC, NTLM/Kerberos | Ngoài V1 | Reject với mã UNSUPPORTED_PROXY | Không nhận xong rồi thất bại âm thầm |
| Direct | Không có | Không relay | Chỉ profile được chọn direct rõ ràng; không phải fallback khi proxy lỗi |

Chọn **mọi profile dùng proxy đều qua relay** để thống nhất lifecycle và thống kê. API proxy của Playwright dùng cho kết nối tới relay loopback kèm credential ngẫu nhiên theo phiên. Đây là lựa chọn thiết kế; Playwright trực tiếp HTTP proxy vẫn là phương án kỹ thuật hợp lệ nhưng không trộn hai đường trong V1.

Relay MUST bind `127.0.0.1`, port do OS cấp; không dùng `0.0.0.0`, không chọn cố định 10001 rồi hy vọng trống. Token loopback khác giữa các profile, chỉ giữ trong RAM. Token chống sử dụng nhầm listener, không bảo vệ khỏi malware cùng tài khoản OS có khả năng đọc bộ nhớ.

`proxy-chain` có chế độ direct nếu upstream để trống. Adapter MUST kiểm tra upstream đầy đủ trước khi mở listener và từ chối mọi request khi assignment không còn hợp lệ; tuyệt đối không trả upstream `null/undefined` cho một profile required. Theo dõi và đóng cả tunnel/socket đang tồn tại khi relay bị revoke. Tắt verbose logs của thư viện; wrapper lọc URL userinfo và headers. [S11]

### 5.2. Import contract

Hỗ trợ paste từng dòng, CSV UTF-8 và JSON. XLSX là tiện ích V1.1; V1 cho lưu Excel thành CSV UTF-8. Không dùng split bằng dấu `:` cho tất cả trường hợp.

| Định dạng | Ví dụ minh họa | Quy tắc |
|---|---|---|
| URI không auth | `http://proxy.example:8080` | Scheme bắt buộc ở canonical form |
| URI có auth | `socks5://demo_user:demo_pass@proxy.example:1080` | User/pass chứa ký tự đặc biệt phải percent-encode; decode đúng một lần |
| IPv6 | `http://[2001:db8::10]:8080` | Brackets bắt buộc |
| Legacy | `host:port:user:pass` | Chỉ IPv4/hostname và bốn trường không có dấu `:` nội bộ; trường hợp mơ hồ yêu cầu URI/CSV |
| CSV | `proxy_id,label,scheme,host,port,username,password` | Header rõ, trường có dấu phẩy đặt trong quotes |
| JSON | Object theo schema import | Reject unknown fields và secretRef do file tự cấp |

Giới hạn mặc định: 5 MB/import, 5.000 dòng, mỗi field 4 KB; validate port 1–65535, ID, host, scheme, duplicate ID, encoding. File lỗi hiển thị số dòng và lý do đã mask, không echo nguyên dòng có mật khẩu. Không tự truy cập hostname trong bước parse.

Hai pha **Preview → Commit**: preview phân loại create/update/skip/error, gán UUID/ID ổn định cho kết quả; commit dùng preview token + content digest + DB revision để ngăn ghi khác preview. Mặc định all-or-nothing; người dùng có thể chọn “chỉ dòng hợp lệ” và xem danh sách cụ thể trước commit. Đổi auth secret giữ secret cũ cho tới khi commit thành công; dọn secret mới mồ côi sau rollback. Metadata commit trong transaction.

Mật khẩu chỉ đi từ form/import vào SecretStore. Metadata và export mặc định chỉ có `secret_ref`, không có password. Không tự xóa file import gốc của người dùng; nhắc gọn trong UI rằng file họ nhập có thể còn chứa credentials.

### 5.3. Assignment

- Mapping theo `profile_id → proxy_id`, không theo index bảng UI.
- Auto-assign theo thứ tự đã preview, giữ bền sau khi sort/filter. Policy `unique` mặc định trong thao tác auto-assign; muốn dùng chung proxy phải chọn `shared`.
- `unique` nghĩa không dùng lại proxy record; hai record vẫn có thể cùng egress IP. UI tách cảnh báo IP trùng khỏi policy gán record.
- IP có thể xoay do provider dù giữ nguyên host/user; hiển thị thời điểm kiểm tra và sticky session do provider nếu có, không hứa pin IP.
- Đổi proxy hoặc rotate auth cần pause, close browser, áp dụng config revision mới, preflight rồi mở lại. Không đổi relay upstream dưới các connection đang sống.

### 5.4. Preflight và health

1. Parse config và lấy secret; lỗi local → không mở browser.
2. Khởi tạo relay + kiểm tra upstream connect/auth; timeout tổng 15 giây, tối đa 1 retry có backoff cho lỗi tạm thời.
3. Dùng request thực sự qua tuyến relay để gọi endpoint HTTPS echo do team tự host hoặc người vận hành cấu hình. Response cần IP, timestamp, nonce trả về; TLS phải hợp lệ. Không cấu hình sẵn một dịch vụ IP bên thứ ba không được công bố.
4. Khởi chạy Chromium ở trang trắng, dùng browser navigation tới endpoint kiểm tra, đối chiếu tuyến/nonce và egress expectation nếu có. Kiểm tra bằng Node direct không thay được bước browser.
5. Chỉ mở start URL khi preflight đạt hoặc profile direct đã được cấu hình. Không đạt → DEGRADED/ERROR, không bật sync.

Trạng thái tách rõ `UNKNOWN`, `CHECKING`, `READY`, `AUTH_FAILED`, `UNREACHABLE`, `TLS_FAILED`, `TARGET_BLOCKED`, `EGRESS_MISMATCH`, `CHECK_INCONCLUSIVE`. Target trả 403 không tự kết luận proxy chết hoặc tự chuyển tài khoản/proxy. Nếu endpoint kiểm tra hỏng, báo chưa xác minh được; không báo “Live” dựa riêng TCP handshake.

Health check trong phiên mặc định theo yêu cầu; tùy chọn 5 phút/lần để tránh gửi traffic thừa. Health của website hiện tại lấy từ network events, không chạy fetch trực tiếp bỏ qua proxy. Mất relay/upstream: pause profile trong sync, chặn queue, đóng relay tunnels khi cần; không đổi sang đường direct.

### 5.5. Phạm vi mạng và khả năng rò

`required` là **chính sách không fallback của đường proxy URL trong app**, không phải firewall toàn hệ thống. Với V1 chưa có Windows Filtering Platform/VPN, không được ghi “không rò IP/DNS 100%”.

Bài kiểm thử bắt buộc: HTTP(S), WS/WSS, DNS target, DNS upstream host, IPv4/IPv6, WebRTC, QUIC/HTTP3, request service worker, localhost bypass và browser background traffic. Địa chỉ upstream phải được phân giải để kết nối; tách nó khỏi DNS của target. Proxy TCP không bảo đảm chuyển UDP; Chromium SOCKS5 không relay UDP. [S03]

Preset mạng V1 tắt tính năng UDP không cần cho bài sync khi được engine hỗ trợ và đã kiểm thử; WebRTC có thể bị hạn chế, phải báo website gọi video có thể không hoạt động. Bất kỳ flag/policy nào cũng ghi trong version matrix và không thay bằng `ignoreHTTPSErrors`/tắt sandbox. Native bypass tới loopback là ca kiểm thử riêng; V1 không hứa định tuyến các địa chỉ nội bộ qua proxy. Nhu cầu cách ly toàn lưu lượng cần milestone riêng cho enforcement OS/network namespace, không được giải quyết bằng vài cờ browser rồi coi hoàn tất.

## 6. Sync — nguồn sự kiện, hợp đồng và thứ tự

### 6.1. Session contract

Mỗi session có UUID, Master profile/tab, danh sách Follower profile/tab, `mode`, `epoch`, danh sách origin/route được phép sync, policy lỗi và revision config. Một profile chỉ giữ một vai trò trong một session hoạt động. Profile browser có thể có nhiều tab nhưng V1 chỉ đồng bộ một logical tab được map rõ trong session.

`DRAFT → ARMING → RUNNING ↔ PAUSED → STOPPING → STOPPED`. ARMING kiểm tra browser READY, route/tab mapping, capabilities, viewport với coordinate, follower queue rỗng. Bất kỳ thay Master/mode/membership nào chỉ làm khi PAUSED, tăng epoch, bỏ queue cũ và arm lại. Chỉ thao tác trong tab Master được chọn mới được capture; tab khác dùng bình thường.

Default policy `strict`: lỗi một Follower làm pause cả nhóm để người vận hành xem trạng thái. Có tùy chọn `continueHealthy`: tách Follower lỗi ra, các Follower khỏe tiếp tục; UI luôn hiện số lượng bị loại. Đây không phải transaction nhiều trình duyệt; thao tác đã xảy ra ở một số nơi không được undo tự động.

### 6.2. Capture implementation

V1 release dùng isolated world của CDP, `Page.addScriptToEvaluateOnNewDocument` với worldName + `Runtime.addBinding` giới hạn execution context name. Worker map executionContext với page/frame thực qua CDP và gắn session/document generation từ registry của worker; không tin profileId, origin hoặc seq do JS trong trang tự khai. [S12][S13]

`exposeBinding` của Playwright cung cấp source page/frame và hữu ích cho prototype. Tuy nhiên binding được expose trên window và payload vẫn không tin cậy; không đưa bridge gọi đặc quyền vào main world của website. [S07] Isolated world giảm khả năng trang gọi trực tiếp binding; DOM đích vẫn do trang kiểm soát nên phải validate mỗi action. Không dùng `isTrusted` làm cơ chế xác thực duy nhất.

Hook cài cho document mới và document hiện hữu; cài idempotent, detach khi stop. Hook có capture-phase listener, theo dõi `pointerdown/up/move`, click/double-click, `beforeinput/input`, `compositionstart/update/end`, `keydown/up`, `scroll`, focus/blur. Chỉ emit canonical action theo mode; không broadcast mọi raw event cùng lúc. Existing frame, navigation, back-forward cache restore, source blur, mất context đều có lifecycle riêng.

Nguồn của event là `(workerChannel, browserGeneration, pageId, frameId, executionContextId, documentToken)`. Payload tối đa 64 KB; giới hạn rate để trang độc hại không làm đầy bộ nhớ. Validation không cho event yêu cầu eval string, đường dẫn file hoặc HTTP request tùy ý từ controller.

### 6.3. Canonical envelope

| Field | Ý nghĩa |
|---|---|
| `schema_version` | Phiên bản schema; reject version không hỗ trợ |
| `session_id`, `epoch` | Nhóm sync và thế hệ phiên; event thế hệ cũ bị bỏ |
| `event_id`, `seq` | UUID và sequence tăng do controller cấp sau canonicalization |
| `source_profile_id`, `logical_tab_id`, `frame_path` | Định danh nguồn đã xác minh; frame path có owner locator |
| `route_key`, `route_generation`, `source_document_token` | Route logic; thế hệ barrier; document của Master, không copy để so trực tiếp với document Follower |
| `type`, `target`, `payload` | Action được phép và dữ liệu tối thiểu |
| `created_at`, `ttl_ms`, `trace_id` | Audit time, thời hạn, liên kết telemetry; latency đo bằng monotonic time trong controller |

Mỗi delivery được worker đích bổ sung `expected_document_token` của chính Follower từ mapping hiện tại. Document token giữa các browser luôn khác; kiểm tra generation/route rồi dùng local token, không yêu cầu token Master = token Follower.

Metadata ledger chỉ giữ ID/type/seq/status/timing/error code. Text nhập, giá trị biến, locator chứa thông tin cá nhân và query URL không ghi vào ledger mặc định; raw payload tồn tại trong bộ nhớ có hạn và bị hủy khi kết thúc.

### 6.4. Event taxonomy và chống nhân đôi

| Loại | Capture | Replay và quy tắc |
|---|---|---|
| `dom.click` | Một logical activation | Locator click đúng một lần; không replay thêm mousedown/up của cùng action |
| `dom.double_click` | Hai click trong một cụm | Collector trì hoãn click đơn theo ngưỡng hệ thống/cấu hình được đo; double-click thay cụm đó, không cộng thêm click; nếu site không tương thích, chuyển coordinate gesture |
| `pointer.gesture` | Down → moves → up | Một stream có button/modifiers và thời gian tương đối; không thêm `click()` cuối |
| `text.patch` | Sửa text sau composition commit | Patch range/selection trên input thường; kiểm tra precondition; không replay printable keydown đồng thời |
| `key.command` | Tab, Escape, Enter, Arrow và shortcut được hỗ trợ | Focus target xác minh; keys down/up cân bằng; hành động submit áp dụng policy đã chọn |
| `key.raw` | Keydown/keyup trong Coordinate Mode, vùng canvas không editable | Giữ `key`, `code`, phase, repeat và modifiers; cho phép giữ phím; không đồng thời tạo text.patch hoặc key.command |
| `scroll.set` | Scroll container sau cập nhật | DOM scroll ratio/top theo container tương ứng; không đồng thời replay wheel gây cuộn hai lần |
| `scroll.wheel` | Wheel trong coordinate/canvas | Delta chuẩn hóa theo deltaMode; dùng input wheel; không bổ sung scroll.set |
| `navigate` | Lệnh Open URL/Reload/Back/Forward của Dashboard | Barrier; không phát lại navigation event phát sinh từ click đã replay |
| `variable.fill` | Lệnh từ Dashboard/hotkey đã đăng ký | Lookup theo profile ID; preview map; fill target và verify |
| `control.release` | Blur/pause/stop/recovery | Release mọi phím/nút đang giữ; không coi là hành động nghiệp vụ |

Trong DOM mode, hover menu là `pointer.gesture`/hover adapter opt-in cho site fixture, không tự phát chuột 120 Hz. Khả năng double-click chậm do cần phân biệt click đơn là tradeoff công khai; V1 có thể cho chọn “single-click immediate, double-click unsupported” ở site không cần double-click, nhưng UI phải ghi đúng capability.

Pending single-click phải được giữ ở controller, không chỉ trong document có thể bị unload. Nếu Master điều hướng trước khi hết cửa sổ nhận diện double-click, controller flush click đơn với causal ID trước khi xử lý barrier; không để mất click do hook bị hủy. Site có semantics click/double-click không tương thích collector chuyển sang Coordinate gesture đã kiểm thử. `key.raw` chỉ hoạt động ngoài field nhập liệu; focus chuyển vào field sẽ release phím đang giữ và chuyển sang text canonicalization, tránh phát chữ hai lần.

### 6.5. Queue, ordering, ACK và dedup

- Một FIFO cho mỗi Follower, một executor đang dispatch tại một thời điểm; fan-out giữa Follower chạy độc lập. Không tạo task không giới hạn cho từng mousemove.
- Mỗi event có delivery set tại thời điểm nhận; thêm Follower sau đó không nhận backlog cũ.
- Queue cap đề xuất 200 logical actions/Follower hoặc 2 giây tuổi queue (điều kiện nào đến trước). Vượt ngưỡng → PAUSED/BACKPRESSURE; không âm thầm bỏ click, text, keyup hoặc terminal gesture.
- Coalesce chỉ hover/mousemove chưa dispatch liên tiếp trong cùng gesture và không vượt qua down/up/key/text/navigation barrier. Drag giữ đủ đường đi được lấy mẫu và terminal events; khi thiếu buffer, abort gesture và pause, không lặng lẽ cắt đường.
- Sequence đánh số sau coalescing; FIFO được kiểm tra bằng seq. Nếu cần coalesce trong delivery queue thì lưu danh sách seq bị superseded và ACK tương ứng; V1 ưu tiên chỉ coalesce trước khi cấp seq để đơn giản hóa.
- ACK: `RECEIVED → DISPATCHING → APPLIED` hoặc `SKIPPED / BLOCKED / FAILED / UNKNOWN`. `APPLIED` nghĩa browser adapter hoàn thành; `verification` riêng là `matched / unverified / mismatched`. Không gọi APPLIED là server đã chấp nhận giao dịch.
- Dedup key `(session_id, epoch, event_id, follower_id)` có unique constraint. Duplicate terminal → trả status cũ. Record DISPATCHING mà kết nối mất → UNKNOWN, không retry.
- Timeout mặc định resolve 3 giây, action 5 giây, navigation 15 giây; timeout task không bảo đảm API underlying đã bị hủy. Phải cancel bằng khả năng thực tế của engine hoặc freeze/close target và mark UNKNOWN, rồi mới xử lý tiếp.
- Retry tự động chỉ khi chứng minh chưa dispatch: locator chưa sẵn sàng, worker chưa nhận, lookup thất bại trước effect. Click/submit đã dispatch mà timeout không được tự click lại.
- Sau crash/restart không cố cung cấp exactly-once: browser và ledger DB không có transaction chung. Chính sách là không tự replay effect chưa biết; giữ trạng thái để người vận hành đối soát.

### 6.6. Pause và Stop

Pause chặn capture/action mới, bỏ pending actions theo policy và release input; không rollback tác động đã xảy ra. Với event đang dispatch, đợi tối đa action deadline và phân loại, không tuyên bố stop có thể thu hồi network request đã gửi. Emergency Stop ưu tiên cắt dispatcher/disable capture, đóng context khi không hủy được thao tác; mục tiêu ngừng gửi lệnh mới dưới 250 ms tại controller khi không bị treo OS.

Resume cần arm lại: kiểm tra tab/route, giải phóng stuck keys, baseline field/scroll mới, tăng epoch để event tồn đọng bị reject. Không “tiếp tục từ click lỗi” nếu chưa xác định ảnh hưởng. Khi Master đổi focus sang tab ngoài nhóm, status `MASTER_OUTSIDE_SELECTED_TAB`; không capture từ tab khác tự động.

## 7. Smart DOM, tọa độ, nhập liệu và navigation

### 7.1. Smart DOM resolver

Target descriptor gồm route/frame path, candidate selectors, element kind và optional container context. Ưu tiên: site adapter test-id được chọn → role + accessible name chính xác → stable id/name → label → CSS đã escape. XPath sâu/index DOM và text mơ hồ là fallback chỉ khi unique, không phải mặc định.

Resolver trên từng Follower phải trả đúng một phần tử, đúng loại, visible, enabled, ổn định và nhận pointer. Locator auto-wait hữu ích cho các kiểm tra này, nhưng không chứng minh nút có cùng ý nghĩa nghiệp vụ ở mọi tài khoản. [S10] Profile-specific text không dùng làm identifier chung; cấu hình adapter theo role/container. Không `force:true` để vượt timeout.

Zero matches → TARGET_NOT_FOUND; nhiều matches → TARGET_AMBIGUOUS; overlay → TARGET_OCCLUDED; route lệch → ROUTE_MISMATCH. Tất cả chặn action. Hybrid nghĩa **có hai mode và lựa chọn rõ**, không phải DOM thất bại thì tự click tọa độ. Chuyển mode phải PAUSED và arm lại.

### 7.2. Coordinate Mode

Dùng tọa độ **CSS pixels của viewport trang**, không dùng desktop screen pixels. Nguồn lấy `clientX/clientY`, kích thước content viewport, scroll/layout/zoom, frame/canvas rectangle. Tọa độ gửi CDP liên hệ viewport top-level; iframe phải map qua geometry thực, không dùng nguyên clientX của frame con.

Với target rectangle ổn định:

`u = (x_master - left_master) / width_master`  
`v = (y_master - top_master) / height_master`  
`x_follower = left_follower + u * width_follower`  
`y_follower = top_follower + v * height_follower`

Kiểm tra `0 ≤ u,v ≤ 1`, target còn tồn tại, route/layout/scroll tương thích. Với trang thường, target rectangle là content viewport; với canvas là bounds của canvas. Canvas backing-store pixels và devicePixelRatio không đồng nhất CSS pixels. Zoom mặc định 100%; thay zoom/DPI/resize khi sync đang chạy → pause, remeasure và arm. Không nhân DPR thêm một lần theo phỏng đoán.

Không gọi chế độ này pixel-perfect nếu chỉ dùng tỷ lệ. Website responsive khác breakpoint hoặc layout thay đổi → require align viewport hoặc từ chối action. Với transformed/cross-origin iframe chưa có adapter, báo unsupported thay vì ước lượng tọa độ.

### 7.3. Text, tiếng Việt và IME

DOM text V1 hỗ trợ `input` text/search/email/url/tel và `textarea` không nhạy cảm. Password, OTP, payment, file input không capture nội dung; có thể gõ riêng từng profile. Browser không thể nhận diện hết dữ liệu nhạy cảm theo HTML type: site adapter/operator có danh sách field loại trừ, mặc định không log bất kỳ text nào.

Trong composition, không replay từng key vật lý. Chờ composition hoàn tất và `input` cuối được hợp nhất; tạo đúng một patch. Dùng beforeinput/selection snapshot và value sau commit để tính replaced range + inserted Unicode text; tính index đúng UTF-16 DOM selection, tránh cắt surrogate pair/grapheme. Controller/worker giữ baseline trong RAM, không persist giá trị field.

Precondition là field Follower còn đúng baseline đã ghép cho profile đó và selection hợp lệ. Nếu baseline khác vì user gõ tay hoặc site sửa input, pause với TEXT_BASELINE_MISMATCH; không overwrite cả field âm thầm. Patch insert dùng selection range + input adapter đã kiểm thử; `insertText` hỗ trợ văn bản IME nhưng không mô phỏng nguyên chuỗi native IME. [S04]

`Backspace/Delete`, replacement selection, Enter newline và Undo/Redo trong field text được canonicalize theo kết quả input nếu có; không đồng thời gửi key.command tạo effect trùng. Enter submit/Tab/Escape là command khi không thuộc text mutation. Chọn radio/checkbox/select dùng semantic state change được kiểm thử, không chỉ paste text.

Rich editor/contenteditable phức tạp và native IME composition fidelity là V1.1 adapter riêng. Nếu chưa hỗ trợ, pause tại field đó, không gửi một nửa từ. Ví dụ nghiệm thu: `Tôi đang thử đồng bộ tiếng Việt — ă â ê ô ơ ư đ 👩🏽‍💻`; chọn đoạn giữa, thay thế, undo, paste nhiều dòng; cuối cùng mọi field cùng giá trị mong đợi và không lặp ký tự.

### 7.4. Clipboard và biến riêng

V1 hỗ trợ text paste vào field thường theo kết quả input; không capture clipboard toàn OS nền, ảnh/binary paste không hỗ trợ. Không broadcast `Ctrl+V` để mỗi Follower tự đọc cùng clipboard máy. Thao tác “Fill variable” từ Dashboard/hotkey lấy dữ liệu riêng theo `profile_id` và target descriptor đang chọn.

CSV biến có cột `profile_id`, các field đã khai báo trong dataset; JSON dùng mapping tương đương. Duplicate ID, field thiếu, profile ngoài nhóm, biến chưa khai báo → preview lỗi. Không tự dịch hàng khi thiếu. Nội dung `{{email}}` là tên biến đơn giản trong allowlist; không template expression/eval/JS. Excel formula khi export CSV phải được escape để không thực thi khi mở bảng tính.

Biến sensitive lưu encrypted, UI mask; non-sensitive cũng có thời hạn giữ do người dùng chọn. Có per-profile value preview; nhấn Apply gửi một command plan cho tất cả target đã xác minh. Nếu một Follower thiếu biến, mặc định block cả lệnh trước dispatch; policy skip chỉ khi operator chọn và thấy danh sách. Hotkey mặc định không dùng Alt+1 vì dễ đụng shortcut browser; cho người dùng gán và kiểm tra conflict.

### 7.5. Navigation, route và tab/frame mapping

**Đồng bộ không đồng nghĩa copy URL sau mỗi click.** Click đã phát lại có thể tự điều hướng ở từng Follower, với token/query riêng. Navigation quan sát dùng để mở barrier và xác minh trạng thái; không đồng thời phát thêm goto URL Master.

Lệnh Open URL từ Dashboard chỉ chấp nhận `https:`/`http:` đã chuẩn hóa; không nhận javascript/data/file/custom protocol. Back/Forward/Reload phát lệnh mỗi tab rồi chờ route expected; history depth khác nhau là mismatch. Nhập URL ở address bar native không được JS trang capture; app có thể quan sát navigation rồi đề nghị lệnh Open URL, không tự copy URL chứa OAuth code/session token sang profile khác.

Route policy V1 do người dùng chọn origin + path chính xác hoặc prefix đơn giản; query mặc định bỏ qua để không copy token. Site cần phân biệt query thì khai báo tên tham số có ý nghĩa, loại query chứa auth code. URL identity và origin chỉ lấy từ browser metadata. `route_generation` tăng sau mỗi navigation barrier; các Follower được map vào thế hệ mới khi readiness predicate đạt.

Readiness gồm document mới tồn tại, DOMContentLoaded nếu cần, đúng route và sentinel/target cần thiết visible; không dùng networkidle toàn cục trên site có long-poll. Chờ tối đa 15 giây, báo follower chậm; Master vẫn có thể tiến trước, nhưng actions vượt barrier bị chặn/hủy, không phát sang document cũ.

Popup sinh từ click đã replay được map theo opener + triggering event + origin expectation khi duy nhất; không tạo thêm popup thủ công. Nếu ambiguous, chặn đồng bộ popup và yêu cầu map tab trong Dashboard. V1 tab switch do người dùng chọn; đóng tab Master làm pause nhóm, không tự đóng tất cả tab ngoài nhóm. Đồng bộ thao tác tab qua Dashboard chỉ áp dụng logical tab được map.

Same-origin iframe: lưu owner locator chain, xác minh frame origin/document và geometry. Shadow DOM mở: resolver theo cây phù hợp; closed shadow không bảo đảm hỗ trợ. Cross-origin/OOPIF, canvas transform phức tạp và native context menu/file picker là capability riêng V1.1; không giả định top-page init script đã bao phủ. JS dialog phải có state rõ; không auto-accept vô điều kiện. Download có folder riêng/profile; upload cần file người dùng chọn cho profile tương ứng, không sao chép lựa chọn OS dialog ngầm.

## 8. Tiling, browser presets và pacing

Tiling làm việc trên work area từng màn hình, loại taskbar, hỗ trợ origin màn hình âm và scale 100/125/150/200%. Adapter xác nhận đơn vị Windows logical/physical pixels với CDP window bounds trong G0; không dùng cùng một tọa độ OS cho CSS page. Đưa window về normal trước khi set bounds; đo lại actual viewport sau khi áp dụng.

Grid có thể là 2×2, 3×3 hoặc custom. Công thức tile lấy work area trừ margins/gap chia số cột/hàng; thứ tự bền theo group, Master ở ô đầu hoặc màn hình đã chọn. Tách outer window size khỏi viewport vì title/tab/address bars chiếm diện tích.

**Nếu grid không đủ chỗ cho viewport yêu cầu, không thu cửa sổ âm thầm rồi vẫn gửi click.** Đưa ra ít cột hơn, chia nhiều trang bố trí hoặc dùng màn hình phụ. Ví dụ 20 cửa sổ 1024×768 không thể hiển thị nguyên vẹn trên một màn hình Full HD; mục tiêu 20 phiên chạy không phải 20 cửa sổ đủ lớn cùng hiển thị.

Preset có engine revision, viewport, locale, timezoneId, colorScheme và optional geolocation permission riêng. Default dùng UA thật của engine. Custom UA phục vụ bài compatibility test phải được gắn nhãn và kiểm tra tính nhất quán với Client Hints; không giả lập Android chỉ bằng đổi UA trên Windows. Locale/timezone không tự suy ra theo geolocation IP chính xác.

Pacing mặc định giữ thứ tự, có concurrency/throughput limit. Tùy chọn `fixedStaggerMs` cho lệch thời gian giữa Follower để giảm burst; giá trị đề xuất 0–100 ms. Không dùng random timing làm tiêu chí chống phát hiện. Với test robustness, seed/delay range lưu ở test report; jitter chỉ cộng trước action trong FIFO, không làm đảo click rồi text. Coordinate offset mặc định 0; chỉ mở trong test vùng hitbox đã có adapter, không trượt sang nút lân cận.

## 9. Data model và API nội bộ

### 9.1. Các bảng chính

| Bảng | Trường chính và invariant |
|---|---|
| profiles | UUID, name, group, proxy_mode, proxy_id, preset_json, config_revision; required phải có proxy_id |
| proxies | UUID, scheme, host, port, auth_kind, secret_ref; không password plaintext |
| profile_runtime | profile_id, generation, owner PID/birth time, state, last_error; startup phải reconcile |
| sync_sessions | UUID, epoch, master_id, state, mode, policy_json; không auto resume khi reload |
| sync_members | session_id, profile_id, role, logical_tab; active membership unique/profile qua transaction |
| sync_deliveries | event_id, follower_id, epoch, seq, state, verification, times, code; unique dedup key |
| variable_sets / variable_values | dataset revision và profile key; encrypted value blob; không merge theo vị trí |
| audit_events | metadata tối thiểu; không text nhập/secret/query URL |
| schema_migrations | version, checksum, applied_at; versioned forward migration |

SQL trong kit là migration tham chiếu có constraints nền tảng. Invariant cross-row như Master duy nhất, không tham gia hai nhóm hoạt động và lifecycle lock phải được thực thi trong application transaction + OS lock; không tuyên bố SQLite một mình làm được mọi điều kiện.

### 9.2. IPC contract

Request envelope: `request_id`, `command`, `expected_revision?`, `payload`. Response: `request_id`, `ok`, `data?`, `error:{code,message,retryable,details_redacted}?`. Mutation yêu cầu request_id làm idempotency key; retry cùng ID khác payload → IDEMPOTENCY_CONFLICT. Long-running command trả operation_id và status updates, không treo IPC chờ hàng chục profile launch xong.

| Command | Input tối thiểu | Kết quả / rule |
|---|---|---|
| profile.create / update | config; expected_revision cho update | UUID + revision; running dùng pending changes |
| profile.startMany / stopMany | profile_ids, request_id | operation_id; từng item status; không all-or-nothing toàn batch |
| profile.delete | UUID, expected_revision | Chỉ STOPPED, không là active sync member |
| proxy.previewImport / commitImport | input bytes rồi preview token | Preview không viết; commit giữ đúng revision |
| proxy.checkMany / assign | proxy_ids hoặc explicit mapping | Kết quả từng proxy; assignment không suy theo sort UI |
| sync.create / arm / start | Master, Followers, mapping, policy | Capability report rồi session state |
| sync.pause / resume / stop | session_id, expected_epoch | Epoch check; resume re-arm |
| sync.promoteMaster | new_master_id, mapping | Chỉ PAUSED, clear queue, epoch++ |
| sync.navigate | URL/action, logical_tab | Validate scheme/origin; navigation barrier |
| variables.preview / apply | dataset revision + target + profiles | Typed plan; missing value block trước dispatch |
| windows.tile | profile IDs, display ID, grid | Actual viewport report; mismatch pause sync |
| backup.create / restore | selected profiles, destination | Stopped-state verification và manifest |
| diagnostics.export | time range, selected profiles | Redacted report; không raw data session |

Controller tự gắn privilege/sender; không chấp nhận role do renderer gửi làm bằng chứng. App không có arbitrary shell command, eval endpoint hoặc raw CDP passthrough trong public IPC. Rate limit commands từ renderer; request IDs chưa hoàn tất có recovery record. HTTP REST API và WebSocket remote là ngoài V1.

### 9.3. Error catalog tối thiểu

| Code | Hành động UI/worker |
|---|---|
| PROFILE_LOCKED / PATH_UNSAFE | Không launch; chỉ chủ sở hữu hợp lệ mới cleanup |
| ENGINE_MISMATCH / CAPABILITY_UNSUPPORTED | Báo version/capability; không thay engine âm thầm |
| SECRET_UNAVAILABLE / AUTH_FAILED | Mask credential; cho sửa/nhập lại, không brute retry |
| PROXY_UNREACHABLE / PROXY_TLS_FAILED | Chặn proxy-required; kiểm tra endpoint và chứng chỉ |
| EGRESS_MISMATCH / CHECK_INCONCLUSIVE | Không READY; hiển thị kiểm tra nào chưa đạt |
| ROUTE_MISMATCH / DOCUMENT_STALE | Pause; remap/re-arm, drop epoch cũ |
| TARGET_NOT_FOUND / TARGET_AMBIGUOUS / TARGET_OCCLUDED | Chặn click; xem adapter/locator, không coordinate fallback |
| TEXT_BASELINE_MISMATCH / INPUT_UNSUPPORTED | Pause field; người dùng đối soát, không overwrite |
| QUEUE_OVERFLOW / WORKER_UNRESPONSIVE | Pause và release input; không bỏ discrete action |
| ACTION_UNKNOWN / ACK_TIMEOUT | Không tự retry; đối soát kết quả site |
| REVISION_CONFLICT / IDEMPOTENCY_CONFLICT | Reload/preview lại; không đè thay đổi mới |
| RESOURCE_LIMIT / DISK_LOW | Không start mới; không xóa dữ liệu hoặc kill profile ngầm |

## 10. Privacy, bảo mật dữ liệu và update

SecretStore ở main, worker chỉ nhận credentials cần cho profile qua IPC riêng; không truyền command-line/env ghi log. DPAPI bảo vệ dữ liệu theo user Windows, không chống được mọi ứng dụng độc hại chạy cùng user. Pin API safeStorage theo Electron đã chọn; tài liệu hiện hành có asynchronous API, phải kiểm tra availability/rotation. Không tự fallback sang “mã hóa” bằng khóa cố định. [S08]

Tắt lưu password/autofill của app nếu không có yêu cầu sản phẩm; Chromium có cơ chế riêng cần ghi trong hướng dẫn. Backup browser-data có thể chứa session/login; mặc định chỉ export config không secrets. Export đầy đủ cần password-encrypted archive bằng thư viện đã review, KDF/AEAD thông số có version và fixture; không tự thiết kế crypto hoặc lưu key trong ZIP. Restore trên user/máy khác có thể không giải mã được secret/cookie OS-bound; bắt buộc hỗ trợ nhập lại và đăng nhập lại.

Log ring mặc định 7 ngày hoặc 100 MB, điều kiện nào đến trước; metrics 24 giờ. Không log cookie, authorization header, proxy URI userinfo, input text, clipboard, token/query URL. Screenshots/traces/HAR không bật mặc định; khi debug chủ động phải giới hạn phạm vi và báo loại dữ liệu có thể xuất hiện. Export diagnostics luôn redaction lại, không dựa duy nhất logger upstream.

Update qua release đã ký/checksum, manifest pin app + Electron + Playwright + Chromium + relay + native helper + DB schema. Không runtime `install latest`. Update yêu cầu dừng profile, backup nhất quán, kiểm tra disk và rollback path. Nếu Chromium đã upgrade user-data format, không chạy revision cũ trên cùng thư mục; restore snapshot tương thích hoặc giữ engine cũ cho snapshot cũ. Chromium/Playwright/CDP đi cùng tested matrix; API experimental nằm sau capability gate.

## 11. Chỉ tiêu chất lượng và benchmark

| Metric | Mục tiêu ban đầu | Cách đo |
|---|---|---|
| Profile isolation | 0 dữ liệu chéo trong fixtures | Cookies/localStorage/IndexedDB/service workers, reopen nhiều vòng |
| Ordering | 0 đảo discrete action | Trace 10.000 commands vào mock executor + browser flow có marker |
| Replay correctness | 100% trên deterministic supported fixtures | Không suy rộng thành 100% website ngoài |
| Dispatch latency | p95 ≤150 ms, p99 ≤300 ms ở 1 Master + 4 Followers | Controller nhận action → bắt đầu dispatch ở follower; không tính site load/intentional pacing |
| End-to-end latency | Báo riêng; mục tiêu p95 ≤500 ms ở fixture ổn định | Capture → kết thúc browser action; ghi click debounce/queue/navigation riêng |
| Ten-profile operation | Không crash do app trong soak 60 phút | 10 profile, mỗi 1 tab fixture, memory/CPU/queue log, hardware và version kèm report |
| Twenty-profile stress | Xác định giới hạn, không là release promise | Máy 32 GB, tăng dần tải và ghi saturation |
| Emergency Stop | Ngừng dispatch lệnh mới p95 <250 ms | Controller timestamp; đã gửi network request không bị đảo ngược |
| Startup | Báo median/p95, cold/warm tách biệt | Không cam kết số giây trước khi có G0/G5 measurement |
| Secrets/logs | 0 canary secret trong diagnostics export | Scan binary/text outputs của fixture có secret marker |

Đo cùng engine/build và chính sách power management. Latency CDP khác latency website; bảng kết quả phải có cả queue wait, resolve, dispatch, action completion và verification. Không dùng `Date.now()` giữa các tiến trình để kết luận microsecond latency; controller monotonic clock đo điểm đi/về và worker báo duration tương đối.

## 12. QA — kịch bản nghiệm thu bắt buộc

Mỗi test có precondition, action, expected result và evidence path trong `qa/acceptance.csv`. Các nhóm dưới đây là chỉ dẫn thực thi, chưa phải test đã chạy.

| Nhóm | Kịch bản tối thiểu |
|---|---|
| Profile | 3 profile cùng origin lưu giá trị khác nhau; restart app; double-start cùng UUID; invalid path; duplicate config không mang login |
| Proxy | URI auth ký tự đặc biệt/IPv6; wrong auth; dead upstream; TLS invalid; HTTP/HTTPS/SOCKS5 auth; unique/shared assignment; browser IP check |
| Network | Tắt proxy giữa request; relay mất; target 403; endpoint health hỏng; DNS/IPv6/WebRTC/QUIC/WS/service worker/loopback diagnostics |
| DOM sync | Button trùng text, overlay, dynamic banner, DOM reorder, checkbox/radio/select, hover menu; không tự coordinate fallback |
| Coordinate | Cùng/khác viewport, DPI, scroll, zoom, canvas bounds, drag path, mouseup mất, double-click; transform không hỗ trợ phải chặn |
| Text | Tiếng Việt Telex/VNI/IME theo input methods thử; emoji, surrogate pairs, selected replace, backspace, undo, multiline, paste, excluded field |
| Ordering | Slow follower 5 giây, queue overflow, navigation barrier, duplicate event, late ACK, stale epoch, master promotion, stop during held key |
| Page lifecycle | Reload, SPA route, back/forward cache, tab close, popup ambiguous, frame navigation, different history, source blur |
| Recovery | Kill worker; kill controller; browser crash; disk full; stale PID; app restart; ACTION_UNKNOWN không auto replay |
| Data | CSV rows lệch/duplicate; secret redaction; formula-injection export; backup while open rejected; restore different OS user báo re-login |
| Packaging | Máy Windows sạch, path có dấu/khoảng trắng, không có Node global, offline runtime, upgrade/rollback, native ABI và ký binary |
| Capacity | 1/5/10 profile; 20 stress; thiếu RAM; nhiều màn hình DPI khác; unplug màn hình khi đang sync |

Fixtures phải do team kiểm soát, có server counter cho action có effect và trang echo field để phân biệt dispatch thành công với nghiệp vụ được áp dụng. Không dùng website bên ngoài thay toàn bộ fixture vì nội dung động sẽ làm test thiếu xác định. Smoke browser ngoài chỉ ghi quan sát tương thích theo site/version/ngày, không đưa vào assertion tuyệt đối.

## 13. RUNBOOK A — triển khai trong Antigravity

### A1. Chuẩn bị workspace

1. Giải nén kit vào repo mới hoặc thư mục docs của repo hiện có. Đọc `ANTIGRAVITY_START_HERE.md`, tài liệu này, acceptance CSV và contracts trước khi tạo module.
2. Nếu có repo, kiểm tra cấu trúc, framework, quy tắc dự án, thay đổi chưa commit; không viết đè hoặc thay stack ngay. Ghi ADR cho khác biệt cần thiết. Nếu chưa có repo, tạo TypeScript workspace theo blueprint trong kit.
3. Dùng chế độ planning phù hợp của Antigravity để ra implementation plan có FR/Gate/test mapping. Tài liệu hiện hành mô tả `/plan` và artifact plan; tên UI/chính sách review có thể thay đổi, không cần phụ thuộc slash command để dùng prompt trong kit. [S16]
4. G0 ghi phiên bản thực tế, OS, engine path/revision, API khả dụng, protocol snapshot. Chỉ chốt dependency lock sau spike. Không để `latest`, caret/range tùy ý trong release manifest.

### A2. Trình tự implementation

**G0:** prototype có worker thật, persistent context riêng, relay upstream SOCKS auth fixture, capture isolated world, IME text và window/DPI measurement. Đầu ra `artifacts/g0-spike.md`, ADR và `version-matrix.json` có số phiên bản đã kiểm tra. Không triển khai fingerprint noise trước core.

**G1:** repo/domain/storage/SecretStore, migrations, profile CRUD/import, single-writer lifecycle, locking và process tree. Demo 3 profile vẫn giữ state riêng sau reopen; sau đó 20 vòng start/stop.

**G2:** parser/import preview, relay lifecycle, secret handling, no-direct-fallback adapter, preflight qua browser, proxy pool UI. Failure injection wrong-auth/dead/TLS/rotate. Chưa đạt SOCKS auth thì capability phải disabled và G2 chưa complete.

**G3:** canonical events, queue từng Follower, epoch/dedup/ACK, DOM resolver, text/IME, coordinate gesture, emergency stop. Bắt đầu 1+1, rồi 1+4. Xử lý double capture và stuck keys trước khi thêm effects/UI polish.

**G4:** navigation barrier/tab mapping, variables, tiling, presets, UI trạng thái rõ, shortcuts. Không coi browser chrome hoặc OS dialog là đã sync chỉ vì DOM click hoạt động.

**G5:** crash/recovery, backup/restore/update, installer, canary redaction, soak/performance, clean-machine E2E. Đưa hạn chế còn lại vào release notes có capability codes. Không đánh dấu Done khi còn P0 fail.

Mỗi milestone báo: files changed, behavior, commands/tests thực sự chạy, evidence, limitations và next step. Nếu thiếu proxy production, dùng fixture local với credentials giả, ghi rõ chưa xác nhận provider thật; không tự fabricate test PASS.

### A3. Command contract phải được app repo triển khai

Các lệnh sau là **hợp đồng scripts cho repo ứng dụng tương lai**, không chạy được chỉ bằng kit tài liệu:

```text
npm ci
npm run engine:install:pinned
npm run doctor
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e:windows
npm run test:proxy-matrix
npm run test:sync-matrix
npm run bench -- --profiles=10 --minutes=60
npm run package:win
npm run verify:release
```

`doctor` kiểm tra binary revision/hash, worker spawn, writable root, secret backend, DB migrations, helper signature/ABI, ephemeral loopback listener và DNS fixture configuration; không đọc cookie/password thật. `engine:install:pinned` đọc manifest với revision chính xác, không tự nâng lên mới nhất. CI build phải có Windows runner cho E2E và packaging; unit tests chạy đa nền tảng không thay Windows validation.

## 14. RUNBOOK B — sử dụng ứng dụng

### B1. Tạo profile và sử dụng proxy

1. Mở Profiles → New hoặc Import; đặt tên/nhóm; app cấp UUID.
2. Vào Proxy Pool → Import, chọn scheme/format; xem preview từng dòng, sửa dòng lỗi, commit.
3. Chọn profile → Assign Proxy; xem mapping và policy unique/shared; apply. Nếu muốn direct, chọn Direct rõ ràng.
4. Chạy Check Proxy; xem auth, connect, egress, timestamp; lỗi 403 của website không nhầm với sai mật khẩu proxy.
5. Chọn các profile → Open. UI cập nhật từng cái; proxy-required lỗi không mở start URL qua direct.
6. Đăng nhập website riêng mỗi cửa sổ. Đóng bằng Stop để flush session; mở lại kiểm tra phiên còn nguyên. Session có thể bị website thu hồi hoặc yêu cầu đăng nhập lại, app không bảo đảm duy trì vô hạn.

### B2. Đồng bộ thao tác

1. Đưa các profile tới route tương ứng bằng lệnh Open URL của Dashboard hoặc tự thao tác. Chọn logical tab cho mỗi profile.
2. Chọn Master và Followers → Create Sync. Chọn DOM mặc định; canvas/game chọn Coordinate với viewport/bounds phù hợp.
3. Arm: UI kiểm tra readiness, mapping, capabilities; chỉ Start khi toàn nhóm đáp ứng policy.
4. Thao tác trên tab Master. Theo dõi ACK và profile bị chặn; tránh gõ/click trực tiếp Follower trong lúc RUNNING. Nếu người dùng can thiệp Follower, pause profile và rebaseline.
5. Lệch trang/overlay/load chậm: Pause → xem profile lỗi → sửa/map lại → Resume để tạo epoch mới. Không bấm Retry hàng loạt khi status UNKNOWN.
6. Kết thúc → Stop Sync; profile có thể vẫn mở để dùng riêng. Stop Profiles mới đóng browser.

Lệnh có tác động khó hoàn tác như submit/xóa/thanh toán không có undo cross-profile. Site adapter có thể đánh dấu action cần operator review trước phát lại cho Followers. Capture kiểu quan sát không thể thu hồi thao tác đã thực hiện trên Master; nếu cần phê duyệt trước mọi tác động, dùng command từ Dashboard hoặc một workflow intercept riêng, không hứa listener trang đã tạo transaction toàn nhóm.

### B3. Biến và cửa sổ

Import dataset CSV/JSON → map theo UUID → chọn field → preview từng profile → Fill. Thiếu giá trị thì sửa trước khi apply. Tile chọn màn hình/grid; sau thay kích thước, arm lại Coordinate Mode. Khi đổi proxy/preset, stop/restart những profile được chọn.

## 15. RUNBOOK C — xử lý sự cố

| Triệu chứng | Kiểm tra theo thứ tự | Cách khôi phục |
|---|---|---|
| Browser không mở | PROFILE_LOCKED, engine missing, disk, worker log, secret backend | Chỉ dọn lock sau đối soát owner; cài đúng revision, không xóa browser-data |
| Proxy báo auth fail | Scheme/auth type, percent encoding, credentials, provider policy | Sửa secret và test lại; SOCKS5 auth phải đi qua relay |
| Proxy kiểm tra OK nhưng site lỗi | Browser egress, target status, TLS, protocol, site policy | Phân loại TARGET_BLOCKED; không tự quay vòng tài khoản/IP để tiếp tục |
| Proxy ngắt mà trang vẫn xem được | Cache, service worker, tunnel cũ, bypass, background traffic | Dùng endpoint nonce mới, đóng tunnels, đo network; xem được cache không chứng minh direct leak |
| Click lệch | Mode, actual viewport, zoom, frame/canvas rect, route, overlay | Pause/re-arm hoặc adapter DOM; không tăng offset ngẫu nhiên |
| Chữ bị lặp | keydown + input cùng replay, composition handler, undo path | Tắt nhóm; trace metadata event type; sửa canonicalization, không log text thật |
| Follower chậm dần | Queue age, CPU/RAM, minimized throttling, navigation waits | Pause; giảm profile/tải, rebaseline; không xả toàn backlog |
| Phím bị giữ | Mất keyup khi blur/stop/crash | control.release; nếu không xác minh được thì đóng tab/context an toàn |
| ACK mất sau click | Worker/browser disconnect, timeout | Mark UNKNOWN, người vận hành đối soát site; không click lại tự động |
| Không tìm thấy frame/popup | Cross-origin/OOPIF, mapping ambiguous, generation | Dừng sync tại frame đó; map rõ hoặc sử dụng bằng tay |
| Lỗi restore secrets | User/máy khác, OS-bound key, engine data format | Restore config rồi nhập lại credentials/login; không giải mã bằng cách lấy dữ liệu tài khoản OS khác |
| App crash để lại process | Job membership, inherited handle, PID reuse | Startup reconcile theo identity; terminate đúng tree của app, không kill toàn bộ chrome.exe |
| Update làm profile lỗi | App/engine/schema matrix, snapshot | Stop; restore snapshot và matching engine; không downgrade trực tiếp user-data đã nâng |

Thông tin gửi cho dev: app/build/engine revision, OS và DPI, số profile, mode, error code, thời điểm, operation/trace ID và reproduction trên fixture. Không gửi password, cookie hoặc profile folder thật trong ticket mặc định.

## 16. RUNBOOK D — backup, release và rollback

### D1. Backup

Pause/Stop sync → stop tất cả profile thuộc backup → xác nhận context và tree đã thoát → DB checkpoint hoặc SQLite backup API nhất quán → snapshot metadata + selected browser-data + manifest → checksum → mã hóa nếu chứa dữ liệu phiên. Không copy SQLite file đang ghi mà bỏ WAL; không zip Chromium user-data đang mở.

Backup manifest có app/schema/engine revision, profile IDs, file sizes/hashes, loại export, thời điểm và encrypted flag. Không chứa raw secrets để “tiện restore”. Kiểm thử restore vào thư mục mới và profile đã dừng; reject path traversal/symlink/zip bomb, giới hạn expanded size và canonical root. Không ghi đè dữ liệu đang sống; tạo staging, verify rồi atomic swap/rollback.

### D2. Release

Chỉ phát hành khi G0–G5 đạt, test report và limitation matrix đầy đủ, secret canary scan sạch, Windows clean install thành công, 10-profile soak có số đo, build hash/lock/license inventory hiện hữu. Đóng gói Chromium tương thích và các thông báo license cần thiết; người dùng không cần tự cài Node/npm để chạy bản installer.

Smoke release: tạo 3 profile → gán 3 proxy fixture → mở cùng origin, verify state riêng → sync click/text/scroll → làm 1 proxy lỗi, verify pause → stop → reopen → uninstall theo lựa chọn giữ/xóa dữ liệu. Uninstall mặc định hỏi rõ dữ liệu profile, không tự xóa dữ liệu người dùng.

### D3. Rollback

Giữ bản installer và snapshot gần nhất. Stop mọi worker → sao lưu trạng thái hiện tại phục vụ điều tra → chọn app/engine/schema đồng bộ với snapshot → restore → doctor → chỉ mở một profile thử trước. Không rollback DB bằng cách đoán DROP COLUMN hoặc dùng engine cũ vào data mới. Nếu chưa có snapshot tương thích, giữ dữ liệu và báo hạn chế, không xóa để “sửa nhanh”.

## 17. Definition of Done và các quyết định còn cần đo

V1 hoàn tất khi FR-01 đến FR-16 qua acceptance tương ứng; không test P0 nào fail/skipped; state, queue, proxy và secrets có failure injection; installer chạy trên Windows sạch; benchmark đúng môi trường; tài liệu thao tác/sự cố khớp UI; limitations hiển thị đúng. Các tính năng V1.1/V2 phải disabled hoặc gắn nhãn rõ, không nút giả.

Những điểm cần G0 xác minh thay vì đoán: CDP capture world trên engine đã pin; hành vi IME thực tế Windows; worker packaging và Chromium sandbox; Job Object inheritance; remote DNS của relay SOCKS; HTTP proxy auth retry; WS/WSS; window bounds/DPI; native helper signing; auth secret backend availability. Nếu spike không đạt, Antigravity đưa reproduction + phương án thay đổi ADR, không viết “fully supported” dựa trên tài liệu API.

Ưu tiên khi phải giảm phạm vi: giữ isolation/proxy/lifecycle/ordering/stop; giảm advanced editor, multi-tab tự động, cross-origin frame và animation UI. Không bỏ test no-direct-fallback hoặc sửa duplicate text bằng cách thêm delay ngẫu nhiên.

## 18. Nguồn kỹ thuật và phạm vi bằng chứng

Kiểm tra ngày **29/10/2026**. Chỉ dùng nguồn chính thức hoặc repository của nhà duy trì. Các trang `/latest`, `/tot` và nhánh `main` có thể thay đổi; khi implement phải pin phiên bản và lưu version matrix. Trích dẫn dưới đây xác nhận khả năng API, không xác nhận app đề xuất đã được build hoặc benchmark.

| ID | Nguồn | Điểm dùng |
|---|---|---|
| S01 | [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype) | Persistent contexts, data dir và proxy options |
| S02 | [Playwright Network](https://playwright.dev/docs/network) | HTTP(S)/SOCKS proxy configuration; HTTP auth fields |
| S03 | [Chromium Proxy Support](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) | Proxy schemes, SOCKS auth/DNS/UDP và giới hạn tuyến |
| S04 | [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) | Mouse/key dispatch và text insertion |
| S05 | [WHATWG DOM — isTrusted](https://dom.spec.whatwg.org/#dom-event-istrusted) | Ý nghĩa browser-dispatched event |
| S06 | [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security/) | Renderer isolation, sandbox và IPC boundaries |
| S07 | [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext) | Init scripts và binding source |
| S08 | [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) | OS-backed encryption và giới hạn cùng OS user |
| S09 | [Chrome remote debugging changes](https://developer.chrome.com/blog/remote-debugging-port) | Default data directory và Chrome 136 |
| S10 | [Playwright Actionability](https://playwright.dev/docs/actionability) | Locator checks và giới hạn force action |
| S11 | [Apify proxy-chain repository](https://github.com/apify/proxy-chain) | Upstream chaining, auth, SOCKS và direct default |
| S12 | [CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) | Scoped binding và execution context |
| S13 | [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) | Isolated world và init script |
| S14 | [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) | Worker process và message channels |
| S15 | [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | Process grouping và kill-on-close |
| S16 | [Google Antigravity Plan](https://antigravity.google/docs/plan/) | Planning và implementation artifacts |

**Tình trạng bàn giao:** hồ sơ yêu cầu, quyết định kiến trúc, hợp đồng và bộ nghiệm thu đề xuất. Kiểm tra tính nhất quán file/schema không thay thế chạy browser thật; kết quả browser/proxy/Windows phải do quá trình implementation tạo ra.
