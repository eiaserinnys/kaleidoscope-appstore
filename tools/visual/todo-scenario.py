"""할 일 앱 정의를 로컬 시험 쉘에서 실제 조작으로 확인한다.

위임서(카드 87b15ec1)의 확인 항목 1~10을 순서대로 수행한다. 시험 쉘은 정의만
올리므로 store.json의 자산을 먼저 등록하고, 저장 항목을 채운 뒤 창을 다시 연다.
날짜가 든 표본은 실행일 기준으로 계산한다(todo-sample.json의 date/done은 일 오프셋).

세라피엘 2회차 반려분(불러오는 중 자리, Enter 추가, 빈 묶음, 보기 바꿈, 지우기
확인 본문)은 check()로 모아 두었다가 마지막에 한꺼번에 실패로 알린다. 고치기 전
정의로 돌려 어느 확인이 실패하는지 한 번에 보기 위해서다.
"""

import base64
import hashlib
import json
import re
import shutil
import time
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]
APP_DIR = REPO / "apps" / "todo"
SAMPLE = Path(__file__).resolve().parent / "todo-sample.json"
OUT = Path(sb.out)
TODAY = date.today()


def log(*parts):
    print("[todo]", *parts, flush=True)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def on_day(offset):
    return (TODAY + timedelta(days=int(offset))).isoformat()


def call(tool, args):
    res = sb.mcp.call(tool, args)
    if res["is_error"]:
        raise AssertionError(f"{tool} 실패: {res['text'][:800]}")
    return res["data"]


def wait_for(pred, what, timeout=15.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = pred()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"시간이 다 됐습니다: {what} (마지막 {last!r})")


definition = read_json(APP_DIR / "app.json")
store = read_json(APP_DIR / "store.json")
sample = read_json(SAMPLE)

# ── 표본 자료: 날짜 오프셋을 실행일 기준 날짜로 바꾼다 ──

sample_items = []
for spec in sample["items"]:
    sample_items.append({
        "id": spec["id"],
        "title": spec["title"],
        "area": spec["area"],
        "parent": spec["parent"],
        "status": spec["status"],
        "date": on_day(spec["date"]) if spec["date"] is not None else None,
        "wait": spec["wait"],
        "done_on": on_day(spec["done"]) if spec["done"] is not None else None,
        "created_on": on_day(-30),
        "order": spec["order"],
    })

# ── 자산과 앱, 저장소 준비 ──

for asset in store["assets"]:
    path = APP_DIR / asset["file"]
    payload = path.read_bytes()
    res = sb.mcp.call("upload_asset", {
        "id": asset["id"],
        "version": asset["version"],
        "format": asset["format"],
        "sha256": hashlib.sha256(payload).hexdigest(),
        "source": asset["source"],
        "license": asset["license"],
        "data_base64": base64.b64encode(payload).decode("ascii"),
    })
    if res["is_error"]:
        raise AssertionError(f"자산 등록 실패 {asset['id']}: {res['text'][:500]}")
    log("자산 등록", asset["id"], res["text"][:120])

uploaded = sb.mcp.call("upload_app", {"definition": definition, "open": False})
if uploaded["is_error"]:
    raise AssertionError(f"앱 등록 실패: {uploaded['text'][:800]}")
log("앱 등록", uploaded["text"][:160])


def read_storage(entry_id, doc=None):
    args = {"app_id": "todo", "entry_id": entry_id}
    if doc is not None:
        args["doc"] = doc
    res = sb.mcp.call("read_app_storage", args)
    if res["is_error"]:
        # 컬렉션 문서는 아직 쓰지 않았으면 not_found로 온다. 그때는 「없음」이다.
        if "STORAGE_DOCUMENT_READ_NOT_FOUND" in res["text"]:
            return None
        raise AssertionError(f"read_app_storage 실패: {res['text'][:800]}")
    return res["data"]


def put_storage(entry_id, content, doc=None):
    args = {"app_id": "todo", "entry_id": entry_id, "content": content}
    if doc is not None:
        args["doc"] = doc
    current = read_storage(entry_id, doc)
    if current and current.get("exists"):
        args["expected_revision"] = current["revision"]
    call("write_app_storage", args)


put_storage("items", sample_items)
put_storage("areas", sample["areas"])
for doc, body in sample["memos"].items():
    put_storage("memos", body, doc=doc)
log("표본 저장", len(sample_items), "항목,", len(sample["memos"]), "메모")

