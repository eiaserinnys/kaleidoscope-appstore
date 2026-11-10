"""할 일 앱 정의를 로컬 시험 쉘에서 실제 조작으로 확인한다.

3판(카드 87b15ec1)의 확인 항목과 2판 회귀를 순서대로 수행한다. 시험 쉘은 정의만
올리므로 store.json의 자산을 먼저 등록하고, 저장 항목을 채운 뒤 창을 다시 연다.
날짜가 든 표본은 실행일 기준으로 계산한다(todo-sample.json의 date/done은 일 오프셋).

3판에서 더한 확인: 구역 +와 하위 할 일 추가가 대화상자 대신 목록 안 글칸을 열고
Escape·빈 Enter가 아무것도 쓰지 않는지, Enter가 저장소에 넣고 그 행을 고르는지.
행 메뉴 첫 항목의 이름 바꾸기가 전체 선택된 글칸을 열고 Enter로 저장하는지.
끌어 옮기기(앞, 안, 다른 묶음 끝)가 저장소의 parent·area·order를 바꾸고 화면 순서도
따라가는지. 구역 이름 바꾸기가 areas와 모든 항목의 area를 함께 바꾸고, 중복 이름이면
알림만 내고 쓰지 않는지. 빈 묶음의 「없음」 자리에 놓아도 그 묶음으로 옮겨지는지.
접힌 구역과 접힌 부모에 새 행이 생기면 쉘이 펼쳐 글칸을 보이는지, 구역 이름을
바꾼 뒤 초점과 스크롤이 어디로 가는지는 수치를 남긴다(앱에서 우회하지 않는다).

끌기는 브라우저의 실제 끌기 이벤트를 이어 보낸다. Playwright의 포인터 흉내는 머리 없는
Chromium에서 dragover·drop을 보내지 않으므로, 쉘 E2E와 같이 dragstart·dragover·drop을
직접 보내고 표시를 찍기 직전에 목표 자리에서 1px 흔든 dragover를 한 번 더 보낸다.
확인은 check()로 모아 두었다가 마지막에 한꺼번에 실패로 알린다. 고치기 전 정의로 돌려
어느 확인이 실패하는지 한 번에 보기 위해서다.
"""

import base64
import hashlib
import json
import re
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
# 이름 확정 확인에서 쓰기 응답을 늦춰, 고치기 전 코드의 되돌림 프레임을 놓치지 않고 잡는다.
write_delay = {"entries": set(), "seconds": 0.0}
# 쓰기 실패 재현용 다리: fail_writes에 entry가 있으면 storage.write를 500으로 끊는다.
# core_route는 불러오기 화면을 잡느라 쓰고 453행에서 떼므로, 실패 재현 단계에서만 따로 건다.
fail_writes = set()


def fail_route(route):
    try:
        req = json.loads(route.request.post_data or "")
    except Exception:  # noqa: BLE001
        req = {}
    if isinstance(req, dict) and req.get("op") == "storage.write" and req.get("entry") in fail_writes:
        route.fulfill(status=500, content_type="application/json",
                      body=json.dumps({"error": {"code": "internal", "message": "시나리오용 쓰기 실패"}}))
        return
    route.continue_()


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
    if (isinstance(req, dict) and write_delay["seconds"] > 0
            and req.get("op") == "storage.write" and req.get("entry") in write_delay["entries"]):
        time.sleep(write_delay["seconds"])
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


FOCUS_JS = """() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "body";
  return {
    tree: el.getAttribute('data-tree-id'),
    label: el.getAttribute('aria-label'),
    text: (el.textContent || '').trim().slice(0, 30),
  };
}"""

