# Thuật toán tham chiếu — không phải mã ứng dụng chạy được

Pseudocode dưới đây xác định thứ tự hiệu lực. Implementation phải có failure tests; tên API trong pseudocode là API nội bộ cần tạo, không khẳng định có sẵn trong Playwright.

## 1. Launch với cleanup có thứ tự

```text
start(profile_id, expected_revision):
  acquire controller mutex(profile_id)
  acquire OS profile lock
  read validated immutable config snapshot
  assert revision, safe data path, capacity, engine matrix
  create worker channel and verified job/process ownership
  worker: decrypt-free config + secrets received only over private channel
  if proxy required:
    create authenticated loopback relay with mandatory upstream
    assert listener is 127.0.0.1 and auth token is per-session
    test proxy route (not direct Node request)
  launch persistent context, headed, explicit sandbox configuration
  register page/frame/context lifecycle and capture hooks
  verify browser egress through actual context
  open configured start URL
  transition READY
  on any failure:
    stop new capture and dispatch
    close context / verified process tree
    close relay incl existing tunnels
    release lock only when ownership is resolved
    persist redacted error; never relaunch as direct
```

## 2. Capture và canonicalization

```text
on_capture(worker_channel, cdp_context, raw):
  identify source via registry, not payload identity
  reject source outside selected Master tab/session/current document
  validate limits and event type; reject privileged payloads
  update composition / gesture state
  turn one user intent into one canonical action
  merge only eligible movement before assigning sequence
  if source is password/excluded field: no text capture
  if unsupported capability: pause with explicit reason
  assign event_id, epoch, seq, route_generation in controller
  freeze recipient set from current membership
  append metadata ledger + in-memory payload reference
  enqueue each recipient in its own bounded FIFO
```

Coalescing trước cấp seq tránh gap giả. Khi một gesture bắt đầu, không được bỏ down/up. Event từ Follower hoặc epoch cũ không được đưa trở lại broadcast, tránh vòng lặp.

## 3. Follower executor

```text
while session accepts dispatch:
  delivery = dequeue in seq order
  if expired / wrong epoch / removed member: SKIPPED; continue
  await current route barrier (bounded)
  resolve mapping to follower-local document token
  verify document still current; target unique; field baseline valid
  if any precondition fails: BLOCKED; apply strict/continueHealthy policy
  persist DISPATCHING metadata before sending effect
  run exactly one adapter action under deadline
  if action succeeds:
    read lightweight postcondition if configured
    APPLIED + verification matched/unverified/mismatched
  if failure is provably before any dispatch:
    bounded retry inside same queue position, or FAILED
  if effect may have occurred or adapter still running:
    UNKNOWN; isolate worker/target; do not advance to next effect
  ack metadata to controller; no text value in ACK
```

Nếu crash sau DISPATCHING nhưng trước actual send, recovery vẫn UNKNOWN. Đây là lựa chọn bảo thủ để không tự tạo effect trùng; không thể có exactly-once bằng ledger riêng. Chỉ adapter biết chắc “chưa gửi” mới được phân loại retryable.

`Promise.race(action, timeout)` không tự hủy action. Khi API không có abort được hỗ trợ, executor khóa target, không chạy command kế tiếp; supervisor đóng target/context nếu cần. Không tạo hai hành động đang chạy trên cùng Follower.

## 4. Navigation barrier

```text
when Master document changes or app navigation is dispatched:
  stop accepting actions against old source document
  invalidate old per-document mappings
  open barrier with new route_generation
  for each follower:
    observe its own navigation caused by the corresponding action
    if explicit Dashboard navigation: issue that command once
    wait for route predicate + local document + required sentinel
    store its local document token in the mapping
  if all required members ready: release barrier
  otherwise: pause and expose per-member cause
```

Không copy OAuth/query token Master. Không phát `goto(master.url)` lần hai sau click. Các action old-document chưa dispatch bị bỏ có trạng thái rõ; action đã dispatch cần ACK/UNKNOWN trước arm generation mới.

## 5. Stop, epoch và input cleanup

```text
stop(session):
  disable capture at controller immediately
  close dispatcher admission
  mark pending deliveries SKIPPED and destroy payload references
  request release all held keys/buttons on each target
  await bounded in-flight completion or isolate/close target
  mark unacknowledged effects UNKNOWN
  epoch += 1; mark STOPPED
```

Release best-effort có thể không thực hiện nếu page/worker đã crash. Trong trường hợp đó phải close target và cho biết nguyên nhân; không báo keyup đã được gửi thành công khi chưa có response.

## 6. Hai chế độ text không trộn

`text.patch` dùng cho editable field được hỗ trợ: composition commit → range replacement → verification. `key.command` dùng command không làm text patch trùng. Biến riêng dùng `variable.fill` từ một dataset revision frozen; không gộp vào stream raw keydown.

`key.raw` là luồng down/up có repeat cho canvas/non-editable trong Coordinate Mode; giữ trạng thái pressed keys và gửi release khi blur/stop. Không emit cùng một phím dưới cả key.raw và key.command. Chuyển focus vào field nhập liệu phải release trạng thái raw trước khi xử lý text.

Nhập tay vào Follower hoặc script trang đổi value ngoài baseline làm pause và rebaseline, không “tự sửa” bằng toàn bộ value của Master. `text.patch` indices là UTF-16 DOM offsets; renderer/adapter giữ biên Unicode/grapheme hợp lệ.
