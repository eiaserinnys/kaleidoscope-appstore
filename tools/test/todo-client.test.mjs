import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET = resolve(HERE, "../../apps/todo/assets/todo-client.javascript");

const ACTIONS = [
  "check", "select_log", "add", "edit", "toggle_hold", "remove",
  "open_add_area", "open_add_child", "dialog_title", "dialog_date", "dialog_close",
];

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const clone = plain;

function local(year, month, day, hour = 9, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function item(id, over = {}) {
  return {
    id,
    title: id,
    area: "업무",
    parent: null,
    status: "open",
    date: null,
    wait: null,
    done_on: null,
    created_on: "2026-11-01",
    order: 0,
    ...over,
  };
}

/** 자산 파일을 vm에서 실행하고, 가짜 window.kaleidoscope로 조작하는 시험용 껍데기. */
function boot({ now = local(2026, 11, 9), items = [], areas = ["업무", "개인"], view = "open", selected = null, hold = false, hideDone = false } = {}) {
  const source = readFileSync(ASSET, "utf8");
  const clock = { now };
  const timers = new Map();
  const store = { items: clone(items), areas: clone(areas) };
  const writes = [];
  const attempts = [];
  const publishes = [];
  const notices = [];
  const statePatches = [];
  const handlers = new Map();
  const stateListeners = new Set();
  const lifecycleListeners = new Set();
  const storageListeners = new Map();
  const win = { view, selected, adding: null, hide_done: hideDone };
  const reads = {};
  let lifecycle = null;
  let holding = hold;
  let sequence = 1;
  let queue = Promise.resolve();
  const conflicts = [];
  let failure = null;
  let readFailure = null;
  const gates = [];

  const bridge = {
    getState(key) { return key === undefined ? { ...win } : win[key]; },
    setState(key, value) {
      const patch = clone(typeof key === "string" ? { [key]: value } : key);
      Object.assign(win, patch);
      statePatches.push(clone(patch));
    },
    onStateChange(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    onStorageChange(entry, listener, onError) {
      const set = storageListeners.get(entry) ?? new Map();
      set.set(listener, onError);
      storageListeners.set(entry, set);
      return () => set.delete(listener);
    },
    onLifecycle(listener) { lifecycleListeners.add(listener); if (lifecycle) listener(lifecycle); return () => lifecycleListeners.delete(listener); },
    getStorage(entry) {
      return later(async () => {
        if (holding) {
          let release;
          const promise = new Promise(done => { release = done; });
          gates.push(release);
          await promise;
        }
        reads[entry] = (reads[entry] ?? 0) + 1;
        if (readFailure && (!readFailure.entry || readFailure.entry === entry)) {
          const error = readFailure.error;
          readFailure = null;
          throw error;
        }
        return clone(store[entry]);
      });
    },
    setStorage(entry, content) {
      attempts.push({ entry, content: clone(content) });
      return later(async () => {
        if (conflicts.length) {
          const pending = conflicts.shift();
          if (pending.store !== undefined) store[entry] = clone(pending.store);
          const error = new Error("다른 곳에서 먼저 고쳤습니다");
          error.id = "STORAGE_ITEM_WRITE_CONFLICT";
          error.code = "STORAGE_ITEM_WRITE_CONFLICT";
          throw error;
        }
        if (failure && (!failure.entry || failure.entry === entry)) {
          const error = failure.error;
          failure = null;
          throw error;
        }
        store[entry] = clone(content);
        writes.push({ entry, content: clone(content) });
        return clone(content);
      });
    },
    publish(patch) { publishes.push(clone(patch)); },
    handle(name, listener) { handlers.set(name, listener); },
    notice(message) { notices.push(message); },
    config: { actions: ACTIONS },
  };

  const FakeDate = class extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  };

  const context = {
    window: { kaleidoscope: bridge },
    setTimeout: (fn, ms) => {
      const id = sequence++;
      timers.set(id, { run: fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    Date: FakeDate,
    console,
  };
  vm.runInNewContext(source, context, { filename: "todo-client.javascript" });

  // 실제 런타임처럼 저장소 읽기와 쓰기를 한 줄로 세운다(client-runtime의 this.writes).
  function later(task) {
    const run = queue.catch(() => undefined).then(task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  const settle = async (rounds = 10) => {
    for (let index = 0; index < rounds; index += 1) await new Promise(done => setImmediate(done));
  };

  const advance = async ms => {
    const target = clock.now + ms;
    for (;;) {
      await settle();
      let next = null;
      for (const [id, timer] of timers) if (timer.at <= target && (!next || timer.at < next[1].at)) next = [id, timer];
      if (!next) break;
      timers.delete(next[0]);
      clock.now = Math.max(clock.now, next[1].at);
      next[1].run();
    }
    clock.now = target;
    await settle();
  };

  const jump = ms => { clock.now += ms; };

  const notify = (entry, content) => {
    for (const listener of storageListeners.get(entry)?.keys() ?? []) listener(clone(content));
  };

  const externalItems = async value => { store.items = clone(value); notify("items", store.items); await settle(); };
  const externalAreas = async value => { store.areas = clone(value); notify("areas", store.areas); await settle(); };
  const externalState = async patch => {
    Object.assign(win, patch);
    for (const listener of stateListeners) listener({ ...win });
    await settle();
  };
  const lifecycleCall = async payload => {
    lifecycle = { visible: true, focused: true, viewport: { width: 1040, height: 700, coarse_pointer: false }, ...payload };
    return Promise.all([...lifecycleListeners].map(fn => Promise.resolve().then(() => fn(lifecycle))));
  };
  const release = async () => {
    holding = false;
    for (const gate of gates.splice(0)) gate();
    await settle();
  };
  const run = (name, actionContext = {}) => {
    const handler = handlers.get(name);
    assert.ok(handler, `클라이언트 동작 ${name}이 등록되지 않았습니다`);
    return handler(actionContext);
  };
  const published = () => publishes.length ? publishes[publishes.length - 1] : {};
  const output = name => plain(published()[name]);

  return {
    bridge, store, writes, attempts, publishes, notices, statePatches, handlers, win, clock,
    settle, advance, jump, externalItems, externalAreas, externalState, lifecycleCall, release, run, published, output,
    conflictNext: value => { conflicts.push(value); },
    failNext: (entry, error = Object.assign(new Error("저장 실패"), { id: "STORAGE_ITEM_WRITE_FAILED" })) => { failure = { entry, error }; },
    failRead: (entry, error = Object.assign(new Error("저장소 읽기 실패"), { id: "STORAGE_ITEM_READ_FAILED" })) => { readFailure = { entry, error }; },
    reads,
  };
}

function sampleItems() {
  return [
    item("report", { title: "분기 보고서", order: 0 }),
    item("collect", { title: "자료 모으기", parent: "report", status: "done", done_on: "2026-11-08", order: 0 }),
    item("draft", { title: "초안 쓰기", parent: "report", wait: "팀장 검토", order: 1 }),
    item("deck", { title: "발표 자료 만들기", order: 1 }),
    item("room", { title: "회의실 예약", parent: "deck", date: "2026-11-10", order: 0 }),
    item("quote", { title: "거래처 견적 비교", status: "held", order: 2 }),
    item("shop", { title: "장보기", area: "개인", order: 0 }),
    item("milk", { title: "우유", area: "개인", parent: "shop", status: "done", done_on: "2026-11-09", order: 0 }),
    item("egg", { title: "달걀", area: "개인", parent: "shop", status: "done", done_on: "2026-11-09", order: 1 }),
    item("soap", { title: "세제", area: "개인", parent: "shop", order: 2 }),
    item("dentist", { title: "치과 예약", area: "개인", date: "2026-11-16", order: 1 }),
    item("old", { title: "지난 일", area: "개인", status: "done", done_on: "2026-11-06", order: 2 }),
    item("hobby", { title: "기타 연습", area: "취미", order: 0 }),
  ];
}

test("저장소를 읽어 묶음 구역과 트리를 만든다", async () => {
  const app = boot({ items: sampleItems(), areas: ["업무", "개인", "독서"] });
  await app.settle();

  assert.equal(app.output("loading"), false);
  assert.equal(app.output("open_view"), true);
  assert.equal(app.output("log_view"), false);
  assert.equal(app.output("has_selection"), false);
  assert.equal(app.output("show_hint"), true);
  assert.deepEqual(app.output("area_options"), ["업무", "개인", "독서", "취미"]);

  const sections = app.output("sections");
  assert.deepEqual(sections.map(section => section.name), ["업무", "개인", "독서", "취미"]);
  assert.deepEqual(sections.map(section => section.key), ["업무", "개인", "독서", "취미"]);
  assert.deepEqual(sections[2].children, []);

  const work = sections[0].children;
  assert.deepEqual(work.map(node => node.key), ["report", "deck", "quote"]);
  assert.equal(work[0].title, "분기 보고서");
  assert.equal(work[0].checked, false);
  assert.equal("meta" in work[0], false);
  assert.deepEqual(work[0].children.map(node => node.key), ["collect", "draft"]);
  assert.equal(work[0].children[0].checked, true);
  assert.equal(work[0].children[0].meta, "어제");
  assert.equal(work[0].children[1].meta, "팀장 검토");
  assert.equal(work[1].children[0].meta, "내일");
  assert.deepEqual(work[2].badges, ["보류"]);
  assert.equal("meta" in work[2], false);

  const personal = sections[1].children;
  assert.deepEqual(personal.map(node => node.key), ["shop", "dentist"]);
  assert.deepEqual(personal[0].children.map(node => node.key), ["milk", "egg", "soap"]);
  assert.equal(personal[0].children[0].meta, "오늘");
  assert.equal("meta" in personal[0].children[2], false);
  assert.deepEqual(sections[3].children.map(node => node.key), ["hobby"]);
});

test("Object.prototype에 있는 이름도 묶음 구역과 선택지에 나온다", async () => {
  const items = [
    item("a", { title: "생성자", area: "constructor", order: 0 }),
    item("b", { title: "일반", area: "업무", order: 1 }),
  ];
  const app = boot({ items, areas: ["constructor", "업무"] });
  await app.settle();

  assert.deepEqual(app.output("sections").map(section => section.name), ["constructor", "업무"]);
  assert.deepEqual(app.output("sections")[0].children.map(node => node.key), ["a"]);
  assert.deepEqual(app.output("area_options"), ["constructor", "업무"]);
});

test("날짜 표기는 기기 날짜 기준 오늘·내일·어제·M/D·YYYY/M/D다", async () => {
  const items = [
    item("today", { date: "2026-11-09", order: 0 }),
    item("tomorrow", { date: "2026-11-10", order: 1 }),
    item("yesterday", { date: "2026-11-08", order: 2 }),
    item("thisyear", { date: "2026-03-05", order: 3 }),
    item("otheryear", { date: "2025-12-31", order: 4 }),
    item("both", { date: "2026-11-09", wait: "검토", order: 5 }),
    item("doneold", { status: "done", done_on: "2025-12-31", order: 6 }),
    item("under", { parent: "doneold", order: 0 }),
  ];
  const app = boot({ items });
  await app.settle();

  const nodes = app.output("sections")[0].children;
  const meta = Object.fromEntries(nodes.map(node => [node.key, node.meta]));
  assert.equal(meta.today, "오늘");
  assert.equal(meta.tomorrow, "내일");
  assert.equal(meta.yesterday, "어제");
  assert.equal(meta.thisyear, "3/5");
  assert.equal(meta.otheryear, "2025/12/31");
  assert.equal(meta.both, "오늘 · 검토");
  assert.equal(meta.doneold, "2025/12/31");
});

test("기록 보기는 끝낸 날별로 묶고 최신 날짜가 앞에 온다", async () => {
  const items = [
    item("a", { title: "보고서 마감", status: "done", done_on: "2026-11-09", order: 0 }),
    item("shop", { title: "장보기", area: "개인", order: 0 }),
    item("b", { title: "우유", area: "개인", parent: "shop", status: "done", done_on: "2026-11-09", order: 0 }),
    item("c", { title: "청소", area: "개인", status: "done", done_on: "2026-11-08", order: 1 }),
    item("d", { title: "정리", status: "done", done_on: "2026-11-06", order: 1 }),
    item("e", { title: "날짜 없음", status: "done", done_on: null, order: 2 }),
  ];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ view: "log" });

  assert.equal(app.output("open_view"), false);
  assert.equal(app.output("log_view"), true);
  const log = app.output("log");
  assert.deepEqual(log.map(day => day.key), ["day:2026-11-09", "day:2026-11-08", "day:2026-11-06"]);
  assert.deepEqual(log.map(day => day.title), ["오늘", "어제", "11월 6일 (금)"]);
  assert.equal("checked" in log[0], false);
  assert.deepEqual(log[0].children.map(node => node.key), ["a", "b"]);
  assert.equal(log[0].children[0].checked, true);
  assert.equal(log[0].children[0].meta, "업무");
  assert.equal(log[0].children[1].meta, "개인 · 장보기");
  assert.deepEqual(log[1].children.map(node => node.key), ["c"]);
  assert.equal(log[2].children[0].meta, "업무");
});

test("check는 자손을 끝내고 자식이 모두 끝난 조상도 끝낸다", async () => {
  const items = [
    item("p1", { title: "부모", order: 0 }),
    item("c1", { title: "이미 끝남", parent: "p1", status: "done", done_on: "2026-11-09", order: 0 }),
    item("c2", { title: "남은 자식", parent: "p1", order: 1 }),
    item("g1", { title: "손자", parent: "c2", status: "held", order: 0 }),
    item("p2", { title: "다른 부모", order: 1 }),
    item("d1", { title: "끝남", parent: "p2", status: "done", done_on: "2026-11-08", order: 0 }),
    item("d2", { title: "열림", parent: "p2", order: 1 }),
  ];
  const app = boot({ items });
  await app.settle();

  await app.run("check", { event: true, item: { key: "c2", title: "남은 자식", checked: false } });
  await app.settle();

  const store = app.store.items;
  const find = id => store.find(entry => entry.id === id);
  assert.equal(find("c2").status, "done");
  assert.equal(find("c2").done_on, "2026-11-09");
  assert.equal(find("g1").status, "done");
  assert.equal(find("g1").done_on, "2026-11-09");
  assert.equal(find("p1").status, "done");
  assert.equal(find("p1").done_on, "2026-11-09");
  assert.equal(find("c1").done_on, "2026-11-09");
  assert.equal(find("p2").status, "open");
  assert.equal(find("d2").status, "open");

  await app.run("check", { event: false, item: { key: "c2" } });
  await app.settle();

  const after = app.store.items;
  const get = id => after.find(entry => entry.id === id);
  assert.equal(get("c2").status, "open");
  assert.equal(get("c2").done_on, null);
  assert.equal(get("p1").status, "open");
  assert.equal(get("p1").done_on, null);
  assert.equal(get("g1").status, "done");
  assert.equal(get("g1").done_on, "2026-11-09");
});

test("check는 context의 item.key만 읽고 기록 보기의 날짜 행에는 반응하지 않는다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  await app.settle();

  await app.run("check", { event: true, key: "a", item: null });
  await app.run("check", { event: true, key: "day:2026-11-08", item: { key: "day:2026-11-08" } });
  await app.settle();
  assert.equal(app.writes.length, 0);

  await app.run("check", { event: true, key: "다른 키", item: { key: "a" } });
  await app.settle();
  assert.equal(app.writes.length, 1);
  assert.equal(app.store.items.find(entry => entry.id === "a").status, "done");
});

test("add는 같은 형제 끝에 넣고 새 항목을 고른 뒤 대화상자를 닫는다", async () => {
  const app = boot({ items: [item("report", { title: "분기 보고서", order: 0 })] });
  await app.settle();
  await app.bridge.setState("adding", { area: "업무", parent: null });
  await app.run("dialog_title", { event: "새 할 일" });
  await app.run("add");
  await app.settle();

  const created = app.store.items.find(entry => entry.title === "새 할 일");
  assert.ok(created);
  assert.match(created.id, /^t[0-9a-z]{5,}$/);
  assert.equal(created.area, "업무");
  assert.equal(created.parent, null);
  assert.equal(created.status, "open");
  assert.equal(created.date, null);
  assert.equal(created.wait, null);
  assert.equal(created.done_on, null);
  assert.equal(created.created_on, "2026-11-09");
  assert.equal(created.order, 1);
  assert.equal(app.win.adding, null);
  assert.equal(app.win.selected, created.id);
  assert.deepEqual(app.statePatches.at(-1), { adding: null, selected: created.id });
  assert.equal(app.output("has_selection"), true);
  assert.equal(app.output("d_title"), "새 할 일");
  assert.equal(app.output("add_title"), "");
});

test("add는 끝난 부모와 끝난 조상을 다시 열고 날짜를 함께 넣는다", async () => {
  const items = [
    item("p1", { title: "부모", status: "done", done_on: "2026-11-08", order: 0 }),
    item("g1", { title: "조상", parent: "p1", status: "done", done_on: "2026-11-08", order: 0 }),
  ];
  const app = boot({ items });
  await app.settle();
  await app.bridge.setState("adding", { area: "업무", parent: "g1" });
  await app.run("dialog_title", { event: "새 하위 일" });
  await app.run("dialog_date", { event: "2026-11-12" });
  await app.run("add");
  await app.settle();

  const store = app.store.items;
  const parent = store.find(entry => entry.id === "g1");
  const ancestor = store.find(entry => entry.id === "p1");
  const created = store.find(entry => entry.title === "새 하위 일");
  assert.equal(created.parent, "g1");
  assert.equal(created.date, "2026-11-12");
  assert.equal(parent.status, "open");
  assert.equal(parent.done_on, null);
  assert.equal(ancestor.status, "open");
  assert.equal(ancestor.done_on, null);
});

test("빈 제목이면 add가 아무것도 쓰지 않고 대화상자를 열어 둔다", async () => {
  const app = boot({ items: [item("report", { order: 0 })] });
  await app.settle();
  await app.bridge.setState("adding", { area: "업무", parent: null });
  await app.run("dialog_title", { event: "   " });
  await app.run("add");
  await app.settle();

  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.win.adding, { area: "업무", parent: null });
  assert.equal(app.store.items.length, 1);
});

test("edit의 제목과 기다림은 마지막 입력 뒤 0.5초에 한 번만 저장한다", async () => {
  const app = boot({ items: [item("a", { title: "처음", tag: 7 }), item("b", { title: "다른", order: 1 })] });
  await app.settle();
  await app.externalState({ selected: "a" });

  await app.run("edit", { event: "가", args: "title" });
  await app.run("edit", { event: "가나", args: "title" });
  await app.settle();
  assert.equal(app.writes.length, 0);
  await app.advance(499);
  assert.equal(app.writes.length, 0);
  await app.advance(1);
  assert.equal(app.writes.length, 1);
  const written = app.store.items.find(entry => entry.id === "a");
  assert.equal(written.title, "가나");
  assert.equal(written.tag, 7);

  await app.run("edit", { event: "  ", args: "title" });
  await app.advance(600);
  assert.equal(app.writes.length, 1);
  assert.equal(app.store.items.find(entry => entry.id === "a").title, "가나");
});

test("항목을 빨리 바꾸면 앞 항목의 제목과 기다림도 저장한다", async () => {
  const items = [item("a", { title: "처음", wait: "검토" }), item("b", { title: "다른", order: 1 })];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "a" });

  await app.run("edit", { event: "에이 제목", args: "title" });
  await app.run("edit", { event: "에이 기다림", args: "wait" });
  await app.advance(100);

  await app.externalState({ selected: "b" });
  await app.run("edit", { event: "비 제목", args: "title" });
  await app.run("edit", { event: "비 기다림", args: "wait" });
  await app.settle();

  const saved = id => app.store.items.find(entry => entry.id === id);
  assert.equal(saved("a").title, "에이 제목");
  assert.equal(saved("a").wait, "에이 기다림");
  assert.equal(app.writes.length, 2);

  await app.advance(500);
  assert.equal(saved("b").title, "비 제목");
  assert.equal(saved("b").wait, "비 기다림");
  assert.equal(app.writes.length, 4);
});