# ── 불러오는 중 화면을 찍으려면 items 읽기를 잡아 둬야 하므로, 창을 다시 열기 전에 건다.
# 시험 쉘은 시나리오 전에 --app 창을 열어 두지만 그 클라이언트는 이미 저장소를 다 읽었다.
# 그래서 앞서 열린 창을 닫고 이 다리 아래에서 다시 열어, 새 클라이언트의 첫 읽기를 잡는다.

held = []
page_ops = []


def core_route(route):
    try:
        req = json.loads(route.request.post_data or "")
    except Exception:  # noqa: BLE001
        req = {}
    if isinstance(req, dict) and str(req.get("op", "")).startswith("storage"):
        page_ops.append([req.get("op"), req.get("entry")])
    if isinstance(req, dict) and req.get("op") == "storage.get" and req.get("entry") == "items":
        held.append(route)
        return
    route.continue_()


page.route("**/core", core_route)


def current_window():
    return next((w for w in sb.snapshot()["shared"]["windows"] if w["app_id"] == "todo"), None)


existing = current_window()
if existing is not None:
    sb.core({"op": "window.close", "window_id": existing["id"]})
    end = time.time() + 10
    while time.time() < end and current_window() is not None:
        page.wait_for_timeout(200)
    if current_window() is not None:
        raise AssertionError("앞서 열린 할 일 창이 닫히지 않았습니다")

snap = sb.snapshot()
workspace_id = snap["device"]["active_workspace_id"]
opened = sb.core({"op": "window.open", "desktop_id": snap["device"]["active_desktop_ids"][workspace_id],
                  "app_id": "todo", "rect": {"x": 40, "y": 60, "width": 1040, "height": 700}})
if "error" in opened:
    raise AssertionError(f"창 열기 실패: {opened}")
window = wait_for(current_window, "할 일 창 다시 열림", timeout=15)
wid = window["id"]
log("창", wid)

win = sb.window("todo")


def row(item_id):
    return win.locator(f'button[data-tree-id="item:{item_id}"]')


def check_span(item_id):
    return row(item_id).locator("[data-tree-check]")


def section(name):
    # 왼쪽 반복 틀이 그린 섹션만 고른다. 오른쪽 상세의 「묶음」 선택 값도 같은 글자를
    # 담으므로, 반복 틀(template)로 한정하지 않으면 strict 모드에서 두 요소가 잡힌다.
    return win.locator('section.ks-data-section[data-ks-block$="/template"]').filter(has_text=name)


def items_now():
    return read_storage("items")["content"]


def item_now(item_id):
    return next((it for it in items_now() if it.get("id") == item_id), None)


def day_groups():
    return win.locator('button[data-tree-id^="item:day:"]')


def window_box():
    box = win.bounding_box()
    if not box:
        raise AssertionError("창 좌표를 읽지 못했습니다")
    return box


# 메모 칸과 결정 줄의 자리를 잰다. 상세 칸의 「메모」 section과 그 아래 toolbar를
# 고르는 방식은 카드 87b15ec1 실측(run3/after/measure.json)과 같다.
MEASURE_DECISION_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  const rect = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {top: +box.top.toFixed(1), bottom: +box.bottom.toFixed(1), height: +box.height.toFixed(1)};
  };
  const headers = [...root.querySelectorAll('section.ks-data-section > .ks-data-section-header')];
  const memoHeader = headers.find((header) => header.textContent.trim() === "메모");
  const memo = memoHeader ? memoHeader.parentElement : null;
  const toolbar = [...root.querySelectorAll(".ks-data-toolbar")]
    .find((item) => item.textContent.includes("지우기")) || null;
  return {memo: rect(memo), toolbar: rect(toolbar)};
}"""


def set_size(width, height):
    sb.core({"op": "window.set_rect", "window_id": wid,
             "rect": {"x": 40, "y": 60, "width": width, "height": height}})
    end = time.time() + 15
    while time.time() < end:
        box = win.bounding_box()
        if box and abs(box["width"] - width) <= 4 and abs(box["height"] - height) <= 6:
            return
        time.sleep(0.2)
    raise AssertionError(f"창 크기가 {width}x{height}로 바뀌지 않았습니다: {win.bounding_box()}")


results = {}
problems = []


def check(name, fn):
    """확인 하나를 수행하고, 실패해도 멈추지 않고 모아 둔다."""
    try:
        results[name] = fn() or "ok"
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}".replace("\n", " ")[:500]
        results[name] = "FAIL " + message
        problems.append(f"{name}: {message}")
        log("확인 실패", name, message)
    else:
        log("확인 통과", name)


# ── 1-1. 불러오는 중: 뼈대가 왼쪽 목록 칸의 도구 막대 아래에 서고, 좁은 창에서도 목록 칸이 산다 ──

LOADING_MEASURE_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  if (!root) return {error: "창 없음"};
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1)};
  };
  const panes = [...root.querySelectorAll(".ks-split-pane")];
  const skeleton = root.querySelector(".ks-data-skeleton");
  const toolbar = root.querySelector(".ks-data-toolbar");
  return {
    stacked: !!root.querySelector(".ks-split.is-stacked"),
    panes: panes.map((el, index) => ({index, rect: rect(el), hasSkeleton: skeleton ? el.contains(skeleton) : false})),
    skeleton: rect(skeleton),
    toolbar: rect(toolbar),
    text: (root.innerText || "").slice(0, 200),
  };
}"""