SCROLL_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  return [...root.querySelectorAll('*')].filter((el) => {
    const style = getComputedStyle(el);
    return el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
  }).map((el) => ({cls: String(el.className).slice(0, 60), top: Math.round(el.scrollTop),
                   max: el.scrollHeight - el.clientHeight}));
}"""

# 행 이름 확정 뒤 매 프레임의 행 글을 모은다. 고치기 전 코드는 쓰기가 끝나기 전 옛 이름을
# 편집 꺼진 행으로 한동안 보여 주므로, 그 프레임이 있는지로 판정한다.
RENAME_FRAME_JS = """(key) => {
  window.__renameFrames = [];
  window.__renameDone = false;
  const stop = performance.now() + 2000;
  const tick = () => {
    const root = document.querySelector('[data-testid="app-window-todo"]');
    const row = root ? root.querySelector('button[data-tree-id="item:' + key + '"]') : null;
    const name = row ? row.querySelector('.ks-tree-name') : null;
    const input = row ? row.querySelector('input[aria-label="항목 이름"]') : null;
    window.__renameFrames.push({
      name: name ? name.textContent.trim() : null,
      editing: !!input,
      value: input ? input.value : null,
    });
    if (performance.now() < stop) requestAnimationFrame(tick);
    else window.__renameDone = true;
  };
  requestAnimationFrame(tick);
}"""

# 구역 머리 목록을 매 프레임 모은다. 편집 중인 머리는 제목 요소 대신 글칸이라 빠진다.
AREA_FRAME_JS = """() => {
  window.__areaFrames = [];
  window.__areaDone = false;
  const stop = performance.now() + 2200;
  const tick = () => {
    const root = document.querySelector('[data-testid="app-window-todo"]');
    const titles = root ? [...root.querySelectorAll('section.ks-data-section[data-ks-block$="/template"] .ks-data-section-title')] : [];
    window.__areaFrames.push(titles.map((el) => el.textContent.trim()));
    if (performance.now() < stop) requestAnimationFrame(tick);
    else window.__areaDone = true;
  };
  requestAnimationFrame(tick);
}"""

AREA_FOCUS_JS = """() => {
  const el = document.activeElement;
  if (!el || el === document.body) return {tag: "body"};
  const section = el.closest('section.ks-data-section[data-ks-block$="/template"]');
  const title = section ? section.querySelector('.ks-data-section-title') : null;
  return {
    tag: el.tagName,
    label: el.getAttribute('aria-label'),
    expanded: el.getAttribute('aria-expanded'),
    cls: String(el.className).slice(0, 80),
    section: title ? title.textContent.trim() : null,
    in_header: !!(section && el.closest('.ks-data-section-header')),
  };
}"""


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


# ── 0. 정의 검사: preview_app이 돌려주는 경고와 실패한 식이 없어야 한다 ──

def preview_check():
    preview = call("preview_app", {"definition": definition})
    failed = [value for value in preview.get("values", []) if value.get("status") == "failed"]
    log("preview_app", json.dumps({
        "warnings": preview.get("warnings", []),
        "notes": preview.get("notes", []),
        "failed": failed[:3],
    }, ensure_ascii=False)[:1500])
    assert not preview.get("warnings"), f"경고: {preview['warnings']}"
    assert not failed, f"실패한 식: {failed[:3]}"
    return {"warnings": [], "values": len(preview.get("values", []))}


check("preview_app", preview_check)


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

# ── 1. 첫 화면(2판 기본: 완료한 일 숨김): 묶음 구역, 보이는 트리, 보류 배지, meta ──

wait_for(lambda: win.locator('button[role="treeitem"]').count() > 0, "트리 행이 그려짐")
expect(section("업무")).to_be_visible(timeout=15000)
expect(section("개인")).to_be_visible(timeout=15000)
expect(row("t-report")).to_be_visible()   # 끝낸 자손은 숨고, 보이는 자손이 있어 조상은 남는다
expect(row("t-draft")).to_be_visible()
expect(row("t-quote")).to_be_visible()
expect(row("t-milk")).to_be_visible()
expect(row("t-soap")).to_be_visible()
expect(row("t-collect")).to_have_count(0)   # 끝낸 항목은 그리지 않는다
expect(row("t-eggs")).to_have_count(0)
expect(row("t-passport")).to_have_count(0)
expect(row("t-library")).to_have_count(0)

expect(row("t-quote").locator(".ks-badge")).to_have_text("보류")
expect(row("t-room").locator(".ks-view-meta")).to_have_text("내일")
expect(row("t-draft").locator(".ks-view-meta")).to_have_text("팀장 검토")

toggle = win.get_by_role("switch", name="완료한 일 숨기기", exact=True)
expect(toggle).to_be_visible()
expect(toggle).to_have_attribute("aria-checked", "true")
expect(win.get_by_role("button", name="묶음 추가", exact=True)).to_be_visible()

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
results["wide"] = "ok"

# 2. 같은 화면 어두움
page.emulate_media(color_scheme="dark")
time.sleep(0.8)
sb.shot("wide-dark.png", "todo", settle=0.3)
page.emulate_media(color_scheme="light")
time.sleep(0.5)

# 1(이어서). 좁은 창 380에서도 구역과 트리가 그려진다.
set_size(380, 700)
expect(section("업무")).to_be_visible(timeout=15000)
expect(row("t-draft")).to_be_visible()
expect(row("t-collect")).to_have_count(0)
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

# 기록 보기에서는 숨김 토글이 잠긴다.
expect(toggle).to_be_disabled()
expect(toggle).to_have_attribute("aria-checked", "true")
results["log_toggle_locked"] = "ok"


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
for name in ("wide-light.png", "wide-dark.png", "log-wide.png"):
    size = (OUT / name).stat().st_size
    assert size <= 2 * 1024 * 1024, f"{name}이 2MiB를 넘습니다: {size}"
results["log_screenshot"] = "ok"

def log_day_keeps_selection():
    before = current_window()["state"]["selected"]
    assert before == "t-collect", before
    day_groups().filter(has_text="오늘").first.click()
    page.wait_for_timeout(500)
    after = current_window()["state"]["selected"]
    assert after == before, f"날짜 행을 눌러 선택이 바뀌었습니다: {before} → {after}"
    expect(win.get_by_label("제목", exact=True)).to_have_value("자료 모으기")
    expect(row("t-collect")).to_have_attribute("aria-selected", "true")
    sb.shot("log-day-selection.png", "todo", settle=0.3)
    return {"before": before, "after": after}


check("log_day_keeps_selection", log_day_keeps_selection)

win.get_by_role("button", name="할 일", exact=True).click()
expect(section("업무")).to_be_visible()


def clears_to_open():
    expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_be_visible(timeout=10000)


check("view_change_clears_log_selection", clears_to_open)

# ── 2. 숨김 끔: 1판처럼 끝낸 항목이 취소선으로 제자리에 남는다 ──

toggle.click()
expect(toggle).to_have_attribute("aria-checked", "false")
wait_for(lambda: row("t-collect").count() > 0, "숨김 끔에서 끝낸 항목이 보임")
expect(row("t-collect").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
expect(row("t-collect").locator(".ks-tree-name")).to_have_css("text-decoration-line", re.compile("line-through"))
expect(row("t-collect").locator(".ks-view-meta")).to_have_text("어제")
expect(row("t-eggs")).to_be_visible()
# 6일·13일 전에 끝낸 항목은 기록 보기에만 있고 할 일 보기에는 원래 없다.
expect(row("t-passport")).to_have_count(0)
expect(row("t-library")).to_have_count(0)
sb.shot("hide-off.png", "todo", settle=0.4)
results["hide_off"] = "ok"

# 1판 회귀: 숨김을 끈 상태에서 체크와 되돌리기가 제자리에서 동작한다.
check_span("t-milk").click()
wait_for(lambda: (item_now("t-milk") or {}).get("status") == "done", "t-milk 끝냄 저장")
assert item_now("t-milk")["done_on"] == TODAY.isoformat(), item_now("t-milk")
expect(row("t-milk").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
check_span("t-milk").click()
wait_for(lambda: (item_now("t-milk") or {}).get("status") == "open", "t-milk 되돌림 저장")
assert item_now("t-milk")["done_on"] is None, item_now("t-milk")
expect(row("t-milk").locator(".ks-tree-name")).not_to_have_class(re.compile("is-checked"))
results["check_toggle"] = "ok"

# ── 3. 숨김 켬: 체크하면 목록에서 사라지고, 마지막 자식을 끝내면 부모도 끝나며, 상세는 남는다 ──

toggle.click()
expect(toggle).to_have_attribute("aria-checked", "true")
wait_for(lambda: row("t-collect").count() == 0, "숨김 켬에서 끝낸 항목이 숨음")

row("t-draft").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("초안 쓰기", timeout=10000)
check_span("t-draft").click()
wait_for(lambda: (item_now("t-draft") or {}).get("status") == "done", "t-draft 끝냄 저장")
wait_for(lambda: (item_now("t-report") or {}).get("status") == "done", "부모 t-report 끝냄 저장")
wait_for(lambda: row("t-draft").count() == 0 and row("t-report").count() == 0,
         "끝낸 항목이 목록에서 사라짐")
assert current_window()["state"]["selected"] == "t-draft", current_window()["state"]
expect(win.get_by_label("제목", exact=True)).to_have_value("초안 쓰기")
expect(win.get_by_role("button", name="지우기", exact=True)).to_be_visible()
sb.shot("hide-check.png", "todo", settle=0.4)
results["hide_check_keeps_detail"] = "ok"

# 기록 보기에서 되돌리면 부모까지 다시 열리고 할 일 보기에 제자리로 돌아온다.
win.get_by_role("button", name="기록", exact=True).click()
wait_for(lambda: row("t-draft").count() > 0, "기록 보기의 끝낸 t-draft", timeout=15)
expect(row("t-report").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
check_span("t-draft").click()
wait_for(lambda: (item_now("t-draft") or {}).get("status") == "open", "기록 보기에서 t-draft 되돌림")
wait_for(lambda: (item_now("t-report") or {}).get("status") == "open", "부모 t-report 되돌림")
win.get_by_role("button", name="할 일", exact=True).click()
expect(row("t-report")).to_be_visible(timeout=10000)
expect(row("t-draft")).to_be_visible()
expect(row("t-draft").locator(".ks-tree-name")).not_to_have_class(re.compile("is-checked"))
results["parent_auto_done_and_reopen"] = "ok"

# ── 4. 앱 안 묶음 추가: 줄 단추 → 초점 글칸 → Esc 취소 → Enter 추가 → 새 빈 구역 ──

areas_before = read_storage("areas")["content"]
assert areas_before == ["업무", "개인"], areas_before

add_area_button = win.get_by_role("button", name="묶음 추가", exact=True)
expect(add_area_button).to_be_visible()
add_area_button.click()
area_input = win.get_by_label("새 묶음", exact=True)
expect(area_input).to_be_visible(timeout=10000)
# 이름표 「새 묶음」이 화면에 보이고, 자리 표시는 「묶음 이름」이다(2판 반려 반영).
expect(win.get_by_text("새 묶음", exact=True).first).to_be_visible()
expect(area_input).to_have_attribute("placeholder", "묶음 이름")
assert area_input.evaluate("el => document.activeElement === el"), "묶음 추가 글칸에 초점이 없습니다"
expect(add_area_button).to_have_count(0)
sb.shot("area-input.png", "todo", settle=0.4)

area_input.press("Escape")
expect(area_input).to_have_count(0, timeout=10000)
expect(add_area_button).to_be_visible(timeout=10000)
assert read_storage("areas")["content"] == areas_before, "Esc 취소가 묶음을 썼습니다"
results["area_cancel"] = "ok"

add_area_button.click()
area_input = win.get_by_label("새 묶음", exact=True)
expect(area_input).to_be_visible(timeout=10000)
area_input.fill("독서")
area_input.press("Enter")
wait_for(lambda: read_storage("areas")["content"] == ["업무", "개인", "독서"], "새 묶음 저장", timeout=15)
expect(area_input).to_have_count(0)
expect(section("독서")).to_be_visible(timeout=10000)
expect(section("독서").locator('button[role="treeitem"]')).to_have_count(0)
sb.shot("area-added.png", "todo", settle=0.4)
results["area_add"] = "ok"


def area_rejects(name, label):
    win.get_by_role("button", name="묶음 추가", exact=True).click()
    field = win.get_by_label("새 묶음", exact=True)
    expect(field).to_be_visible(timeout=10000)
    if name:
        field.fill(name)
    field.press("Enter")
    expect(field).to_have_count(0, timeout=10000)
    stored = read_storage("areas")["content"]
    assert stored == ["업무", "개인", "독서"], f"{label} 뒤 묶음: {stored}"
    expect(win.get_by_role("button", name="묶음 추가", exact=True)).to_be_visible()


check("area_empty", lambda: area_rejects("", "빈 이름"))
check("area_duplicate", lambda: area_rejects(" 업무 ", "중복 이름"))

# ── 5. 앱 설정 화면: 「묶음」에 이름을 넣고 「묶음 추가」를 눌러 새 구역이 생기는지 본다 ──


def app_settings_check():
    settings_heading = win.get_by_role("heading", name="앱 설정", exact=True)
    win.get_by_role("button", name="앱 설정", exact=True).click()
    try:
        expect(settings_heading).to_be_visible(timeout=10000)
        # 앱 설정의 글칸과 단추가 같은 이름이라 역할로 구분한다.
        field = win.get_by_role("textbox", name="묶음 추가", exact=True)
        expect(field).to_be_visible(timeout=10000)
        sb.shot("app-settings.png", "todo", settle=0.4)
        field.fill("취미")
        add_button = win.get_by_role("button", name="묶음 추가", exact=True)
        expect(add_button).to_be_enabled(timeout=10000)
        add_button.click()
        wait_for(lambda: "취미" in (read_storage("areas") or {}).get("content", []),
                 "앱 설정에서 묶음 저장", timeout=15)
    finally:
        back = win.get_by_role("button", name="앱으로 돌아가기", exact=True)
        if back.count() > 0:
            back.first.click()
    expect(settings_heading).to_be_hidden(timeout=10000)
    expect(section("취미")).to_be_visible(timeout=15000)
    sb.shot("app-settings-applied.png", "todo", settle=0.4)
    stored = read_storage("areas")["content"]
    assert stored == ["업무", "개인", "독서", "취미"], stored
    return {"areas": stored}


check("app_settings_add_area", app_settings_check)

# ── 4. 구역 + → 목록 안 글칸 → Escape 취소 → Enter로 추가 → 새 항목이 고른 상태 ──

INLINE_INPUT = 'input[aria-label="항목 이름"]'
inline_items_before = items_now()


def draft_place(area):
    """바로 입력 행이 구역 트리의 마지막 행인지, 초점이 그 글칸에 있는지 잰다."""
    return page.evaluate("""(area) => {
      const sections = [...document.querySelectorAll('section.ks-data-section[data-ks-block$="/template"]')];
      const found = sections.find((section) => {
        const title = section.querySelector('.ks-data-section-title');
        return title && title.textContent.trim() === area;
      });
      const tree = found ? found.querySelector('.ks-data-tree') : null;
      if (!tree) return {error: '트리 없음'};
      const input = tree.querySelector('input[aria-label="항목 이름"]');
      if (!input) return {error: '글칸 없음'};
      const holder = input.closest('.ks-tree-virtual-row');
      const rows = [...tree.querySelectorAll('.ks-tree-virtual-row')];
      const rect = (el) => { const b = el.getBoundingClientRect(); return {top: +b.top.toFixed(1), height: +b.height.toFixed(1)}; };
      return {
        isLastRow: holder === rows[rows.length - 1],
        holder: rect(holder),
        rowCount: rows.length,
        focused: document.activeElement === input,
        value: input.value,
      };
    }""", area)


def open_area_draft():
    section("업무").locator('button[aria-label="할 일 추가"]').click()
    field = win.locator(INLINE_INPUT)
    expect(field).to_be_visible(timeout=10000)
    return field


def inline_add_field():
    field = open_area_draft()
    assert page.locator('[role="dialog"]').count() == 0, "바로 더하기가 대화상자를 열었습니다"
    place = draft_place("업무")
    assert place.get("isLastRow"), f"글칸 행이 구역의 마지막 행이 아닙니다: {place}"
    assert place["focused"], f"바로 더하기 글칸에 초점이 없습니다: {place}"
    assert place["value"] == "", place
    sb.shot("add-inline-field.png", "todo", settle=0.3)
    field.press("Escape")
    expect(field).to_have_count(0, timeout=10000)
    assert read_storage("items")["content"] == inline_items_before, "Escape 취소가 항목을 썼습니다"
    sb.shot("add-inline-cancel.png", "todo", settle=0.2)
    return place


check("inline_add_area_field", inline_add_field)


def inline_add_empty_enter():
    field = open_area_draft()
    field.press("Enter")
    expect(field).to_have_count(0, timeout=10000)
    assert read_storage("items")["content"] == inline_items_before, "빈 Enter가 항목을 썼습니다"


check("inline_add_empty_enter", inline_add_empty_enter)


def inline_add_enter():
    field = open_area_draft()
    field.fill("창고 정리")
    sb.shot("add-inline-typing.png", "todo", settle=0.2)
    field.press("Enter")
    expect(field).to_have_count(0, timeout=10000)
    added = wait_for(lambda: next((it for it in items_now() if it.get("title") == "창고 정리"), None), "바로 더하기 저장")
    assert added["area"] == "업무" and added["parent"] is None, added
    assert added["status"] == "open" and added["date"] is None, added
    assert added["order"] == 6, added
    expect(row(added["id"])).to_be_visible()
    expect(row(added["id"])).to_have_attribute("aria-selected", "true")
    expect(win.get_by_label("제목", exact=True)).to_have_value("창고 정리")
    sb.shot("add-after-enter.png", "todo", settle=0.3)
    return added["id"]


check("inline_add_enter", inline_add_enter)


def inline_add_write_fail():
    # 세라피엘 재현: 목록 안 더하기를 확정할 때 items 쓰기를 500으로 끊는다.
    # 고치기 전에는 저장되지 않은 draft 행이 보통 행으로 남는다(유령 행).
    page.route("**/core", fail_route)
    fail_writes.add("items")
    try:
        field = open_area_draft()
        field.fill("유령 시험")
        started = time.time()
        field.press("Enter")
        ghost = win.locator('button[data-tree-id]',
                            has=page.locator('.ks-tree-name', has_text="유령 시험"))
        samples = []
        notice_at = None
        while time.time() - started < 4:
            now = time.time() - started
            samples.append([round(now, 2), ghost.count(),
                            page.get_by_text("SHELL_HTTP_REQUEST_FAILED").count()])
            if notice_at is None and samples[-1][2]:
                notice_at = now
            if notice_at is not None and now - notice_at >= 1.0:
                break
            page.wait_for_timeout(100)
    finally:
        fail_writes.discard("items")
        page.unroute("**/core", fail_route)
    assert notice_at is not None, f"쓰기 실패 알림이 뜨지 않았습니다: {samples[-8:]}"
    within = [sample for sample in samples if notice_at <= sample[0] <= notice_at + 1.0]
    assert within and within[-1][1] == 0, (
        f"실패 알림 뒤 1초 안에 유령 행이 사라지지 않았습니다: {samples[-10:]}")
    assert ghost.count() == 0, "쓰기에 실패한 행이 화면에 남아 있습니다"
    assert not any(it.get("title") == "유령 시험" for it in items_now()), "저장에 실패한 항목이 저장소에 있습니다"
    sb.shot("add-fail-after.png", "todo", settle=0.3)
    # 실패 알림은 저절로 사라지지 않고 누르는 것을 가로막으므로, 확인을 마친 뒤 닫는다.
    notice_box = win.locator(".ks-data-window-notice")
    if notice_box.get_by_text("SHELL_HTTP_REQUEST_FAILED").count():
        notice_box.get_by_role("button", name="닫기").click()
        expect(win.get_by_text("SHELL_HTTP_REQUEST_FAILED")).to_have_count(0, timeout=5000)
    return {"notice_at": round(notice_at, 2), "samples": samples[::2], "last": samples[-1]}


check("inline_add_write_fail", inline_add_write_fail)

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

# ── 행 메뉴: 하위 할 일 추가 → 목록 안 글칸 → Escape 취소 → Enter로 자식 추가 ──


def open_item_menu(item_id):
    row(item_id).click(button="right")
    menu = page.get_by_role("menu")
    expect(menu).to_be_visible(timeout=10000)
    return menu


def child_draft_place():
    """하위 글칸 행이 t-soap 행 바로 뒤에 서는지, 초점과 값을 잰다."""
    return win.evaluate("""() => {
      const root = document.querySelector('[data-testid="app-window-todo"]');
      const sections = [...root.querySelectorAll('section.ks-data-section[data-ks-block$="/template"]')];
      const found = sections.find((section) => {
        const title = section.querySelector('.ks-data-section-title');
        return title && title.textContent.trim() === '개인';
      });
      const tree = found ? found.querySelector('.ks-data-tree') : null;
      if (!tree) return {error: '개인 트리 없음'};
      const input = tree.querySelector('input[aria-label="항목 이름"]');
      if (!input) return {error: '글칸 없음'};
      const holder = input.closest('.ks-tree-virtual-row');
      const rows = [...tree.querySelectorAll('.ks-tree-virtual-row')];
      const soap = tree.querySelector('button[data-tree-id="item:t-soap"]');
      const soapHolder = soap ? soap.closest('.ks-tree-virtual-row') : null;
      const index = rows.indexOf(holder);
      const soapIndex = rows.indexOf(soapHolder);
      return {
        index: index, soapIndex: soapIndex, rowCount: rows.length,
        directlyAfterSoap: soapIndex >= 0 && index === soapIndex + 1,
        focused: document.activeElement === input,
        value: input.value,
      };
    }""")


def child_add_field():
    menu = open_item_menu("t-soap")
    labels = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
    assert labels[:1] == ["이름 바꾸기"], f"행 메뉴 첫 항목이 이름 바꾸기가 아닙니다: {labels}"
    for label in ("하위 할 일 추가", "보류", "지우기"):
        assert label in labels, f"행 메뉴에 {label}이 없습니다: {labels}"
    menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
    field = win.locator(INLINE_INPUT)
    expect(field).to_be_visible(timeout=10000)
    assert page.locator('[role="dialog"]').count() == 0, "하위 추가가 대화상자를 열었습니다"
    place = child_draft_place()
    assert place.get("directlyAfterSoap"), f"하위 글칸이 t-soap 다음 행이 아닙니다: {place}"
    assert place["focused"], f"하위 글칸에 초점이 없습니다: {place}"
    assert place["value"] == "", place
    sb.shot("child-add-field.png", "todo", settle=0.3)
    return place


check("child_add_field", child_add_field)


def child_add_escape_keeps():
    before = items_now()
    menu = open_item_menu("t-soap")
    menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
    field = win.locator(INLINE_INPUT)
    expect(field).to_be_visible(timeout=10000)
    field.fill("세탁 예약")
    field.press("Escape")
    expect(field).to_have_count(0, timeout=10000)
    assert items_now() == before, "하위 글칸 Escape 취소가 항목을 썼습니다"


check("child_add_escape_keeps", child_add_escape_keeps)


def child_add_enter():
    menu = open_item_menu("t-soap")
    menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
    field = win.locator(INLINE_INPUT)
    expect(field).to_be_visible(timeout=10000)
    field.fill("세탁")
    field.press("Enter")
    expect(field).to_have_count(0, timeout=10000)
    added = wait_for(lambda: next((it for it in items_now() if it.get("title") == "세탁"), None), "하위 할 일 저장")
    assert added["parent"] == "t-soap" and added["area"] == "개인", added
    assert added["status"] == "open" and added["date"] is None, added
    assert added["order"] == 0, added
    expect(row(added["id"])).to_be_visible()
    expect(row(added["id"])).to_have_attribute("aria-selected", "true")
    expect(win.get_by_label("제목", exact=True)).to_have_value("세탁")
    return {"parent": added["parent"], "area": added["area"], "order": added["order"]}


check("child_add_enter", child_add_enter)

# ── 행 메뉴의 이름 바꾸기: 전체 선택된 글칸 → Escape 취소 → Enter로 저장 ──


def rename_field_state():
    return win.evaluate("""() => {
      const input = document.querySelector('[data-testid="app-window-todo"] input[aria-label="항목 이름"]');
      if (!input) return {error: '글칸 없음'};
      return {
        focused: document.activeElement === input,
        start: input.selectionStart,
        end: input.selectionEnd,
        value: input.value,
      };
    }""")


def inline_item_rename_field():
    menu = open_item_menu("t-soap")
    labels = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
    assert labels[0] == "이름 바꾸기", f"행 메뉴 첫 항목이 이름 바꾸기가 아닙니다: {labels}"
    menu.get_by_role("menuitem", name="이름 바꾸기", exact=True).click()
    field = win.locator(INLINE_INPUT)
    expect(field).to_be_visible(timeout=10000)
    assert page.locator('[role="dialog"]').count() == 0, "이름 바꾸기가 대화상자를 열었습니다"
    expect(field).to_have_value("세제")
    state = rename_field_state()
    assert state["focused"], f"이름 글칸에 초점이 없습니다: {state}"
    assert state["start"] == 0 and state["end"] == 2, f"이름이 전체 선택되지 않았습니다: {state}"
    sb.shot("rename-item-field.png", "todo", settle=0.3)
    field.fill("버릴 이름")
    field.press("Escape")
    expect(field).to_have_count(0, timeout=10000)
    assert (item_now("t-soap") or {}).get("title") == "세제", "Escape가 이름을 썼습니다"
    return state


check("inline_item_rename_field", inline_item_rename_field)


def inline_item_rename_enter():
    # 상세 칸 제목이 같이 바뀌는지 보려면 바꿀 항목이 골라져 있어야 한다.
    row("t-soap").click()
    expect(win.get_by_label("제목", exact=True)).to_have_value("세제", timeout=10000)
    menu = open_item_menu("t-soap")
    menu.get_by_role("menuitem", name="이름 바꾸기", exact=True).click()
    field = win.locator(INLINE_INPUT)
    expect(field).to_be_visible(timeout=10000)
    field.fill("  세제 리필  ")
    page.evaluate(RENAME_FRAME_JS, "t-soap")
    # 쓰기 응답을 늦춰, 고치기 전 코드가 옛 이름으로 되돌리는 프레임을 확실히 잡는다.
    write_delay.update(entries={"items"}, seconds=0.6)
    try:
        field.press("Enter")
        page.wait_for_function("() => window.__renameDone === true", timeout=15000)
    finally:
        write_delay.update(entries=set(), seconds=0.0)
    frames = page.evaluate("() => window.__renameFrames")
    reverted = [frame for frame in frames if not frame["editing"] and frame["name"] == "세제"]
    assert not reverted, f"Enter 뒤 옛 이름이 편집 꺼진 채 보인 프레임이 있습니다: {reverted[:3]}"
    after = [frame for frame in frames if not frame["editing"] and frame["name"] == "세제 리필"]
    assert after, f"새 이름이 편집 꺼진 행으로 보인 프레임이 없습니다: {frames[-5:]}"
    editing = [frame for frame in frames if frame["editing"]]
    log("이름 확정 프레임 표본", json.dumps({
        "frames": len(frames), "editing": len(editing), "after": len(after),
        "editing_values": sorted({frame["value"] for frame in editing}),
    }, ensure_ascii=False))
    expect(field).to_have_count(0, timeout=10000)
    renamed = wait_for(lambda: item_now("t-soap") if (item_now("t-soap") or {}).get("title") == "세제 리필" else None,
                       "이름 저장")
    expect(row("t-soap").locator(".ks-tree-name")).to_have_text("세제 리필")
    assert renamed["area"] == "개인" and renamed["parent"] == "t-shop", renamed
    assert renamed["status"] == "open", renamed
    expect(win.get_by_label("제목", exact=True)).to_have_value("세제 리필")
    return {"title": renamed["title"], "frames": len(frames), "editing_frames": len(editing)}


check("inline_item_rename_enter", inline_item_rename_enter)

# ── 접힌 구역·접힌 부모에서 새 행이 보이는지: 관찰만 하고 보고에 적는다 ──


def collapsed_add_observation():
    observation = {}
    toggle = section("업무").locator("button.ks-data-section-toggle")
    expect(toggle).to_be_visible(timeout=10000)
    toggle.click()
    expect(toggle).to_have_attribute("aria-expanded", "false", timeout=10000)
    expect(section("업무").locator('button[role="treeitem"]')).to_have_count(0, timeout=10000)
    section("업무").locator('button[aria-label="할 일 추가"]').click()
    page.wait_for_timeout(500)
    field = win.locator(INLINE_INPUT)
    # 쉘 #549부터 접힌 구역에 새 행이 생기면 머리의 같은 동작 단추를 눌러 스스로 펼친다.
    observation["collapsed_section_expanded"] = toggle.get_attribute("aria-expanded")
    observation["collapsed_section_field_visible"] = field.count() > 0 and field.first.is_visible()
    observation["collapsed_section_focus"] = page.evaluate(FOCUS_JS)
    sb.shot("collapsed-section-add.png", "todo", settle=0.2)
    assert observation["collapsed_section_expanded"] == "true", f"접힌 구역이 새 글칸과 함께 펼쳐지지 않았습니다: {observation}"
    assert observation["collapsed_section_field_visible"], f"새 글칸이 보이지 않습니다: {observation}"
    if field.count():
        field.first.press("Escape")
        expect(field).to_have_count(0, timeout=10000)

    chevron = row("t-shop").locator(".ks-tree-chevron-trigger")
    expect(chevron).to_be_visible(timeout=10000)
    chevron.click()
    expect(row("t-soap")).to_have_count(0, timeout=10000)
    menu = open_item_menu("t-shop")
    menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
    page.wait_for_timeout(500)
    observation["collapsed_parent_expanded"] = row("t-soap").count() > 0
    observation["collapsed_parent_field_visible"] = field.count() > 0 and field.first.is_visible()
    observation["collapsed_parent_focus"] = page.evaluate(FOCUS_JS)
    sb.shot("collapsed-parent-add.png", "todo", settle=0.2)
    assert observation["collapsed_parent_expanded"], f"접힌 부모가 새 글칸과 함께 펼쳐지지 않았습니다: {observation}"
    assert observation["collapsed_parent_field_visible"], f"하위 글칸이 보이지 않습니다: {observation}"
    if field.count():
        field.first.press("Escape")
        expect(field).to_have_count(0, timeout=10000)
    log("접힘 관찰", json.dumps(observation, ensure_ascii=False))
    return observation


check("collapsed_add_observation", collapsed_add_observation)

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

# ── 10-1. 좁은 창에서 3판 글칸과 구역 메뉴가 창 안에 선다 ──


def narrow_inline_fields():
    set_size(380, 700)
    captured = {}
    box = window_box()
    try:
        field = open_area_draft()
        captured["area_field_box"] = field.first.bounding_box()
        sb.shot("narrow-inline-field.png", "todo", settle=0.3)
        field.press("Escape")
        expect(field).to_have_count(0, timeout=10000)

        menu = open_item_menu("t-report")
        menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
        child_field = win.locator(INLINE_INPUT)
        expect(child_field).to_be_visible(timeout=10000)
        captured["child_field_box"] = child_field.first.bounding_box()
        sb.shot("narrow-child-add-field.png", "todo", settle=0.3)
        child_field.press("Escape")
        expect(child_field).to_have_count(0, timeout=10000)

        menu = open_item_menu("t-report")
        menu.get_by_role("menuitem", name="이름 바꾸기", exact=True).click()
        rename_field = win.locator(INLINE_INPUT)
        expect(rename_field).to_be_visible(timeout=10000)
        expect(rename_field).to_have_value("분기 보고서")
        captured["item_rename_box"] = rename_field.first.bounding_box()
        sb.shot("narrow-item-rename.png", "todo", settle=0.3)
        rename_field.press("Escape")
        expect(rename_field).to_have_count(0, timeout=10000)

        section("업무").locator(".ks-data-section-title").click(button="right")
        area_menu = page.get_by_role("menu")
        expect(area_menu).to_be_visible(timeout=10000)
        expect(area_menu.get_by_role("menuitem", name="이름 바꾸기", exact=True)).to_be_visible()
        captured["area_menu_box"] = area_menu.bounding_box()
        sb.shot("narrow-area-menu.png", "todo", settle=0.3)
        area_menu.get_by_role("menuitem", name="이름 바꾸기", exact=True).click()
        area_field = win.get_by_role("textbox", name="구역 이름", exact=True)
        expect(area_field).to_be_visible(timeout=10000)
        expect(area_field).to_have_value("업무")
        captured["area_rename_box"] = area_field.bounding_box()
        sb.shot("narrow-area-rename.png", "todo", settle=0.3)
        area_field.press("Escape")
        expect(area_field).to_have_count(0, timeout=10000)
        assert read_storage("areas")["content"] == ["업무", "개인", "독서", "취미"], read_storage("areas")["content"]
    finally:
        set_size(1040, 700)
    for name, rect in captured.items():
        if rect is None:
            raise AssertionError(f"{name} 좌표 없음")
        assert (rect["x"] >= box["x"] - 1 and rect["y"] >= box["y"] - 1
                and rect["x"] + rect["width"] <= box["x"] + box["width"] + 1
                and rect["y"] + rect["height"] <= box["y"] + box["height"] + 1), (
            f"{name}가 좁은 창 밖입니다: {rect} vs {box}")
    return {name: {key: round(value, 1) for key, value in rect.items()} for name, rect in captured.items()}


check("narrow_inline_fields", narrow_inline_fields)

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

# ── 5. 빈 저장소: 묶음마다 빈 트리(「없음」)를 그려 놓을 자리를 두고, 목록 자리에 빈 안내 한 줄만 둔다 ──

EMPTY_MEASURE_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  if (!root) return {error: "창 없음"};
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1)};
  };
  const glyph = (el) => {
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const b = range.getBoundingClientRect();
    return {top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1)};
  };
  const tokens = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    return {paddingBlockStart: +parseFloat(style.paddingBlockStart).toFixed(1),
            paddingInlineStart: +parseFloat(style.paddingInlineStart).toFixed(1)};
  };
  const pane = root.querySelector(".ks-split-pane");
  const stack = pane ? pane.querySelector(".ks-data-stack") : null;
  const stackItems = stack ? [...stack.children].filter((el) => el.classList.contains("ks-data-stack-item")) : [];
  const repeat = pane ? pane.querySelector(".ks-data-view.ks-repeat") : null;
  const line = [...root.querySelectorAll(".ks-data-text")].find((el) => el.textContent.includes("할 일이 없습니다")) || null;
  const hintSection = line ? line.closest("section.ks-data-section") : null;
  const headerText = (el) => {
    const node = el.querySelector(".ks-data-section-header");
    return node ? node.textContent.trim() : "";
  };
  return {
    pane: rect(pane),
    toolbar: rect(root.querySelector(".ks-data-toolbar")),
    stackItems: stackItems.map((el) => ({cls: el.className, flex: getComputedStyle(el).flex, rect: rect(el)})),
    repeat: repeat ? {cls: repeat.className, rect: rect(repeat), scroll: repeat.scrollHeight, client: repeat.clientHeight} : null,
    hintSection: hintSection ? {rect: rect(hintSection), padding: tokens(hintSection)} : null,
    sections: [...root.querySelectorAll('section.ks-data-section[data-ks-block$="/template"]')].map((el) => {
      const toggle = el.querySelector(".ks-data-section-toggle");
      const titleEl = el.querySelector(".ks-data-section-title");
      const metaEl = el.querySelector(".ks-data-section-meta");
      return {
        title: headerText(el),
        rect: rect(el),
        header: rect(el.querySelector(".ks-data-section-header")),
        toggle: rect(toggle),
        chevron: rect(toggle ? toggle.querySelector("svg") : null),
        titleEl: rect(titleEl),
        titleGlyph: glyph(titleEl),
        metaText: metaEl ? metaEl.textContent.trim() : null,
        child: rect(el.querySelector(".ks-data-section-child")),
        rows: el.querySelectorAll('button[role="treeitem"]').length,
        noItems: el.querySelectorAll(".ks-no-items").length,
      };
    }),
    noItems: root.querySelectorAll(".ks-no-items").length,
    line: line ? {text: line.textContent.trim(), cls: line.className, rect: rect(line), glyph: glyph(line)} : null,
  };
}"""