test("edit의 기다림은 빈 값이면 null로 쓰고 들어 있던 대상에 쓴다", async () => {
  const items = [item("a", { title: "하나", wait: "팀장 검토" }), item("b", { title: "둘", order: 1 })];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "a" });

  await app.run("edit", { event: "", args: "wait" });
  await app.advance(500);
  assert.equal(app.store.items.find(entry => entry.id === "a").wait, null);
  assert.equal(app.writes.length, 1);

  await app.run("edit", { event: "새 이름", args: "title" });
  await app.externalState({ selected: "b" });
  await app.advance(500);
  assert.equal(app.store.items.find(entry => entry.id === "a").title, "새 이름");
  assert.equal(app.store.items.find(entry => entry.id === "b").title, "둘");
});

test("edit의 날짜는 바로 쓰고 비우면 null이다", async () => {
  const app = boot({ items: [item("a", { date: "2026-11-10" })] });
  await app.settle();
  await app.externalState({ selected: "a" });

  await app.run("edit", { event: "2026-11-20", args: "date" });
  await app.settle();
  assert.equal(app.store.items[0].date, "2026-11-20");
  assert.equal(app.writes.length, 1);

  await app.run("edit", { event: "", args: "date" });
  await app.settle();
  assert.equal(app.store.items[0].date, null);
  assert.equal(app.writes.length, 2);
});

