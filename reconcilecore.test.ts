// 봉인 대상 판정 테스트 — 실행: npm test
import { test } from "node:test";
import assert from "node:assert";
import { chunk, pendingFrom, rotationSlice, reconcileStale, toAsk, HAVE_CHUNK } from "./reconcilecore";

test("chunk: 나눠도 원본이 보존된다(빠지는 것이 없어야 한다)", () => {
  const a = Array.from({ length: 1000 }, (_, i) => i);
  const cs = chunk(a, HAVE_CHUNK);
  assert.deepStrictEqual(cs.flat(), a);
  assert.ok(cs.every((c) => c.length <= HAVE_CHUNK));
  assert.deepStrictEqual(chunk([], 400), []);
  assert.deepStrictEqual(chunk([1, 2], 0), [[1], [2]]);   // 0 이어도 무한루프 금지
});

test("서버가 있다고 한 것만 빠진다 — 로컬 주장은 계산에 없다", () => {
  const files = [{ path: "a.md", hash: "h1" }, { path: "b.md", hash: "h2" }, { path: "c.md", hash: "h3" }];
  const pending = pendingFrom(files, new Set(["h2"]));
  assert.deepStrictEqual(pending.map((f) => f.path), ["a.md", "c.md"]);
});

test("서버 답이 비면 전부 봉인 대상 — '모르면 다시 보낸다'가 안전한 방향", () => {
  const files = [{ path: "a.md", hash: "h1" }];
  assert.strictEqual(pendingFrom(files, new Set()).length, 1);
});

test("같은 내용이 여러 경로에 있어도 각각 판정된다", () => {
  const files = [{ path: "a.md", hash: "h" }, { path: "b.md", hash: "h" }];
  assert.strictEqual(pendingFrom(files, new Set(["h"])).length, 0);
  assert.strictEqual(pendingFrom(files, new Set()).length, 2);
});

test("rotationSlice: 커서를 돌려 몇 회면 전량을 덮는다", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const seen = new Set<number>();
  let cursor = 0;
  for (let round = 0; round < 20; round++) {
    const r = rotationSlice(items, cursor, 0.05);
    r.slice.forEach((x) => seen.add(x));
    cursor = r.next;
  }
  assert.strictEqual(seen.size, 100, "20회면 전량이 재검증돼야 한다");
});

test("rotationSlice: 경계", () => {
  assert.deepStrictEqual(rotationSlice([], 3, 0.5), { slice: [], next: 0 });
  const one = rotationSlice([7], 99, 0.05);
  assert.deepStrictEqual(one.slice, [7]);                    // 최소 1건은 본다
  const all = rotationSlice([1, 2, 3], 0, 1);
  assert.deepStrictEqual(all.slice, [1, 2, 3]);              // 100% 면 전량
  assert.strictEqual(rotationSlice([1, 2, 3], -1, 0.5).slice.length, 2); // 음수 커서도 안전
});

test("대조가 오래됐으면 '모른다'고 말해야 한다", () => {
  const DAY = 86400000;
  assert.strictEqual(reconcileStale(undefined, 1000, DAY), true);   // 한 번도 못 함
  assert.strictEqual(reconcileStale(1000, 1000 + DAY + 1, DAY), true);
  assert.strictEqual(reconcileStale(1000, 1000 + DAY - 1, DAY), false);
});

test("소규모면 전부 묻는다 — 캐시하지 않는다(오염되면 그 순간 로컬 주장이 된다)", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ id: i, changed: false }));
  const r = toAsk(files, 0);
  assert.strictEqual(r.ask.length, 100);
  assert.strictEqual(r.full, true);
});

test("대규모면 나누되, 편집된 것은 회전과 무관하게 매번 묻는다", () => {
  const files = Array.from({ length: 10000 }, (_, i) => ({ id: i, changed: i % 1000 === 0 }));
  const r = toAsk(files, 0, 5000, 0.05);
  assert.strictEqual(r.full, false);
  // 회전 몫 500 + 편집 10(겹칠 수 있음) — 전량보다 훨씬 적고, 편집분은 반드시 포함
  assert.ok(r.ask.length < 600, `${r.ask.length}`);
  for (const f of files.filter((x) => x.changed)) assert.ok(r.ask.includes(f), "편집분 누락");
});

test("대규모여도 회전 한 바퀴면 전량이 확인된다", () => {
  const files = Array.from({ length: 10000 }, (_, i) => ({ id: i, changed: false }));
  const seen = new Set<number>();
  let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const r = toAsk(files, cursor, 5000, 0.05);
    r.ask.forEach((f) => seen.add(f.id));
    cursor = r.next;
  }
  assert.strictEqual(seen.size, 10000, "20회면 전량이 확인돼야 한다");
});