def empty_summary(measured):
    """보고에 쓰는 값만 추린다: 구분선(도구 막대 아래)과 안내 글의 거리, 시작선. """
    line = measured.get("line") or {}
    toolbar = measured.get("toolbar") or {}
    sections = measured.get("sections") or []
    first = sections[0] if sections else {}
    line_rect = line.get("rect")
    line_glyph = line.get("glyph")
    title_glyph = first.get("titleGlyph")
    return {
        "toolbar_bottom": toolbar.get("bottom"),
        "hint_element_top": line_rect.get("top") if line_rect else None,
        "hint_glyph_top": line_glyph.get("top") if line_glyph else None,
        "divider_to_element": round(line_rect["top"] - toolbar["bottom"], 1) if line_rect and toolbar else None,
        "divider_to_glyph": round(line_glyph["top"] - toolbar["bottom"], 1) if line_glyph and toolbar else None,
        "hint_left": line_rect.get("left") if line_rect else None,
        "hint_glyph_left": line_glyph.get("left") if line_glyph else None,
        "hint_section": measured.get("hintSection"),
        "first_group_title": first.get("title"),
        "first_group_title_left": title_glyph.get("left") if title_glyph else None,
        "first_group_title_top": title_glyph.get("top") if title_glyph else None,
        "first_group_chevron": first.get("chevron"),
        "first_group_child_left": (first.get("child") or {}).get("left"),
        "hint_left_to_group_title_left": round(title_glyph["left"] - line_glyph["left"], 1) if title_glyph and line_glyph else None,
        "group_count": len(sections),
    }