test("묶음을 바꾸면 항목과 자손이 함께 옮겨가고 새 묶음 맨 끝에 선다", async () => {
  const items = [
    item("p", { title: "옮길 일", order: 0 }),
    item("c1", { title: "자손 하나", parent: "p", order: 0 }),
    item("c2", { title: "자손 둘", parent: "p", order: 1 }),
    item("shop", { title: "장보기", area: "개인", order: 0 }),
    item("dentist", { title: "치과 예약", area: "개인", order: 1 }),
  ];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "p" });

  await app.run("edit", { event: "개인", args: "area" });
  await app.settle();

  const store = app.store.items;
  const moved = store.find(entry => entry.id === "p");
  assert.equal(moved.area, "개인");
  assert.equal(moved.parent, null);
  assert.equal(moved.order, 2);
  for (const id of ["c1", "c2"]) {
    const child = store.find(entry => entry.id === id);
    assert.equal(child.area, "개인");
    assert.equal(child.parent, "p");
  }
  const sections = app.output("sections");
  assert.deepEqual(sections.map(section => section.name), ["업무", "개인"]);
  assert.deepEqual(sections[0].children, []);
  assert.deepEqual(sections[1].children.map(node => node.key), ["shop", "dentist", "p"]);
});

test("remove는 자손까지 지우고 고른 항목이 사라지면 선택을 비운다", async () => {
  const items = [
    item("p", { title: "지울 일", order: 0 }),
    item("c1", { title: "자손 하나", parent: "p", order: 0 }),
    item("c2", { title: "자손 둘", parent: "p", order: 1 }),
    item("g1", { title: "손자", parent: "c2", order: 0 }),
    item("keep", { title: "남는 일", order: 1 }),
  ];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "p" });

  await app.run("remove");
  await app.settle();

  assert.deepEqual(app.store.items.map(entry => entry.id), ["keep"]);
  assert.equal(app.win.selected, null);
  assert.ok(app.statePatches.some(patch => patch.selected === null));
  assert.equal(app.output("has_selection"), false);
});

