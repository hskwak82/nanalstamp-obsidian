import test from "node:test";
import assert from "node:assert/strict";
import { parseRewindCommit, deletedEntries, pathSpans, collapseRenames, successorCandidates, RewindEntry } from "./rewindcore";

test("parseRewindCommit: 확정 커밋(₿#block) 파싱", () => {
  const e = parseRewindCommit("nanalStamp: notes/a.md · seq 12 · ₿#900001", 1000);
  assert.deepEqual(e, { notePath: "notes/a.md", seq: "12", block: "900001", ts: 1000 });
});

test("parseRewindCommit: 봉인 시점(pending) 커밋 — block 없음 → null block", () => {
  const e = parseRewindCommit("nanalStamp: notes/a.md · seq 13", 2000);
  assert.deepEqual(e, { notePath: "notes/a.md", seq: "13", block: null, ts: 2000 });
});

test("parseRewindCommit: 경로에 '· seq'가 들어가도 마지막(진짜) seq를 잡는다", () => {
  const e = parseRewindCommit("nanalStamp: weird · seq 5 note.md · seq 7 · ₿#1", 0);
  assert.equal(e?.notePath, "weird · seq 5 note.md");
  assert.equal(e?.seq, "7");
});

test("parseRewindCommit: 포맷 밖 커밋(README 등)은 null, trailing \\n 하드닝", () => {
  assert.equal(parseRewindCommit("init archive", 0), null);
  assert.notEqual(parseRewindCommit("nanalStamp: a.md · seq 1\n", 0), null);
});

test("deletedEntries: 경로별 최신만, vault 미존재만, 최근 봉인순", () => {
  const entries: RewindEntry[] = [
    { notePath: "keep.md", seq: "1", block: "1", ts: 100 },
    { notePath: "gone.md", seq: "2", block: null, ts: 200 },
    { notePath: "gone.md", seq: "1", block: "1", ts: 150 },   // 같은 경로 과거 버전 → 그룹핑
    { notePath: "gone2.md", seq: "3", block: "2", ts: 300 },
  ];
  const vault = new Set(["keep.md"]);
  const out = deletedEntries(entries, (p) => vault.has(p));
  assert.deepEqual(out.map((e) => [e.notePath, e.ts]), [["gone2.md", 300], ["gone.md", 200]]);
});

test("deletedEntries: 빈 로그·전부 생존이면 빈 배열", () => {
  assert.deepEqual(deletedEntries([], () => true), []);
  const alive: RewindEntry[] = [{ notePath: "a.md", seq: "1", block: null, ts: 1 }];
  assert.deepEqual(deletedEntries(alive, () => true), []);
});

test("pathSpans: 경로별 첫/마지막 커밋과 oid — 로그 순서 무관(ts 기준)", () => {
  const entries: RewindEntry[] = [
    { notePath: "a.md", seq: "2", block: null, ts: 200, oid: "o2" },
    { notePath: "a.md", seq: "1", block: "1", ts: 100, oid: "o1" },
    { notePath: "b.md", seq: "1", block: null, ts: 300, oid: "o3" },
  ];
  const spans = pathSpans(entries);
  assert.deepEqual(spans.get("a.md"), { firstTs: 100, firstOid: "o1", lastTs: 200, lastOid: "o2" });
  assert.deepEqual(spans.get("b.md"), { firstTs: 300, firstOid: "o3", lastTs: 300, lastOid: "o3" });
});

test("collapseRenames: 체인 압축(A→B→C ⇒ A→C, B→C), 사이클은 무한루프 없이 직전에서 멈춤", () => {
  assert.deepEqual(collapseRenames({ "A.md": "B.md", "B.md": "C.md" }), { "A.md": "C.md", "B.md": "C.md" });
  // A→B 후 B→A(이름 되돌림): 양방향 매핑이 남지만 어느 쪽이 진짜인지는 호출자의 현존 필터가 정한다
  assert.deepEqual(collapseRenames({ "A.md": "B.md", "B.md": "A.md" }), { "A.md": "B.md", "B.md": "A.md" });
});

test("successorCandidates: 마지막 봉인 이후 시작한 같은 종류 경로만, 시간 근접순·cap", () => {
  const M = 60_000; // 슬랙(60초)과 견주려면 ms 스케일이어야 한다
  const entries: RewindEntry[] = [
    { notePath: "old.md", seq: "1", block: null, ts: 100 * M, oid: "d1" },
    { notePath: "earlier.md", seq: "1", block: null, ts: 50 * M, oid: "x" }, // old 마지막보다 먼저 시작 → 제외
    { notePath: "img.png", seq: "1", block: null, ts: 200 * M, oid: "y" },   // 종류 다름 → 제외
    { notePath: "near.md", seq: "1", block: null, ts: 150 * M, oid: "n" },
    { notePath: "far.md", seq: "1", block: null, ts: 900 * M, oid: "f" },
  ];
  const spans = pathSpans(entries);
  assert.deepEqual(successorCandidates("old.md", spans), ["near.md", "far.md"]);
  assert.deepEqual(successorCandidates("old.md", spans, 1), ["near.md"]);
  assert.deepEqual(successorCandidates("없는경로.md", spans), []);
});

test("successorCandidates: 이름 유사도가 시간 근접보다 우선(대량 백필로 창에 몰린 무관 경로에 안 밀림)", () => {
  const M = 60_000;
  const entries: RewindEntry[] = [
    { notePath: "작업노트.md", seq: "1", block: null, ts: 100 * M, oid: "d" },
    { notePath: "무관한노트.md", seq: "1", block: null, ts: 101 * M, oid: "u" },      // 시간상 가장 근접하지만 이름 무관
    { notePath: "작업노트 및 인수인계.md", seq: "1", block: null, ts: 900 * M, oid: "s" }, // 한참 뒤지만 이름이 이어짐
  ];
  const spans = pathSpans(entries);
  assert.deepEqual(successorCandidates("작업노트.md", spans)[0], "작업노트 및 인수인계.md");
});

test("successorCandidates: 슬랙 — 마지막 봉인 직전(60초 내) 시작한 경로도 후보", () => {
  const entries: RewindEntry[] = [
    { notePath: "old.md", seq: "1", block: null, ts: 100_000, oid: "d" },
    { notePath: "justbefore.md", seq: "1", block: null, ts: 70_000, oid: "j" }, // 30초 전 시작 → 슬랙 내
  ];
  const spans = pathSpans(entries);
  assert.deepEqual(successorCandidates("old.md", spans), ["justbefore.md"]);
});