def loading_check():
    def pumped(pred, what, timeout):
        # 페이지를 기다리는 동안에도 page 호출로 플레이라이트 디스패처를 돌려야
        # 잡아 둔 라우트 처리기가 불린다(time.sleep만으로는 held가 늘지 않는다).
        end = time.time() + timeout
        last = None
        while time.time() < end:
            last = pred()
            if last:
                return last
            page.wait_for_timeout(250)
        raise AssertionError(f"시간이 다 됐습니다: {what} (마지막 {last!r})")

    pumped(lambda: len(held) > 0, "items 읽기를 잡음", timeout=25)
    pumped(lambda: win.locator(".ks-data-skeleton").count() > 0, "불러오는 중 뼈대가 그려짐", timeout=15)
    time.sleep(0.8)
    try:
        wide = win.evaluate(LOADING_MEASURE_JS)
        sb.shot("loading-wide.png", "todo", settle=0.2)
        set_size(380, 700)
        time.sleep(1.2)
        narrow = win.evaluate(LOADING_MEASURE_JS)
        sb.shot("loading-narrow.png", "todo", settle=0.2)
    finally:
        set_size(1040, 700)
        time.sleep(0.5)

    def inside(measured, label, need_height):
        skeleton = measured.get("skeleton")
        panes = measured.get("panes") or []
        toolbar = measured.get("toolbar")
        assert skeleton is not None, f"{label}: 불러오는 중 뼈대가 없습니다 {measured}"
        assert len(panes) >= 2, f"{label}: 분할 칸이 둘이 아닙니다 {measured}"
        pane = panes[0]
        assert pane["hasSkeleton"], f"{label}: 뼈대가 왼쪽 목록 칸에 없습니다 {measured}"
        assert toolbar is not None and skeleton["top"] >= toolbar["bottom"] - 1, (
            f"{label}: 뼈대가 도구 막대 아래가 아닙니다 {measured}")
        assert skeleton["left"] >= pane["rect"]["left"] - 1 and skeleton["right"] <= pane["rect"]["right"] + 1, (
            f"{label}: 뼈대가 목록 칸 가로 범위를 벗어납니다 {measured}")
        if need_height:
            assert pane["rect"]["height"] > 1, f"{label}: 목록 칸 높이가 {pane['rect']['height']}px입니다 {measured}"

    inside(wide, "넓은 창", False)
    inside(narrow, "좁은 창", True)
    return {"wide": wide, "narrow": narrow, "held": len(held), "ops": page_ops[:12]}


check("loading_placement", loading_check)

for held_route in held:
    try:
        held_route.continue_()
    except Exception:  # noqa: BLE001
        pass
time.sleep(1.5)
page.unroute("**/core")
wait_for(lambda: win.locator('button[role="treeitem"]').count() > 0, "불러오기 끝난 트리", timeout=20)

# 4. 고른 것이 없을 때의 안내 글은 meta 스타일이다.
check("hint_meta_style", lambda: expect(
    win.get_by_text("할 일을 고르면 여기에 보입니다")).to_have_class(re.compile("is-meta")))

# ── 1. 첫 화면: 묶음 구역, 펼친 트리, 취소선, 보류 배지, meta ──

wait_for(lambda: win.locator('button[role="treeitem"]').count() > 0, "트리 행이 그려짐")
expect(section("업무")).to_be_visible(timeout=15000)
expect(section("개인")).to_be_visible(timeout=15000)
expect(row("t-report")).to_be_visible()
expect(row("t-collect")).to_be_visible()   # 펼친 트리(자식이 보인다)
expect(row("t-draft")).to_be_visible()
expect(row("t-quote")).to_be_visible()
expect(row("t-milk")).to_be_visible()