test("보류 단추는 보류와 열림을 오간다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  await app.settle();
  await app.externalState({ selected: "a" });
  await app.run("toggle_hold");
  await app.settle();
  assert.equal(app.store.items[0].status, "held");
  assert.equal(app.store.items[0].done_on, null);
  assert.equal(app.output("held"), true);

  await app.run("toggle_hold", { item: { key: "a" } });
  await app.settle();
  assert.equal(app.store.items[0].status, "open");
  assert.equal(app.output("held"), false);
});

test("행 메뉴의 동작은 우클릭한 항목을 대상으로 한다", async () => {
  const items = [item("a", { title: "하나" }), item("b", { title: "둘", order: 1 })];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "a" });

  await app.run("remove", { item: { key: "b", title: "둘" }, key: "b" });
  await app.settle();
  assert.deepEqual(app.store.items.map(entry => entry.id), ["a"]);
  assert.equal(app.win.selected, "a");
});

test("revision 충돌이면 다시 읽어 같은 연산을 한 번 더 적용한다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  await app.settle();
  await app.externalState({ selected: "a" });

  app.conflictNext({ store: [item("a", { title: "하나" }), item("b", { title: "바깥에서 더함", order: 1 })] });
  await app.run("toggle_hold");
  await app.settle();

  assert.equal(app.attempts.length, 2);
  assert.equal(app.writes.length, 1);
  assert.deepEqual(app.store.items.map(entry => entry.id), ["a", "b"]);
  assert.equal(app.store.items.find(entry => entry.id === "a").status, "held");
  assert.equal(app.store.items.find(entry => entry.id === "b").status, "open");
  assert.equal(app.output("sections")[0].children.length, 2);
});