def empty_store_check():
    current_items = read_storage("items")
    snapshot = current_items["content"]
    measured = {}
    try:
        call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                                   "content": [], "expected_revision": current_items["revision"]})
        wait_for(lambda: win.get_by_text("할 일이 없습니다. +로 더하세요").count() > 0,
                 "빈 목록 안내 한 줄", timeout=10)
        wait_for(lambda: win.locator('button[role="treeitem"]').count() == 0,
                 "빈 저장소에 트리 행 없음", timeout=10)
        time.sleep(0.6)
        measured["wide"] = win.evaluate(EMPTY_MEASURE_JS)
        expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_have_count(0)
        sb.shot("empty-wide.png", "todo", settle=0.3)
        page.emulate_media(color_scheme="dark")
        time.sleep(0.8)
        sb.shot("empty-wide-dark.png", "todo", settle=0.3)
        page.emulate_media(color_scheme="light")
        time.sleep(0.4)
        set_size(380, 700)
        time.sleep(1.2)
        measured["narrow"] = win.evaluate(EMPTY_MEASURE_JS)
        expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_have_count(0)
        sb.shot("empty-narrow.png", "todo", settle=0.3)

        win.get_by_role("button", name="기록", exact=True).click()
        expect(win.get_by_text("끝낸 할 일이 없습니다")).to_be_visible(timeout=10000)
        for label, width in (("narrow", 380), ("wide", 1040)):
            set_size(width, 700)
            expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_have_count(0)
            expect(win.locator(".ks-no-items")).to_have_count(0)
            line = win.get_by_text("끝낸 할 일이 없습니다")
            expect(line).to_have_class(re.compile("is-meta"))
            bounds = line.evaluate("""el => {
              const rect = el.getBoundingClientRect();
              const pane = el.closest('.ks-split-pane').getBoundingClientRect();
              const toolbar = el.closest('.ks-split-pane').querySelector('.ks-data-toolbar').getBoundingClientRect();
              return {line: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom},
                      pane: {left: pane.left, right: pane.right, bottom: pane.bottom}, toolbarBottom: toolbar.bottom};
            }""")
            center = (bounds["line"]["top"] + bounds["line"]["bottom"]) / 2
            pane_center = (bounds["toolbarBottom"] + bounds["pane"]["bottom"]) / 2
            assert abs(center - pane_center) <= 2, f"{label}: 기록 빈 안내가 칸 가운데가 아닙니다: {bounds}"
            line_center_x = (bounds["line"]["left"] + bounds["line"]["right"]) / 2
            pane_center_x = (bounds["pane"]["left"] + bounds["pane"]["right"]) / 2
            assert abs(line_center_x - pane_center_x) <= 2, f"{label}: 기록 빈 안내가 가로 가운데가 아닙니다: {bounds}"
            assert bounds["pane"]["left"] <= bounds["line"]["left"] <= bounds["line"]["right"] <= bounds["pane"]["right"], bounds
            measured["log_" + label] = bounds
            sb.shot("log-empty-" + label + ".png", "todo", settle=0.3)
    finally:
        set_size(1040, 700)
        win.get_by_role("button", name="할 일", exact=True).click()
        time.sleep(0.4)
        latest = read_storage("items")
        if latest is not None:
            call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                                       "content": snapshot, "expected_revision": latest["revision"]})
        wait_for(lambda: win.locator('button[role="treeitem"]').count() > 0, "표본 되돌리기", timeout=20)
    log("빈 안내 계측 넓은 창", json.dumps(empty_summary(measured["wide"]), ensure_ascii=False))
    log("빈 안내 계측 좁은 창", json.dumps(empty_summary(measured["narrow"]), ensure_ascii=False))

    wide = measured["wide"]
    narrow = measured["narrow"]
    line = wide.get("line")
    assert line is not None, f"빈 안내 줄을 찾지 못했습니다: {wide}"
    assert line["text"] == "할 일이 없습니다. +로 더하세요", line
    assert "is-meta" in line["cls"], line
    assert wide["noItems"] == len(wide["sections"]), (
        f"빈 묶음마다 놓을 자리(「없음」)가 하나씩 있지 않습니다: {wide['noItems']} vs {len(wide['sections'])}")
    assert wide["pane"] is not None and wide["toolbar"] is not None, wide
    gap = round(line["rect"]["top"] - wide["toolbar"]["bottom"], 1)
    assert 7 <= gap <= 9, (
        f"구분선과 빈 안내 top의 거리가 표준 간격 단계(space-2 = 8)가 아닙니다: {gap}px, {line} vs {wide['toolbar']}")
    section = wide.get("hintSection")
    assert section is not None, f"빈 안내가 안쪽 여백을 주는 칸 안에 있지 않습니다: {line}"
    inset = round(line["rect"]["left"] - section["rect"]["left"], 1)
    assert abs(inset - section["padding"]["paddingInlineStart"]) <= 1, (
        f"빈 안내가 칸의 안쪽 여백(space-3)을 받지 않았습니다: {inset} vs {section}")
    block_inset = round(line["rect"]["top"] - section["rect"]["top"], 1)
    assert abs(block_inset - section["padding"]["paddingBlockStart"]) <= 1, (
        f"빈 안내 top이 칸의 위쪽 여백(space-2)과 다릅니다: {block_inset} vs {section}")
    for sec in wide["sections"]:
        assert sec["rows"] == 0, f"빈 묶음에 트리 행이 남습니다: {sec}"
        assert sec["noItems"] == 1, f"빈 묶음에 놓을 자리(「없음」)가 하나가 아닙니다: {sec}"
    assert len(wide["sections"]) >= 2, f"빈 묶음 머리가 사라졌습니다: {wide['sections']}"
    group = wide["sections"][0]
    assert group["child"] is not None and abs(line["rect"]["left"] - group["child"]["left"]) <= 1, (
        f"빈 안내 시작선이 묶음 내용의 시작선과 다릅니다: {line} vs {group}")
    assert (line["rect"]["left"] >= wide["pane"]["left"] - 1
            and line["rect"]["right"] <= wide["pane"]["right"] + 1), "빈 안내가 목록 칸 가로 범위를 벗어납니다"

    narrow_line = narrow.get("line")
    assert narrow_line is not None, f"좁은 창에서 빈 안내가 사라졌습니다: {narrow}"
    narrow_gap = round(narrow_line["rect"]["top"] - narrow["toolbar"]["bottom"], 1)
    assert 7 <= narrow_gap <= 9, (
        f"좁은 창에서 구분선과 빈 안내 top의 거리가 표준 간격 단계가 아닙니다: {narrow_gap}px, {narrow_line} vs {narrow['toolbar']}")
    narrow_section = narrow.get("hintSection")
    assert narrow_section is not None, f"좁은 창에서 빈 안내가 칸의 안쪽 여백을 받지 않습니다: {narrow_line}"
    assert abs((narrow_line["rect"]["left"] - narrow_section["rect"]["left"])
               - narrow_section["padding"]["paddingInlineStart"]) <= 1, (
        f"좁은 창에서 빈 안내가 칸의 안쪽 여백을 받지 않았습니다: {narrow_line} vs {narrow_section}")
    assert (narrow_line["rect"]["left"] >= narrow["pane"]["left"] - 1
            and narrow_line["rect"]["right"] <= narrow["pane"]["right"] + 1), "좁은 창에서 빈 안내가 목록 칸 가로 범위를 벗어납니다"
    assert len(narrow["sections"]) >= 2, f"좁은 창에서 빈 묶음 머리가 사라졌습니다: {narrow['sections']}"
    for sec in narrow["sections"]:
        assert sec["rows"] == 0, f"좁은 창의 빈 묶음에 트리 행이 남습니다: {sec}"
        assert sec["noItems"] == 1, f"좁은 창의 빈 묶음에 놓을 자리가 하나가 아닙니다: {sec}"
    return measured