expect(row("t-collect").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
expect(row("t-collect").locator(".ks-tree-name")).to_have_css("text-decoration-line", re.compile("line-through"))
expect(row("t-quote").locator(".ks-badge")).to_have_text("보류")
expect(row("t-room").locator(".ks-view-meta")).to_have_text("내일")
expect(row("t-draft").locator(".ks-view-meta")).to_have_text("팀장 검토")
expect(row("t-collect").locator(".ks-view-meta")).to_have_text("어제")

# 상세 칸: 항목 하나를 골라 이름표 입력과 메모 문서를 확인한다.
row("t-draft").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("초안 쓰기", timeout=10000)
expect(win.get_by_label("묶음", exact=True)).to_contain_text("업무")
# 3. 기다림 안내 글.
check("wait_placeholder", lambda: expect(
    win.get_by_label("기다림", exact=True)).to_have_attribute("placeholder", "기다리는 사람이나 일"))
expect(win.get_by_label("기다림", exact=True)).to_have_value("팀장 검토")
expect(win.locator(".ks-data-window")).to_contain_text("초안 구성")
expect(win.get_by_role("button", name="지우기", exact=True)).to_be_visible()
expect(win.get_by_role("button", name="보류", exact=True)).to_be_visible()

measured = win.evaluate(MEASURE_DECISION_JS)
assert measured["memo"] and measured["toolbar"], f"메모 칸이나 결정 줄을 찾지 못했습니다: {measured}"
memo_gap = abs(measured["memo"]["bottom"] - measured["toolbar"]["top"])
assert memo_gap <= 1, (
    f"넓은 창에서 메모 칸 bottom {measured['memo']['bottom']}과 "
    f"결정 줄 top {measured['toolbar']['top']}의 차가 {memo_gap}px입니다")
results["wide_memo_decision_gap"] = memo_gap
log("넓은 창 메모 칸 bottom", measured["memo"]["bottom"],
    "결정 줄 top", measured["toolbar"]["top"], "차", memo_gap)

sb.shot("wide-light.png", "todo", settle=0.5)
shutil.copyfile(OUT / "wide-light.png", APP_DIR / "screenshots" / "1.png")
results["wide"] = "ok"

# 2. 같은 화면 어두움
page.emulate_media(color_scheme="dark")
time.sleep(0.8)
sb.shot("wide-dark.png", "todo", settle=0.3)
shutil.copyfile(OUT / "wide-dark.png", APP_DIR / "screenshots" / "2.png")
page.emulate_media(color_scheme="light")
time.sleep(0.5)

# 1(이어서). 좁은 창 380에서도 구역과 트리가 그려진다.
set_size(380, 700)
expect(section("업무")).to_be_visible(timeout=15000)
expect(row("t-draft")).to_be_visible()
expect(row("t-collect").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
expect(row("t-quote").locator(".ks-badge")).to_have_text("보류")
expect(row("t-room").locator(".ks-view-meta")).to_have_text("내일")
time.sleep(0.3)
narrow_measured = win.evaluate(MEASURE_DECISION_JS)
assert narrow_measured["toolbar"] and narrow_measured["toolbar"]["height"] > 0, (
    f"좁은 창에서 결정 줄 높이가 0입니다: {narrow_measured}")
results["narrow_decision_height"] = narrow_measured["toolbar"]["height"]
log("좁은 창 결정 줄 높이", narrow_measured["toolbar"]["height"])
sb.shot("narrow-open.png", "todo", settle=0.5)
results["narrow_first_screen"] = "ok"
set_size(1040, 700)

# 3. 넓은 창 기록 보기(스크린샷 3) — 6. 보기를 바꾸면 고른 항목을 비운다.
win.get_by_role("button", name="기록", exact=True).click()
wait_for(lambda: day_groups().count() >= 3, "기록 보기 날짜 묶음")


def clears_to_log():
    expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_be_visible(timeout=10000)
    expect(win.get_by_label("제목", exact=True)).to_have_count(0)


check("view_change_clears_open_selection", clears_to_log)

expect(day_groups().filter(has_text="오늘").first).to_be_visible()
expect(day_groups().filter(has_text="어제").first).to_be_visible()
expect(day_groups().filter(has_text=re.compile(r"\d+월 \d+일 \([월화수목금토일]\)")).first).to_be_visible()
expect(row("t-collect").locator(".ks-view-meta")).to_contain_text("업무 · 분기 보고서")
expect(row("t-passport")).to_be_visible()
expect(row("t-library")).to_be_visible()

# 스크린샷 3은 기록 항목 하나를 고른 상태로 찍는다.
row("t-collect").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("자료 모으기", timeout=10000)
sb.shot("log-wide.png", "todo", settle=0.5)
shutil.copyfile(OUT / "log-wide.png", APP_DIR / "screenshots" / "3.png")
for index in (1, 2, 3):
    size = (APP_DIR / "screenshots" / f"{index}.png").stat().st_size
    assert size <= 2 * 1024 * 1024, f"{index}.png가 2MiB를 넘습니다: {size}"
results["log_screenshot"] = "ok"

win.get_by_role("button", name="할 일", exact=True).click()
expect(section("업무")).to_be_visible()


def clears_to_open():
    expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_be_visible(timeout=10000)


check("view_change_clears_log_selection", clears_to_open)

# ── 2. 체크 칸 클릭으로 끝내기, 다시 눌러 되돌리기 ──

check_span("t-milk").click()
wait_for(lambda: (item_now("t-milk") or {}).get("status") == "done", "t-milk 끝냄 저장")
assert item_now("t-milk")["done_on"] == TODAY.isoformat(), item_now("t-milk")
expect(row("t-milk").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
check_span("t-milk").click()
wait_for(lambda: (item_now("t-milk") or {}).get("status") == "open", "t-milk 되돌림 저장")
assert item_now("t-milk")["done_on"] is None, item_now("t-milk")
expect(row("t-milk").locator(".ks-tree-name")).not_to_have_class(re.compile("is-checked"))
results["check_toggle"] = "ok"

# ── 3. 마지막 남은 자식을 끝내면 부모도 끝남 ──

check_span("t-draft").click()
wait_for(lambda: (item_now("t-draft") or {}).get("status") == "done", "t-draft 끝냄 저장")
wait_for(lambda: (item_now("t-report") or {}).get("status") == "done", "부모 t-report 끝냄 저장")
assert item_now("t-report")["done_on"] == TODAY.isoformat(), item_now("t-report")
expect(row("t-report").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
results["parent_auto_done"] = "ok"

# ── 4. 구역 + → 대화상자 → Enter로 추가 → 새 항목이 고른 상태 ──

section("업무").locator('button[aria-label="할 일 추가"]').click()
dlg = page.locator('[role="dialog"]')
expect(dlg).to_be_visible(timeout=10000)
expect(dlg).to_contain_text("할 일 추가")
title_field = dlg.get_by_label("제목", exact=True)


def empty_enter_keeps_dialog():
    title_field.press("Enter")
    time.sleep(0.6)
    expect(dlg).to_be_visible(timeout=3000)


check("dialog_empty_enter_keeps", empty_enter_keeps_dialog)


def enter_adds():
    title_field.fill("창고 정리")
    time.sleep(0.5)
    sb.shot("add-dialog.png", "todo", settle=0.2)
    title_field.press("Enter")
    expect(dlg).to_be_hidden(timeout=10000)


check("dialog_enter_adds", enter_adds)
if results.get("dialog_enter_adds") != "ok":
    # Enter가 듣지 않는 판이면 단추로 닫아 나머지 확인을 이어 간다(고치기 전 실행용).
    if dlg.is_visible():
        dlg.get_by_role("button", name="추가", exact=True).click()
    expect(dlg).to_be_hidden(timeout=10000)

added = wait_for(lambda: next((it for it in items_now() if it.get("title") == "창고 정리"), None), "새 항목 저장")
assert added["area"] == "업무" and added["parent"] is None, added
assert added["status"] == "open" and added["date"] is None, added
assert added["order"] == 6, added
expect(row(added["id"])).to_be_visible()
expect(row(added["id"])).to_have_attribute("aria-selected", "true")
expect(win.get_by_label("제목", exact=True)).to_have_value("창고 정리")
sb.shot("add-after-enter.png", "todo", settle=0.3)
results["add_from_section"] = "ok"

# ── 5. 상세에서 제목 고치기(0.5초 뒤 저장), 묶음 바꾸기(구역 이동) ──

row("t-slides").click()
title_input = win.get_by_label("제목", exact=True)
expect(title_input).to_have_value("발표 자료 만들기", timeout=10000)
title_input.fill("발표 자료 다듬기")
title_input.press("Tab")
wait_for(lambda: (item_now("t-slides") or {}).get("title") == "발표 자료 다듬기", "제목 저장", timeout=10)
expect(row("t-slides").locator(".ks-tree-name")).to_have_text("발표 자료 다듬기")

win.locator('button.ks-select-button[aria-label="묶음"]').click()
page.get_by_role("menuitem", name="개인", exact=True).click()
wait_for(lambda: (item_now("t-slides") or {}).get("area") == "개인", "묶음 저장", timeout=10)
moved = item_now("t-slides")
assert moved["parent"] is None and moved["order"] == 2, moved
expect(section("개인").locator('button[data-tree-id="item:t-slides"]')).to_be_visible(timeout=10000)
expect(win.locator('button.ks-select-button[aria-label="묶음"]')).to_contain_text("개인")
results["edit_title_and_area"] = "ok"

# ── 6. 보류 단추 → 배지, 지우기 → 확인 → 사라짐 ──

win.get_by_role("button", name="보류", exact=True).click()
wait_for(lambda: (item_now("t-slides") or {}).get("status") == "held", "보류 저장")
expect(row("t-slides").locator(".ks-badge")).to_have_text("보류")

win.get_by_role("button", name="지우기", exact=True).click()
confirm = page.locator('[role="dialog"]')
expect(confirm).to_be_visible(timeout=10000)
expect(confirm).to_contain_text("할 일을 지울까요?")
expect(confirm).to_contain_text("발표 자료 다듬기")
confirm.get_by_role("button", name="지우기", exact=True).click()
expect(confirm).to_be_hidden(timeout=10000)
wait_for(lambda: item_now("t-slides") is None, "항목 삭제 저장")
expect(row("t-slides")).to_have_count(0)
expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_be_visible(timeout=10000)
results["hold_and_remove"] = "ok"


# ── 7. 자식이 있는 항목의 지우기 확인 본문에 함께 지워진다는 말이 들어간다 ──

def cancel_open_dialog():
    dialog = page.locator('[role="dialog"]')
    if dialog.count() == 0:
        return
    cancel = dialog.get_by_role("button", name="취소", exact=True)
    if cancel.count() == 0:
        return
    cancel.first.click()
    expect(dialog).to_be_hidden(timeout=10000)


def confirm_body_detail():
    row("t-shop").click()
    delete = win.get_by_role("button", name="지우기", exact=True)
    expect(delete).to_be_visible(timeout=10000)
    delete.click()
    confirm = page.locator('[role="dialog"]')
    try:
        expect(confirm).to_be_visible(timeout=10000)
        expect(confirm).to_contain_text("하위 할 일도 함께 지워집니다", timeout=5000)
    finally:
        cancel_open_dialog()


check("remove_body_detail_has_children", confirm_body_detail)


def confirm_body_menu():
    row("t-shop").click(button="right")
    menu = page.get_by_role("menu")
    expect(menu).to_be_visible(timeout=10000)
    menu.get_by_role("menuitem", name="지우기", exact=True).click()
    confirm = page.locator('[role="dialog"]')
    try:
        expect(confirm).to_be_visible(timeout=10000)
        expect(confirm).to_contain_text("하위 할 일도 함께 지워집니다", timeout=5000)
    finally:
        cancel_open_dialog()


check("remove_body_menu_has_children", confirm_body_menu)

# ── 7. 기록 보기 → 날짜별 묶음, 체크 해제로 되돌리면 할 일 보기에 다시 나타남 ──

win.get_by_role("button", name="기록", exact=True).click()
wait_for(lambda: day_groups().count() >= 2, "기록 보기 다시 열기")
check_span("t-eggs").click()
wait_for(lambda: (item_now("t-eggs") or {}).get("status") == "open", "기록 보기에서 되돌림 저장")
assert item_now("t-eggs")["done_on"] is None
win.get_by_role("button", name="할 일", exact=True).click()
expect(row("t-eggs")).to_be_visible(timeout=10000)
expect(row("t-eggs").locator(".ks-tree-name")).not_to_have_class(re.compile("is-checked"))
results["log_uncheck"] = "ok"

# ── 8. 창이 열린 채 바깥에서 항목 추가 → 화면에 나타남 ──

current = read_storage("items")
root_orders = [it["order"] for it in current["content"] if it["area"] == "업무" and it["parent"] is None]
external = {
    "id": "t-keys",
    "title": "창고 열쇠 반납",
    "area": "업무",
    "parent": None,
    "status": "open",
    "date": None,
    "wait": None,
    "done_on": None,
    "created_on": TODAY.isoformat(),
    "order": max(root_orders) + 1,
}
call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                           "content": current["content"] + [external],
                           "expected_revision": current["revision"]})
expect(row("t-keys")).to_be_visible(timeout=15000)
expect(section("업무").locator('button[data-tree-id="item:t-keys"]')).to_be_visible()
results["external_write"] = "ok"

# ── 행 메뉴: 하위 할 일 추가 → 대화상자 → 취소 ──

row("t-soap").click(button="right")
menu = page.get_by_role("menu")
expect(menu).to_be_visible(timeout=10000)
for label in ("하위 할 일 추가", "보류", "지우기"):
    expect(menu.get_by_role("menuitem", name=label, exact=True)).to_be_visible()
menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
child_dlg = page.locator('[role="dialog"]')
expect(child_dlg).to_be_visible(timeout=10000)
expect(child_dlg).to_contain_text("할 일 추가")
child_dlg.get_by_role("button", name="취소", exact=True).click()
expect(child_dlg).to_be_hidden(timeout=10000)
results["item_menu"] = "ok"

# ── 9. 불러오는 중 화면은 맨 앞(loading_placement)에서 items 읽기를 잡아 확인했다. ──

# ── 10. 좁은 창에서 끝까지 내리면 결정 줄(지우기, 보류)이 보인다 ──

set_size(380, 700)
row("t-keys").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("창고 열쇠 반납", timeout=10000)
win.evaluate("""() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  const scrollers = [...root.querySelectorAll('*')].filter((el) => {
    const style = getComputedStyle(el);
    return el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
  });
  scrollers.forEach((el) => { el.scrollTop = el.scrollHeight; });
  return scrollers.length;
}""")
time.sleep(0.5)
box = window_box()
for name in ("지우기", "보류"):
    button = win.get_by_role("button", name=name, exact=True)
    expect(button).to_be_visible(timeout=10000)
    b = button.bounding_box()
    assert b is not None, f"{name} 좌표 없음"
    inside = (b["x"] >= box["x"] - 1 and b["y"] >= box["y"] - 1
              and b["x"] + b["width"] <= box["x"] + box["width"] + 1
              and b["y"] + b["height"] <= box["y"] + box["height"] + 1)
    assert inside, f"{name}가 창 밖입니다: 버튼 {b}, 창 {box}"
sb.shot("narrow-bottom.png", "todo", settle=0.3)
results["narrow_bottom_row"] = "ok"

set_size(1040, 700)

# ── 11. 메모가 없는 항목: 오류 안내 없이 빈 편집기가 열리고, 처음 고치면 문서가 생긴다 ──

memo_editor = win.get_by_role("textbox", name="마크다운 편집기")
row("t-draft").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("초안 쓰기", timeout=10000)
wait_for(lambda: "초안 구성" in memo_editor.inner_text(), "t-draft 메모 표시", timeout=15)
row("t-milk").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("우유", timeout=10000)
wait_for(lambda: memo_editor.inner_text().strip() == "", "빈 메모 편집기", timeout=15)
assert read_storage("memos", doc="t-milk") is None, "t-milk에 이미 메모 문서가 있습니다"
alert_count = win.locator('[role="alert"]').count()
assert alert_count == 0, f"메모가 없는 항목에서 오류 안내가 보입니다: {win.locator('[role=\"alert\"]').all_inner_texts()}"
memo_text = memo_editor.inner_text()
assert memo_text.strip() == "", f"빈 메모가 아닙니다: {memo_text!r}"
memo_editor.click()
page.keyboard.insert_text("새로 쓴 메모")
saved = wait_for(lambda: read_storage("memos", doc="t-milk"), "처음 쓴 메모 문서 생성", timeout=15)
assert saved.get("content") == "새로 쓴 메모", saved
results["missing_memo"] = {
    "alert_count": alert_count,
    "editor_text": memo_text,
    "document_content": saved.get("content"),
    "document_revision": saved.get("revision"),
}
log("메모 없는 항목", json.dumps(results["missing_memo"], ensure_ascii=False))

# ── 5. 빈 저장소: 묶음마다 트리를 숨기고 목록 자리에 빈 안내 한 줄만 둔다 ──

EMPTY_MEASURE_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  if (!root) return {error: "창 없음"};
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1)};
  };
  const pane = root.querySelector(".ks-split-pane");
  const stack = pane ? pane.querySelector(".ks-data-stack") : null;
  const stackItems = stack ? [...stack.children].filter((el) => el.classList.contains("ks-data-stack-item")) : [];
  const repeat = pane ? pane.querySelector(".ks-data-view.ks-repeat") : null;
  const line = [...root.querySelectorAll(".ks-data-text")].find((el) => el.textContent.includes("할 일이 없습니다")) || null;
  const header = (el) => {
    const node = el.querySelector(".ks-data-section-header");
    return node ? node.textContent.trim() : "";
  };
  return {
    pane: rect(pane),
    toolbar: rect(root.querySelector(".ks-data-toolbar")),
    stackItems: stackItems.map((el) => ({cls: el.className, flex: getComputedStyle(el).flex, rect: rect(el)})),
    repeat: repeat ? {cls: repeat.className, rect: rect(repeat), scroll: repeat.scrollHeight, client: repeat.clientHeight} : null,
    sections: [...root.querySelectorAll('section.ks-data-section[data-ks-block$="/template"]')].map((el) => ({
      title: header(el),
      rect: rect(el),
      child: rect(el.querySelector(".ks-data-section-child")),
      rows: el.querySelectorAll('button[role="treeitem"]').length,
      noItems: el.querySelectorAll(".ks-no-items").length,
    })),
    noItems: root.querySelectorAll(".ks-no-items").length,
    line: line ? {text: line.textContent.trim(), cls: line.className, rect: rect(line)} : null,
  };
}"""


def empty_store_check():
    current_items = read_storage("items")
    snapshot = current_items["content"]
    measured = None
    try:
        call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                                   "content": [], "expected_revision": current_items["revision"]})
        wait_for(lambda: win.get_by_text("할 일이 없습니다. +로 더하세요").count() > 0,
                 "빈 목록 안내 한 줄", timeout=10)
        wait_for(lambda: win.locator('button[role="treeitem"]').count() == 0,
                 "빈 저장소에 트리 행 없음", timeout=10)
        time.sleep(0.6)
        measured = win.evaluate(EMPTY_MEASURE_JS)
        sb.shot("empty-wide.png", "todo", settle=0.3)
        line = measured.get("line")
        assert line is not None, f"빈 안내 줄을 찾지 못했습니다: {measured}"
        assert line["text"] == "할 일이 없습니다. +로 더하세요", line
        assert "is-meta" in line["cls"], line
        assert measured["noItems"] == 0, f"빈 묶음마다 트리 기본 표시가 남습니다: {measured['noItems']}"
        assert measured["pane"] is not None and measured["toolbar"] is not None, measured
        assert line["rect"]["top"] >= measured["toolbar"]["bottom"] - 1, (
            f"빈 안내가 도구 막대 아래가 아닙니다: {line} vs {measured['toolbar']}")
        assert line["rect"]["left"] >= measured["pane"]["left"] - 1 and line["rect"]["right"] <= measured["pane"]["right"] + 1, (
            "빈 안내가 목록 칸 가로 범위를 벗어납니다")
        for sec in measured["sections"]:
            assert sec["rows"] == 0, f"빈 묶음에 트리 행이 남습니다: {sec}"
            assert sec["noItems"] == 0, f"빈 묶음에 기본 빈 표시가 남습니다: {sec}"
        assert len(measured["sections"]) >= 2, f"빈 묶음 머리가 사라졌습니다: {measured['sections']}"
        return measured
    finally:
        latest = read_storage("items")
        if latest is not None:
            call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                                       "content": snapshot, "expected_revision": latest["revision"]})
        wait_for(lambda: win.locator('button[role="treeitem"]').count() > 0, "표본 되돌리기", timeout=20)


check("empty_store", empty_store_check)

# 시험 쉘은 시나리오보다 먼저 --app을 열어, 자산 등록 전이라 앱 올리기가 실패해 있다.
# 마지막에 같은 정의로 다시 올려 결과의 앱 보고를 성공으로 맞춘다(같은 정의라 unchanged).
reopened = sb.upload_and_open(definition)
assert reopened.get("window_id"), f"앱 창을 다시 확인하지 못했습니다: {reopened}"

results["window_size"] = {"width": definition["window_size"]["width"], "height": definition["window_size"]["height"]}
results["today"] = TODAY.isoformat()
results["problems"] = problems
(OUT / "todo-scenario.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
log("확인 끝", json.dumps(results, ensure_ascii=False))
if problems:
    raise AssertionError("확인 실패 " + str(len(problems)) + "건: " + " | ".join(problems))