test("두 번째 충돌은 그대로 던지고 더 재시도하지 않는다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  await app.settle();
  await app.externalState({ selected: "a" });

  app.conflictNext({ store: [item("a", { title: "하나" })] });
  app.conflictNext({ store: [item("a", { title: "하나" })] });
  await assert.rejects(app.run("toggle_hold"), error => error.id === "STORAGE_ITEM_WRITE_CONFLICT");
  await app.settle();
  assert.equal(app.attempts.length, 2);
  assert.equal(app.writes.length, 0);
});

test("바깥에서 저장소를 바꾸면 화면이 따라온다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  await app.settle();
  const before = app.writes.length;

  await app.externalItems([item("a", { title: "하나" }), item("b", { title: "바깥에서 더함", order: 1 })]);
  assert.equal(app.writes.length, before);
  assert.deepEqual(app.output("sections")[0].children.map(node => node.key), ["a", "b"]);

  await app.externalAreas(["업무", "개인", "독서"]);
  assert.deepEqual(app.output("sections").map(section => section.name), ["업무", "개인", "독서"]);
});

test("불러오는 동안에는 loading이 참이고 화면 값은 비어 있다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })], hold: true });
  await app.settle();

  assert.equal(app.output("loading"), true);
  assert.equal(app.output("open_view"), false);
  assert.equal(app.output("log_view"), false);
  assert.equal(app.output("show_hint"), false);
  assert.equal(app.output("has_selection"), false);
  assert.deepEqual(app.output("sections"), []);

  await app.release();
  assert.equal(app.output("loading"), false);
  assert.equal(app.output("open_view"), true);
  assert.equal(app.output("show_hint"), true);
  assert.deepEqual(app.output("sections")[0].children.map(node => node.key), ["a"]);
});

test("창을 닫으면 미뤄 둔 제목 쓰기를 바로 보내고 그 Promise를 돌려준다", async () => {
  const app = boot({ items: [item("a", { title: "처음" })] });
  await app.settle();
  await app.externalState({ selected: "a" });
  await app.run("edit", { event: "마지막 제목", args: "title" });
  await app.settle();
  assert.equal(app.writes.length, 0);

  await app.lifecycleCall({ phase: "closing" });
  await app.settle();
  assert.equal(app.writes.length, 1);
  assert.equal(app.store.items[0].title, "마지막 제목");
});

test("닫는 중 쓰기가 실패하면 닫기를 실패로 끝내고 초안을 남겨 다시 저장한다", async () => {
  const items = [item("a", { title: "처음", wait: "검토" })];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "a" });

  await app.run("edit", { event: "마지막 제목", args: "title" });
  await app.run("edit", { event: "마지막 기다림", args: "wait" });
  await app.settle();
  assert.equal(app.writes.length, 0);

  app.failNext("items");
  await assert.rejects(app.lifecycleCall({ phase: "closing" }), /저장 실패/);
  await app.settle();

  assert.equal(app.store.items[0].title, "처음");
  assert.equal(app.store.items[0].wait, "마지막 기다림");
  assert.ok(app.notices.some(message => message.includes("저장 실패")));

  await app.lifecycleCall({ phase: "closing" });
  await app.settle();
  assert.equal(app.store.items[0].title, "마지막 제목");
});

test("자정이 지나면 오늘·어제 표기를 다시 계산한다", async () => {
  const app = boot({ now: local(2026, 11, 9, 23, 59, 30), items: [item("a", { title: "하나", status: "done", done_on: "2026-11-09" })] });
  await app.settle();
  assert.equal(app.output("sections")[0].children[0].meta, "오늘");

  await app.advance(61000);
  assert.equal(app.output("sections")[0].children[0].meta, "어제");
});