check("empty_store", empty_store_check)

# ── 12. 긴 목록 끝에서 묶음 추가: Enter, Escape, 포인터로 초점 잃기 ──

# 표본 항목을 더해 목록을 창보다 길게 만든다(중립 자료, 시나리오 안에서만).
# 글칸을 닫으면 초점이 첫 트리 행으로 가고 칸이 맨 위로 튀는 것은 쉘 결함이다(카드의 같은
# 다른 세션이 쉘에서 고친다). 그래서 이 확인은 저장소 값과 글칸 닫힘만 단언하고, 그 화면은
# 그대로 찍어 남긴다. 초점과 스크롤 값은 보고에 쓰려고 기록만 한다.

TO_BOTTOM_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  [...root.querySelectorAll('*')].filter((el) => {
    const style = getComputedStyle(el);
    return el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
  }).forEach((el) => { el.scrollTop = el.scrollHeight; });
}"""

def long_list_check():
    items_snapshot = read_storage("items")
    areas_snapshot = read_storage("areas")
    root_orders = [it["order"] for it in items_snapshot["content"]
                   if it["area"] == "개인" and it["parent"] is None]
    extras = [{
        "id": f"t-extra-{n}",
        "title": f"표본 할 일 {n + 1}",
        "area": "개인",
        "parent": None,
        "status": "open",
        "date": None,
        "wait": None,
        "done_on": None,
        "created_on": on_day(-30),
        "order": max(root_orders, default=-1) + 1 + n,
    } for n in range(12)]
    captured = {}

    def scroll_bottom():
        win.evaluate(TO_BOTTOM_JS)
        page.wait_for_timeout(400)

    def open_area_field():
        win.get_by_role("button", name="묶음 추가", exact=True).click()
        field = win.get_by_label("새 묶음", exact=True)
        expect(field).to_be_visible(timeout=10000)
        return field

    def snap_state():
        return {"focus": page.evaluate(FOCUS_JS), "scroll": win.evaluate(SCROLL_JS)}

    def flow_enter(label, width, name):
        set_size(width, 700)
        scroll_bottom()
        sb.shot(f"long-{label}-bottom.png", "todo", settle=0.3)
        field = open_area_field()
        field.fill(name)
        sb.shot(f"long-{label}-input.png", "todo", settle=0.3)
        field.press("Enter")
        wait_for(lambda: read_storage("areas")["content"][-1] == name, f"{label}: 묶음 저장", timeout=15)
        expect(field).to_have_count(0, timeout=10000)
        page.wait_for_timeout(800)
        captured[f"{label}_enter"] = snap_state()
        sb.shot(f"long-{label}-enter.png", "todo", settle=0.2)
        log(f"{label} Enter 뒤", json.dumps(captured[f"{label}_enter"], ensure_ascii=False))

    def flow_escape(label, width, name):
        set_size(width, 700)
        scroll_bottom()
        field = open_area_field()
        field.fill(name)
        before = read_storage("areas")["content"]
        field.press("Escape")
        expect(field).to_have_count(0, timeout=10000)
        page.wait_for_timeout(800)
        assert read_storage("areas")["content"] == before, f"{label}: Escape가 묶음을 썼습니다"
        captured[f"{label}_escape"] = snap_state()
        sb.shot(f"long-{label}-escape.png", "todo", settle=0.2)
        log(f"{label} Escape 뒤", json.dumps(captured[f"{label}_escape"], ensure_ascii=False))

    def flow_blur(label, width, name):
        set_size(width, 700)
        scroll_bottom()
        field = open_area_field()
        field.fill(name)
        before = read_storage("areas")["content"]
        row("t-extra-11").click()
        page.wait_for_timeout(800)
        assert read_storage("areas")["content"] == before, f"{label}: 초점을 잃을 때 묶음을 썼습니다"
        captured[f"{label}_blur"] = {"field_open": field.count() > 0, **snap_state()}
        sb.shot(f"long-{label}-blur.png", "todo", settle=0.2)
        log(f"{label} 초점 잃은 뒤", json.dumps(captured[f"{label}_blur"], ensure_ascii=False))
        # 뒤처리: 열린 글칸을 Escape로 닫는다(블록이 초점을 잃을 때 닫았다면 그대로 둔다).
        if field.count():
            field.click()
            field.press("Escape")
            expect(field).to_have_count(0, timeout=10000)

    def flow_narrow_enter_five():
        # 좁은 창에서 「묶음 추가」를 Enter로 다섯 번 확정한다. 매번 초점이 새 묶음 머리 단추에
        # 가고, Enter 앞뒤로 스크롤 수치가 제자리인지 본다.
        set_size(380, 700)
        metrics = []
        for step in range(1, 6):
            name = f"반복{step}"
            scroll_bottom()
            field = open_area_field()
            field.fill(name)
            page.wait_for_timeout(250)
            before = win.evaluate(SCROLL_JS)
            field.press("Enter")
            wait_for(lambda: read_storage("areas")["content"][-1] == name, f"반복{step}: 묶음 저장", timeout=15)
            expect(field).to_have_count(0, timeout=10000)
            page.wait_for_timeout(800)
            focus = page.evaluate(AREA_FOCUS_JS)
            after = win.evaluate(SCROLL_JS)
            before_tops = {entry["cls"]: entry["top"] for entry in before}
            after_tops = {entry["cls"]: entry["top"] for entry in after}
            moved = {cls: [top, after_tops.get(cls)] for cls, top in before_tops.items()
                     if after_tops.get(cls) is None or abs(after_tops[cls] - top) > 2}
            sample = {"step": step, "name": name, "focus": focus, "before": before, "after": after}
            captured[f"narrow_enter_{step}"] = sample
            metrics.append(sample)
            log(f"좁은 창 묶음 추가 {step}번째", json.dumps(sample, ensure_ascii=False))
            sb.shot(f"long-narrow-enter-{step}.png", "todo", settle=0.2)
            assert focus.get("section") == name, f"반복{step}: Enter 뒤 초점이 새 묶음 머리에 없습니다: {focus}"
            assert focus.get("in_header"), f"반복{step}: Enter 뒤 초점이 머리 안이 아닙니다: {focus}"
            assert "ks-data-section-toggle" in (focus.get("cls") or ""), (
                f"반복{step}: Enter 뒤 초점이 머리 접기 단추가 아닙니다: {focus}")
            assert focus.get("expanded") == "true", f"반복{step}: 새 묶음 머리가 펼쳐져 있지 않습니다: {focus}"
            assert not moved, f"반복{step}: Enter 뒤 스크롤이 움직였습니다: {moved}"
        captured["narrow_enter_5"] = metrics
        return metrics

    try:
        call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                                   "content": items_snapshot["content"] + extras,
                                   "expected_revision": items_snapshot["revision"]})
        wait_for(lambda: row("t-extra-11").count() > 0, "긴 목록 그려짐", timeout=15)
        flow_enter("wide", 1040, "운동")
        flow_escape("wide", 1040, "산책")
        flow_blur("wide", 1040, "공부")
        flow_narrow_enter_five()
        flow_escape("narrow", 380, "낚시")
        flow_blur("narrow", 380, "청소")
    finally:
        set_size(1040, 700)
        win.get_by_role("button", name="할 일", exact=True).click()
        time.sleep(0.4)
        latest = read_storage("items")
        call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                                   "content": items_snapshot["content"],
                                   "expected_revision": latest["revision"]})
        latest_areas = read_storage("areas")
        call("write_app_storage", {"app_id": "todo", "entry_id": "areas",
                                   "content": areas_snapshot["content"],
                                   "expected_revision": latest_areas["revision"]})
        wait_for(lambda: row("t-extra-0").count() == 0, "긴 목록 되돌리기", timeout=20)
    return captured


check("long_list_area_flows", long_list_check)

# ── 13. 끌어 옮기기: 앞·안·다른 묶음 끝 ──
# Playwright의 포인터 흉내는 머리 없는 Chromium에서 dragover·drop을 보내지 않는다.
# 쉘 E2E와 같이 dragstart·dragover·drop·dragend를 직접 보내고, 표시를 찍기 직전에
# 목표 자리에서 1px 흔든 dragover를 한 번 더 보낸다.

DRAG_JS = """(cmd) => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  const rowEl = (key) => root.querySelector('button[data-tree-id="item:' + key + '"]');
  const treeEl = (area) => {
    const sections = [...root.querySelectorAll('section.ks-data-section[data-ks-block$="/template"]')];
    const found = sections.find((section) => {
      const title = section.querySelector('.ks-data-section-title');
      return title && title.textContent.trim() === area;
    });
    return found ? found.querySelector('.ks-data-tree') : null;
  };
  if (cmd.action === 'start') {
    const source = rowEl(cmd.key);
    if (!source) return {error: 'source 없음: ' + cmd.key};
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer: dataTransfer}));
    window.__ksDrag = {source: source, dataTransfer: dataTransfer};
    return {ok: true};
  }
  const drag = window.__ksDrag;
  if (!drag) return {error: '끌기 없음'};
  const target = cmd.target ? rowEl(cmd.target) : treeEl(cmd.area);
  if (!target) return {error: 'target 없음: ' + (cmd.target || cmd.area)};
  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const dy = cmd.dy || 0;
  const clientY = cmd.target ? rect.top + rect.height * cmd.ratio + dy : rect.bottom - 2 + dy;
  if (cmd.action === 'over') {
    target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer, clientX: clientX, clientY: clientY}));
    return {ok: true, clientY: +clientY.toFixed(1), top: +rect.top.toFixed(1), height: +rect.height.toFixed(1)};
  }
  if (cmd.action === 'drop') {
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer, clientX: clientX, clientY: clientY}));
    drag.source.dispatchEvent(new DragEvent('dragend', {bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer}));
    window.__ksDrag = null;
    return {ok: true};
  }
  return {error: '알 수 없는 동작: ' + cmd.action};
}"""

INDICATOR_JS = """() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  return [...root.querySelectorAll('[data-drop-state], [data-drop-position]')].map((el) => ({
    id: el.getAttribute('data-tree-id') || el.getAttribute('role'),
    state: el.getAttribute('data-drop-state'),
    position: el.getAttribute('data-drop-position'),
  }));
}"""


def drag_move(source, target=None, area=None, ratio=0.5, shot=None):
    source_row = row(source)
    assert source_row.count() > 0, f"끌 항목 {source} 행이 없습니다"
    source_row.first.scroll_into_view_if_needed(timeout=5000)
    started = page.evaluate(DRAG_JS, {"action": "start", "key": source})
    assert started.get("ok"), started
    first = page.evaluate(DRAG_JS, {"action": "over", "target": target, "area": area, "ratio": ratio, "dy": 1})
    assert first.get("ok"), first
    page.wait_for_timeout(120)
    second = page.evaluate(DRAG_JS, {"action": "over", "target": target, "area": area, "ratio": ratio, "dy": 0})
    assert second.get("ok"), second
    page.wait_for_timeout(180)
    indicators = page.evaluate(INDICATOR_JS)
    if shot:
        sb.shot(shot, "todo", settle=0.2)
    dropped = page.evaluate(DRAG_JS, {"action": "drop", "target": target, "area": area, "ratio": ratio})
    assert dropped.get("ok"), dropped
    page.wait_for_timeout(200)
    return indicators


def row_top(item_id):
    box = row(item_id).bounding_box()
    assert box is not None, f"{item_id} 좌표 없음"
    return round(box["y"], 1)


def drag_before():
    indicators = drag_move("t-keys", target="t-room", ratio=0.1, shot="drag-before.png")
    assert any(m["position"] == "before" and m["id"] == "item:t-room" for m in indicators), (
        f"앞에 놓기 표시가 없습니다: {indicators}")
    keys = wait_for(lambda: item_now("t-keys") if (item_now("t-keys") or {}).get("order") == 2 else None,
                    "t-keys 앞으로 옮기기 저장")
    assert keys["parent"] is None and keys["area"] == "업무", keys
    report = item_now("t-report")
    room = item_now("t-room")
    assert report["order"] == 1 and room["order"] == 3, (report, room)
    tops = {key: row_top(key) for key in ("t-report", "t-keys", "t-room", "t-quote")}
    assert tops["t-report"] < tops["t-keys"] < tops["t-room"] < tops["t-quote"], tops
    expect(section("업무").locator('button[data-tree-id="item:t-keys"]')).to_be_visible()
    sb.shot("drag-after-before.png", "todo", settle=0.3)
    return {"orders": {"t-report": 1, "t-keys": 2, "t-room": 3}, "tops": tops}


check("drag_before", drag_before)


def drag_inside():
    indicators = drag_move("t-shop", target="t-report", ratio=0.5, shot="drag-inside.png")
    valid = [m for m in indicators if m["id"] == "item:t-report" and m["state"] == "valid"]
    assert valid, f"안에 놓기 표시가 없습니다: {indicators}"
    shop = wait_for(lambda: item_now("t-shop") if (item_now("t-shop") or {}).get("parent") == "t-report" else None,
                    "t-shop 안으로 옮기기 저장")
    assert shop["area"] == "업무" and shop["order"] == 3, shop
    kids = {key: item_now(key) for key in ("t-collect", "t-draft")}
    assert kids["t-collect"]["order"] == 1 and kids["t-draft"]["order"] == 2, kids
    # t-shop의 자손 전체(자식과 손자 세탁)가 함께 묶음을 옮겼는지 본다.
    current = items_now()
    by_parent = {}
    for entry in current:
        by_parent.setdefault(entry.get("parent"), []).append(entry)
    descendants = []
    queue = list(by_parent.get("t-shop", []))
    while queue:
        entry = queue.pop(0)
        descendants.append(entry)
        queue.extend(by_parent.get(entry["id"], []))
    direct = sorted(by_parent.get("t-shop", []), key=lambda it: it["order"])
    assert [it["id"] for it in direct] == ["t-milk", "t-eggs", "t-soap"], direct
    assert all(it["area"] == "업무" for it in descendants), descendants
    added = next(it for it in descendants if it.get("title") == "세탁")
    assert added["parent"] == "t-soap" and added["area"] == "업무", added
    tops = {key: row_top(key) for key in ("t-report", "t-shop", "t-keys")}
    assert tops["t-report"] < tops["t-shop"] < tops["t-keys"], tops
    sb.shot("drag-after-inside.png", "todo", settle=0.3)
    return {"orders": {"t-shop": shop["order"]}, "child_areas": [it["area"] for it in descendants]}


check("drag_inside", drag_inside)


def drag_other_area_end():
    indicators = drag_move("t-dentist", area="업무", shot="drag-other-area-end.png")
    assert any(m["state"] == "valid" and m["id"] == "tree" for m in indicators), (
        f"다른 묶음 끝 표시가 없습니다: {indicators}")
    dentist = wait_for(lambda: item_now("t-dentist") if (item_now("t-dentist") or {}).get("area") == "업무" else None,
                       "다른 묶음 끝으로 옮기기 저장")
    assert dentist["parent"] is None and dentist["order"] == 8, dentist
    assert row_top("t-dentist") > row_top("t-quote"), (row_top("t-dentist"), row_top("t-quote"))
    expect(section("개인").locator('button[role="treeitem"]')).to_have_count(0, timeout=10000)
    sb.shot("drag-after-end.png", "todo", settle=0.3)
    return {"t-dentist": {"area": dentist["area"], "parent": dentist["parent"], "order": dentist["order"]}}


check("drag_other_area_end", drag_other_area_end)


def drag_empty_area_end():
    # 다른 묶음 끝으로 t-dentist를 옮긴 뒤 개인 구역은 비어 있다. 이제 빈 트리의 「없음」이
    # 놓을 자리로 그려지는지 보고, 자식이 있는 t-shop을 그 자리에 끌어 놓는다.
    empty = section("개인")
    expect(empty.locator(".ks-no-items")).to_be_visible(timeout=10000)
    expect(empty.locator('button[role="treeitem"]')).to_have_count(0)
    empty.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    sb.shot("empty-area-light.png", "todo", settle=0.3)
    page.emulate_media(color_scheme="dark")
    time.sleep(0.8)
    sb.shot("empty-area-dark.png", "todo", settle=0.3)
    page.emulate_media(color_scheme="light")
    time.sleep(0.4)
    indicators = drag_move("t-shop", area="개인", shot="drag-empty-area.png")
    assert any(m["state"] == "valid" and m["id"] == "tree" for m in indicators), (
        f"빈 묶음 놓을 자리 표시가 없습니다: {indicators}")
    shop = wait_for(lambda: item_now("t-shop") if (item_now("t-shop") or {}).get("area") == "개인" else None,
                    "빈 묶음 끝으로 옮기기 저장")
    assert shop["parent"] is None, shop
    current = items_now()
    by_parent = {}
    for entry in current:
        by_parent.setdefault(entry.get("parent"), []).append(entry)
    descendants = []
    queue = list(by_parent.get("t-shop", []))
    while queue:
        entry = queue.pop(0)
        descendants.append(entry)
        queue.extend(by_parent.get(entry["id"], []))
    direct = sorted(by_parent.get("t-shop", []), key=lambda it: it["order"])
    assert [it["id"] for it in direct] == ["t-milk", "t-eggs", "t-soap"], direct
    assert all(it["area"] == "개인" for it in descendants), descendants
    added = next(it for it in descendants if it.get("title") == "세탁")
    assert added["area"] == "개인" and added["parent"] == "t-soap", added
    expect(empty.locator(".ks-no-items")).to_have_count(0, timeout=10000)
    expect(row("t-shop")).to_be_visible(timeout=10000)
    assert row_top("t-shop") < row_top("t-milk") < row_top("t-soap"), (
        row_top("t-shop"), row_top("t-milk"), row_top("t-soap"))
    sb.shot("drag-empty-area-after.png", "todo", settle=0.3)
    return {"t-shop": {"area": shop["area"], "parent": shop["parent"], "order": shop["order"]},
            "descendant_areas": sorted({it["area"] for it in descendants})}


check("drag_empty_area_end", drag_empty_area_end)

# ── 14. 구역 머리 우클릭 → 이름 바꾸기 → areas와 모든 항목 area를 함께 바꾼다 ──


def area_rename():
    title = section("업무").locator(".ks-data-section-title")
    expect(title).to_be_visible(timeout=10000)
    title.click(button="right")
    menu = page.get_by_role("menu")
    expect(menu).to_be_visible(timeout=10000)
    labels = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
    assert labels[0] == "이름 바꾸기", f"구역 메뉴 첫 항목이 이름 바꾸기가 아닙니다: {labels}"
    sb.shot("area-menu.png", "todo", settle=0.3)
    menu.get_by_role("menuitem", name="이름 바꾸기", exact=True).click()
    field = win.get_by_role("textbox", name="구역 이름", exact=True)
    expect(field).to_be_visible(timeout=10000)
    expect(field).to_have_value("업무")
    state = win.evaluate("""() => {
      const input = document.querySelector('[data-testid="app-window-todo"] input[aria-label="구역 이름"]');
      if (!input) return {error: '글칸 없음'};
      return {focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, value: input.value};
    }""")
    assert state["focused"], f"구역 이름 글칸에 초점이 없습니다: {state}"
    assert state["start"] == 0 and state["end"] == 2, f"구역 이름이 전체 선택되지 않았습니다: {state}"
    sb.shot("area-rename-field.png", "todo", settle=0.3)
    before_areas = read_storage("areas")["content"]
    field.fill("직장")
    field.press("Enter")
    # Enter 뒤 1초 넘게 머리 목록을 매 프레임 읽어, 옛 이름과 새 이름이 함께 보이는 순간이 없는지 본다.
    page.evaluate(AREA_FRAME_JS)
    # 두 쓰기(areas, items)를 늦춰, 고치기 전 코드가 중간 이름을 그리는 프레임을 놓치지 않고 잡는다.
    write_delay.update(entries={"areas", "items"}, seconds=0.45)
    try:
        page.wait_for_function("() => window.__areaDone === true", timeout=15000)
    finally:
        write_delay.update(entries=set(), seconds=0.0)
    frames = page.evaluate("() => window.__areaFrames")
    assert frames, "구역 머리 목록을 한 프레임도 읽지 못했습니다"
    stale = [frame for frame in frames if "업무" in frame]
    assert not stale, f"Enter 뒤 옛 이름이 머리에 남은 프레임이 있습니다: {stale[:3]}"
    doubled = [frame for frame in frames if frame.count("직장") > 1]
    assert not doubled, f"Enter 뒤 새 이름 구역이 둘로 보인 프레임이 있습니다: {doubled[:3]}"
    renamed_frames = [frame for frame in frames if "직장" in frame]
    assert renamed_frames, f"Enter 뒤 새 이름이 머리에 보인 프레임이 없습니다: {frames[-5:]}"
    seen = {}
    for frame in frames:
        key = tuple(frame)
        seen[key] = seen.get(key, 0) + 1
    samples = [[list(key), count] for key, count in sorted(seen.items(), key=lambda pair: -pair[1])[:4]]
    log("묶음 이름 확정 머리 목록 표본", json.dumps({"frames": len(frames), "samples": samples}, ensure_ascii=False))
    expect(field).to_have_count(0, timeout=10000)
    areas = wait_for(lambda: read_storage("areas")["content"] if read_storage("areas")["content"][:2] == ["직장", "개인"] else None,
                     "구역 이름 저장", timeout=15)
    assert areas == ["직장", "개인", "독서", "취미"], areas
    items = wait_for(lambda: items_now() if all(it.get("area") != "업무" for it in items_now()) else None,
                     "항목 area 함께 바꾸기", timeout=15)
    assert all(it.get("area") in ("직장", "개인", "독서", "취미") for it in items), [it for it in items if it.get("area") not in ("직장", "개인", "독서", "취미")]
    # 묶음 이름은 areas와 items 두 번에 나눠 쓰므로, 그 사이에는 옛 구역이 pending 이름을
    # 단 채 잠깐 남는다. 두 구역이 같은 이름을 보이는 순간을 지나 하나로 정리될 때까지 기다린다.
    wait_for(lambda: section("직장").count() == 1, "구역 머리 하나로 정리", timeout=15)
    expect(section("직장").locator(".ks-data-section-title")).to_be_visible(timeout=10000)
    expect(section("업무")).to_have_count(0, timeout=10000)
    heads = [text.strip() for text in win.locator('section.ks-data-section[data-ks-block$="/template"] .ks-data-section-title').all_inner_texts()]
    assert heads == ["직장", "개인", "독서", "취미"], f"묶음 이름 바꾼 뒤 머리 순서가 다릅니다: {heads}"
    page.wait_for_timeout(600)
    focus = page.evaluate(FOCUS_JS)
    scroll = win.evaluate(SCROLL_JS)
    sb.shot("area-rename-after.png", "todo", settle=0.3)
    row("t-report").click()
    expect(win.get_by_label("제목", exact=True)).to_have_value("분기 보고서", timeout=10000)
    expect(win.locator('button.ks-select-button[aria-label="묶음"]')).to_contain_text("직장")
    log("구역 이름 바꾼 뒤 초점", json.dumps(focus, ensure_ascii=False))
    log("구역 이름 바꾼 뒤 스크롤", json.dumps(scroll, ensure_ascii=False))
    return {"areas": before_areas, "after": areas, "focus": focus, "scroll": scroll,
            "heads": heads, "frames": len(frames), "samples": samples}


check("area_rename", area_rename)


def area_rename_duplicate():
    title = section("직장").locator(".ks-data-section-title")
    expect(title).to_be_visible(timeout=10000)
    title.click(button="right")
    menu = page.get_by_role("menu")
    expect(menu).to_be_visible(timeout=10000)
    menu.get_by_role("menuitem", name="이름 바꾸기", exact=True).click()
    field = win.get_by_role("textbox", name="구역 이름", exact=True)
    expect(field).to_be_visible(timeout=10000)
    areas_before = read_storage("areas")["content"]
    items_before = items_now()
    field.fill("개인")
    field.press("Enter")
    expect(field).to_have_count(0, timeout=10000)
    notice = win.get_by_text("같은 이름의 묶음이 이미 있습니다").first
    expect(notice).to_be_visible(timeout=5000)
    sb.shot("area-rename-duplicate.png", "todo", settle=0.2)
    assert read_storage("areas")["content"] == areas_before, "중복 이름이 묶음 목록을 바꿨습니다"
    assert items_now() == items_before, "중복 이름이 항목 area를 바꿨습니다"
    # 쉘은 앱이 커밋한 이름을 받아들이지 않아도 그 이름을 pending으로 계속 머리에 보여 준다.
    # 앱 쪽 확인 항목은 저장소 불변과 알림이므로, 표시 상태는 관찰로만 남긴다.
    headers = [text.strip() for text in win.locator('section.ks-data-section[data-ks-block$="/template"] .ks-data-section-title').all_inner_texts()]
    log("중복 이름 뒤 구역 머리 표시", json.dumps(headers, ensure_ascii=False))
    return {"notice": notice.inner_text(), "headers": headers}


check("area_rename_duplicate", area_rename_duplicate)

# 시험 쉘은 시나리오보다 먼저 --app을 열어, 자산 등록 전이라 앱 올리기가 실패해 있다.
# 마지막에 같은 정의로 다시 올려 결과의 앱 보고를 성공으로 맞춘다(같은 정의라 unchanged).
reopened = sb.upload_and_open(definition)
assert reopened.get("window_id"), f"앱 창을 다시 확인하지 못했습니다: {reopened}"

results["window_size"] = {"width": definition["window_size"]["width"], "height": definition["window_size"]["height"]}
results["today"] = TODAY.isoformat()
results["problems"] = problems
(OUT / "todo-scenario.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
log("확인 끝", json.dumps({"results": len(results), "problems": len(problems)}, ensure_ascii=False))
if problems:
    raise AssertionError("확인 실패 " + str(len(problems)) + "건: " + " | ".join(problems))