test("창이 다시 보이면 기기 날짜를 다시 읽는다", async () => {
  const app = boot({ items: [item("a", { title: "하나", status: "done", done_on: "2026-11-09" })] });
  await app.settle();
  assert.equal(app.output("sections")[0].children[0].meta, "오늘");

  app.jump(86400000);
  await app.lifecycleCall({ phase: "change", visible: true });
  assert.equal(app.output("sections")[0].children[0].meta, "어제");
});

test("고른 항목의 값이 상세 칸 출력으로 나오고 없으면 안내를 보인다", async () => {
  const app = boot({ items: [item("a", { title: "제목", wait: "검토", date: "2026-11-10" })] });
  await app.settle();
  assert.equal(app.output("show_hint"), true);

  await app.externalState({ selected: "a" });
  assert.equal(app.output("has_selection"), true);
  assert.equal(app.output("show_hint"), false);
  assert.equal(app.output("d_title"), "제목");
  assert.equal(app.output("d_area"), "업무");
  assert.equal(app.output("d_date"), "2026-11-10");
  assert.equal(app.output("d_wait"), "검토");
  assert.equal(app.output("held"), false);
  assert.equal(app.output("selected_title"), "제목");

  await app.externalState({ selected: "없는 항목" });
  assert.equal(app.output("has_selection"), false);
  assert.equal(app.output("show_hint"), true);
  assert.equal(app.output("d_title"), null);
});

test("구역 +는 그 묶음을, 하위 추가는 그 항목을 대상으로 대화상자를 연다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })], areas: ["업무", "개인"] });
  await app.settle();

  await app.run("open_add_area", { item: { key: "개인", name: "개인" }, key: "개인" });
  assert.deepEqual(app.win.adding, { area: "개인", parent: null });
  assert.equal(app.output("add_title"), "");
  assert.equal(app.output("add_date"), null);

  await app.run("dialog_title", { event: "새 일" });
  await app.run("dialog_date", { event: "2026-11-11" });
  assert.equal(app.output("add_title"), "새 일");
  assert.equal(app.output("add_date"), "2026-11-11");

  await app.run("open_add_child", { item: { key: "a", title: "하나" }, key: "a" });
  assert.deepEqual(app.win.adding, { area: "업무", parent: "a" });
  assert.equal(app.output("add_title"), "");

  await app.run("dialog_close");
  assert.equal(app.win.adding, null);
  assert.equal(app.output("add_title"), "");
});

test("저장소 읽기가 실패하면 불러오기를 끝내고 쉘에 알린다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  app.failRead("items");
  await app.settle();

  assert.equal(app.output("loading"), false);
  assert.equal(app.output("show_hint"), false);
  assert.deepEqual(app.output("sections"), []);
  assert.equal(app.reads.items, 1);
  assert.ok(app.notices.some(message => message.includes("저장소 읽기 실패")));
});

test("묶음마다 보이는 항목이 있는지를 has_items로 알린다", async () => {
  const items = [
    item("a", { title: "하나", order: 0 }),
    item("b", { title: "둘", area: "개인", order: 0 }),
  ];
  const app = boot({ items, areas: ["업무", "개인", "독서"] });
  await app.settle();

  const sections = app.output("sections");
  assert.deepEqual(sections.map(section => [section.name, section.has_items]), [["업무", true], ["개인", true], ["독서", false]]);
  assert.deepEqual(sections[2].children, []);

  await app.externalItems([item("done", { title: "끝난 일", area: "개인", status: "done", done_on: "2026-11-06" })]);
  assert.deepEqual(app.output("sections").map(section => [section.name, section.has_items]), [["업무", false], ["개인", false], ["독서", false]]);
});

test("보이는 항목이 하나도 없으면 list_empty를 참으로 알린다", async () => {
  const app = boot({ items: [], areas: ["업무", "개인"] });
  await app.settle();
  assert.equal(app.output("list_empty"), true);
  assert.deepEqual(app.output("sections").map(section => section.has_items), [false, false]);

  await app.externalItems([item("a", { title: "하나" })]);
  assert.equal(app.output("list_empty"), false);

  await app.externalItems([item("done", { title: "끝난 일", status: "done", done_on: "2026-11-06" })]);
  assert.equal(app.output("list_empty"), true);
});

test("기록 빈 상태는 불러온 뒤 끝낸 항목의 유무를 따른다", async () => {
  const app = boot({ items: [], hold: true });
  await app.settle();
  assert.equal(app.output("log_empty"), false);
  await app.release();
  assert.equal(app.output("log_empty"), true);
  await app.externalItems([item("a")]);
  assert.equal(app.output("log_empty"), true);
  await app.externalItems([item("done", { status: "done", done_on: "2026-11-06" })]);
  assert.equal(app.output("log_empty"), false);
});

test("상세 안내는 현재 보기에서 고를 항목이 있을 때만 보인다", async () => {
  const app = boot({ items: [] });
  await app.settle();
  assert.equal(app.output("show_hint"), false);
  await app.externalItems([item("a")]);
  assert.equal(app.output("show_hint"), true);
  await app.externalState({ view: "log" });
  assert.equal(app.output("show_hint"), false);
  await app.externalItems([item("done", { status: "done", done_on: "2026-11-06" })]);
  assert.equal(app.output("show_hint"), true);
  await app.externalState({ view: "open" });
  assert.equal(app.output("show_hint"), false);
});

test("기록의 날짜 행은 선택하지 않고 할 일 행은 선택한다", async () => {
  const app = boot({ view: "log", items: [item("done", { status: "done", done_on: "2026-11-06" })] });
  await app.settle();
  await app.run("select_log", { event: "day:2026-11-06", item: { key: "day:2026-11-06" } });
  assert.equal(app.win.selected, null);
  await app.run("select_log", { event: "done", item: { key: "done" } });
  assert.equal(app.win.selected, "done");
  await app.externalState({ selected: "done" });
  await app.run("select_log", { event: "day:2026-11-06", item: { key: "day:2026-11-06" } });
  assert.equal(app.win.selected, "done");
  assert.equal(app.output("has_selection"), true);
});

test("불러오는 동안에는 list_empty가 거짓이다", async () => {
  const app = boot({ items: [], areas: ["업무"], hold: true });
  await app.settle();
  assert.equal(app.output("loading"), true);
  assert.equal(app.output("list_empty"), false);

  await app.release();
  assert.equal(app.output("loading"), false);
  assert.equal(app.output("list_empty"), true);
});

test("보기를 바꾸면 고른 항목을 비운다", async () => {
  const items = [
    item("a", { title: "하나" }),
    item("b", { title: "끝난 일", status: "done", done_on: "2026-11-09", order: 1 }),
  ];
  const app = boot({ items });
  await app.settle();
  await app.externalState({ selected: "a" });
  assert.equal(app.output("has_selection"), true);

  await app.externalState({ view: "log" });
  assert.equal(app.win.selected, null);
  assert.ok(app.statePatches.some(patch => patch.selected === null));
  assert.equal(app.output("log_view"), true);
  assert.equal(app.output("has_selection"), false);
  assert.equal(app.output("show_hint"), true);

  await app.externalState({ selected: "b" });
  assert.equal(app.output("has_selection"), true);
  await app.externalState({ view: "open" });
  assert.equal(app.win.selected, null);
  assert.equal(app.output("open_view"), true);
  assert.equal(app.output("has_selection"), false);
});

test("고른 것이 없는데 보기만 바뀌면 선택을 다시 쓰지 않는다", async () => {
  const app = boot({ items: [item("a", { title: "하나" })] });
  await app.settle();
  const before = app.statePatches.length;

  await app.externalState({ view: "log" });
  assert.equal(app.statePatches.length, before);
  assert.equal(app.output("log_view"), true);
});

test("지우기 확인 본문에 하위 할 일이 있으면 함께 지워진다는 말을 넣는다", async () => {
  const items = [
    item("p", { title: "부모 일", order: 0 }),
    item("c", { title: "자식 일", parent: "p", order: 0 }),
    item("one", { title: "단독 일", order: 1 }),
  ];
  const app = boot({ items });
  await app.settle();

  const nodes = Object.fromEntries(app.output("sections")[0].children.map(node => [node.key, node]));
  assert.equal(nodes.p.remove_body, "부모 일\n\n하위 할 일도 함께 지워집니다");
  assert.equal(nodes.p.children[0].remove_body, "자식 일");
  assert.equal(nodes.one.remove_body, "단독 일");

  await app.externalState({ selected: "p" });
  assert.equal(app.output("selected_remove_body"), "부모 일\n\n하위 할 일도 함께 지워집니다");

  await app.externalState({ selected: "one" });
  assert.equal(app.output("selected_remove_body"), "단독 일");

  await app.externalState({ selected: null });
  assert.equal(app.output("selected_remove_body"), null);
});

test("완료한 일 숨기기를 켜면 할 일 보기에서 끝낸 항목을 그리지 않는다", async () => {
  const app = boot({ items: sampleItems(), areas: ["업무", "개인", "독서", "취미"], hideDone: true });
  await app.settle();

  const sections = app.output("sections");
  assert.deepEqual(sections.map(section => section.name), ["업무", "개인", "독서", "취미"]);
  assert.deepEqual(sections[0].children.map(node => node.key), ["report", "deck", "quote"]);
  assert.deepEqual(sections[0].children[0].children.map(node => node.key), ["draft"]);
  assert.equal(sections[0].children[0].checked, false);
  assert.deepEqual(sections[1].children.map(node => node.key), ["shop", "dentist"]);
  assert.deepEqual(sections[1].children[0].children.map(node => node.key), ["soap"]);
  assert.deepEqual(sections[3].children.map(node => node.key), ["hobby"]);
  assert.equal(app.output("list_empty"), false);
  assert.equal(app.output("show_hint"), true);
});

test("끝낸 조상은 보이는 자손이 있을 때만 남는다", async () => {
  const items = [
    item("p1", { title: "끝났지만 자식이 남음", status: "done", done_on: "2026-11-09", order: 0 }),
    item("c1", { title: "남은 자식", parent: "p1", order: 0 }),
    item("p2", { title: "자식도 다 끝남", status: "done", done_on: "2026-11-08", order: 1 }),
    item("d1", { title: "끝난 자식", parent: "p2", status: "done", done_on: "2026-11-08", order: 0 }),
    item("p3", { title: "자식 없는 끝난 일", status: "done", done_on: "2026-11-09", order: 2 }),
  ];
  const app = boot({ items, areas: ["업무"], hideDone: true });
  await app.settle();

  const nodes = app.output("sections")[0].children;
  assert.deepEqual(nodes.map(node => node.key), ["p1"]);
  assert.equal(nodes[0].checked, true);
  assert.deepEqual(nodes[0].children.map(node => node.key), ["c1"]);
});

test("숨김을 끄면 1판처럼 끝낸 항목이 취소선으로 제자리에 남는다", async () => {
  const app = boot({ items: sampleItems(), areas: ["업무", "개인", "취미"], hideDone: true });
  await app.settle();
  assert.deepEqual(app.output("sections")[0].children[0].children.map(node => node.key), ["draft"]);
  assert.deepEqual(app.output("sections")[1].children[0].children.map(node => node.key), ["soap"]);

  await app.externalState({ hide_done: false });
  const report = app.output("sections")[0].children[0];
  assert.deepEqual(report.children.map(node => node.key), ["collect", "draft"]);
  assert.equal(report.children[0].checked, true);
  assert.deepEqual(app.output("sections")[1].children[0].children.map(node => node.key), ["milk", "egg", "soap"]);

  await app.externalState({ hide_done: true });
  assert.deepEqual(app.output("sections")[0].children[0].children.map(node => node.key), ["draft"]);
  assert.deepEqual(app.output("sections")[1].children[0].children.map(node => node.key), ["soap"]);
});

test("숨김 켜짐에서 체크하면 목록에서 사라지고 상세는 그 항목을 그대로 보인다", async () => {
  const app = boot({ items: [item("a", { title: "끝낼 일", order: 0 })], areas: ["업무"], hideDone: true });
  await app.settle();
  await app.externalState({ selected: "a" });
  assert.equal(app.output("has_selection"), true);

  await app.run("check", { event: true, item: { key: "a" } });
  await app.settle();

  assert.deepEqual(app.output("sections")[0].children, []);
  assert.equal(app.output("list_empty"), true);
  assert.equal(app.output("has_selection"), true);
  assert.equal(app.output("d_title"), "끝낼 일");
  assert.equal(app.win.selected, "a");
});

test("숨김의 빈 목록 안내와 상세 안내는 보이는 항목 기준이다", async () => {
  const done = item("done", { title: "오늘 끝낸 일", status: "done", done_on: "2026-11-09" });
  const app = boot({ items: [done], hideDone: true });
  await app.settle();
  assert.equal(app.output("list_empty"), true);
  assert.equal(app.output("show_hint"), false);
  assert.deepEqual(app.output("sections").map(section => [section.name, section.has_items]), [["업무", false], ["개인", false]]);

  await app.externalItems([done, item("open", { title: "남은 일", order: 1 })]);
  assert.equal(app.output("list_empty"), false);
  assert.equal(app.output("show_hint"), true);
});

test("기록 보기는 숨김과 상관없이 끝낸 항목을 보여준다", async () => {
  const items = [
    item("a", { title: "오늘 끝냄", status: "done", done_on: "2026-11-09", order: 0 }),
    item("b", { title: "어제 끝냄", status: "done", done_on: "2026-11-08", order: 1 }),
    item("c", { title: "남은 일", order: 2 }),
  ];
  const app = boot({ items, hideDone: true, view: "log" });
  await app.settle();

  assert.equal(app.output("log_view"), true);
  assert.equal(app.output("log_has_items"), true);
  const log = app.output("log");
  assert.deepEqual(log.map(day => day.key), ["day:2026-11-09", "day:2026-11-08"]);
  assert.deepEqual(log.map(day => day.children.map(node => node.key)), [["a"], ["b"]]);
});

test("start_area는 글칸을 열고 cancel_area는 쓰지 않고 닫는다", async () => {
  const app = boot({ items: [item("a")] });
  await app.settle();
  assert.equal(app.output("area_drafting"), false);
  assert.equal(app.output("area_idle"), true);
  assert.equal(app.output("area_draft"), "");

  await app.run("start_area");
  assert.equal(app.output("area_drafting"), true);
  assert.equal(app.output("area_idle"), false);

  await app.run("area_draft_change", { event: "독서" });
  assert.equal(app.output("area_draft"), "독서");

  await app.run("cancel_area");
  assert.equal(app.output("area_drafting"), false);
  assert.equal(app.output("area_idle"), true);
  assert.equal(app.output("area_draft"), "");
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.store.areas, ["업무", "개인"]);
});

test("add_area는 앞뒤 공백을 빼고 목록 끝에 더하고 글칸을 닫는다", async () => {
  const app = boot({ items: [item("a", { order: 0 })], areas: ["업무", "개인"] });
  await app.settle();
  await app.run("start_area");
  await app.run("area_draft_change", { event: "  독서  " });
  await app.run("add_area");
  await app.settle();

  assert.deepEqual(app.store.areas, ["업무", "개인", "독서"]);
  const sections = app.output("sections");
  assert.deepEqual(sections.map(section => section.name), ["업무", "개인", "독서"]);
  assert.deepEqual(sections[2].children, []);
  assert.equal(sections[2].has_items, false);
  assert.equal(app.output("area_options").at(-1), "독서");
  assert.equal(app.output("area_drafting"), false);
  assert.equal(app.output("area_draft"), "");
  const areaWrites = app.writes.filter(entry => entry.entry === "areas");
  assert.equal(areaWrites.length, 1);
  assert.deepEqual(areaWrites[0].content, ["업무", "개인", "독서"]);
});

test("add_area는 빈 이름이면 글칸만 닫고 쓰지 않는다", async () => {
  const app = boot({ items: [item("a")] });
  await app.settle();
  await app.run("start_area");
  await app.run("area_draft_change", { event: "   " });
  await app.run("add_area");
  await app.settle();

  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.store.areas, ["업무", "개인"]);
  assert.equal(app.output("area_drafting"), false);
  assert.equal(app.output("area_draft"), "");
});

test("add_area는 이미 있는 이름이면 더하지 않고 글칸을 닫는다", async () => {
  const app = boot({ items: [item("a")] });
  await app.settle();
  await app.run("start_area");
  await app.run("area_draft_change", { event: " 업무 " });
  await app.run("add_area");
  await app.settle();

  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.store.areas, ["업무", "개인"]);
  assert.equal(app.output("area_drafting"), false);
});

test("묶음 쓰기가 충돌하면 다시 읽어 한 번 더 넣는다", async () => {
  const app = boot({ items: [item("a")] });
  await app.settle();
  await app.run("start_area");
  await app.run("area_draft_change", { event: "독서" });
  app.conflictNext({ store: ["업무", "개인", "취미"] });
  await app.run("add_area");
  await app.settle();

  assert.equal(app.attempts.filter(entry => entry.entry === "areas").length, 2);
  assert.deepEqual(app.store.areas, ["업무", "개인", "취미", "독서"]);
  assert.deepEqual(app.output("sections").map(section => section.name), ["업무", "개인", "취미", "독서"]);
  assert.equal(app.output("area_drafting"), false);
});
