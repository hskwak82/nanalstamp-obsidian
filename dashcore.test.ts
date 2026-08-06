// dashcore 순수 집계 로직 테스트 — 실행: npm test (esbuild 번들 → node --test)
import { test } from "node:test";
import assert from "node:assert";
import { parseArchiveCommit, topFolder, coverage, gaps, timeline, certCandidates, heatmapWeeks, heatmapCounts, syncStatus, periodKey, previousPeriod, periodLabel } from "./dashcore";

test("parseArchiveCommit: 표준 메시지에서 경로·seq·블록을 뽑는다", () => {
  const e = parseArchiveCommit("nanalStamp: proj/sub/노트 A.md · seq 42 · ₿#901234", 1700000000000);
  assert.ok(e);
  assert.strictEqual(e!.notePath, "proj/sub/노트 A.md");
  assert.strictEqual(e!.seq, "42");
  assert.strictEqual(e!.block, "901234");
  assert.strictEqual(e!.ts, 1700000000000);
});

test("parseArchiveCommit: README 등 비봉인 커밋은 null", () => {
  assert.strictEqual(parseArchiveCommit("nanalStamp archive: initial", 0), null);
  assert.strictEqual(parseArchiveCommit("random message", 0), null);
  assert.strictEqual(parseArchiveCommit("nanalStamp: initialize local archive", 0), null);
});

test("parseArchiveCommit: trailing 개행이 있어도 파싱된다(isomorphic-git 커밋 메시지)", () => {
  const e = parseArchiveCommit("nanalStamp: a.md · seq 1 · ₿#2\n", 5);
  assert.ok(e);
  assert.strictEqual(e!.notePath, "a.md");
  assert.strictEqual(e!.seq, "1");
  assert.strictEqual(e!.block, "2");
  assert.strictEqual(e!.ts, 5);
});

test("parseArchiveCommit: block '?'(미상)도 통과시킨다(파싱은 관대하게)", () => {
  const e = parseArchiveCommit("nanalStamp: a.md · seq ? · ₿#?", 1);
  assert.ok(e);
  assert.strictEqual(e!.block, "?");
});

test("topFolder: 최상위 폴더, 루트 노트는 (root)", () => {
  assert.strictEqual(topFolder("proj/sub/a.md"), "proj");
  assert.strictEqual(topFolder("a.md"), "(root)");
});

// 공용 픽스처: 노트 3개 — a는 봉인·최신(covered), b는 봉인 후 수정(modified), c는 미봉인(unsealed)
const NOTES = [
  { path: "proj/a.md", mtime: 3000 },
  { path: "proj/b.md", mtime: 2000 },
  { path: "etc/c.md", mtime: 1000 },
];
const LEDGER = { "proj/a.md": "HA", "proj/b.md": "HB_OLD" };
const hashOf = (p: string) => ({ "proj/a.md": "HA", "proj/b.md": "HB_NEW", "etc/c.md": "HC" } as Record<string, string>)[p];

test("coverage: covered/modified/unsealed 분류와 %", () => {
  const c = coverage(NOTES, LEDGER, hashOf);
  assert.strictEqual(c.covered, 1);
  assert.strictEqual(c.modified, 1);
  assert.strictEqual(c.unsealed, 1);
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.pct, 33);
});

test("coverage: 폴더별 분해(노트 수 내림차순)", () => {
  const c = coverage(NOTES, LEDGER, hashOf);
  assert.deepStrictEqual(c.byFolder[0], { folder: "proj", covered: 1, total: 2 });
  assert.deepStrictEqual(c.byFolder[1], { folder: "etc", covered: 0, total: 1 });
});

test("coverage: 빈 vault는 0으로 안전", () => {
  const c = coverage([], {}, () => undefined);
  assert.strictEqual(c.total, 0);
  assert.strictEqual(c.pct, 0);
});

test("gaps: modified 먼저, 각 그룹 내 mtime 내림차순", () => {
  const g = gaps(NOTES, LEDGER, hashOf);
  assert.deepStrictEqual(g.map((x) => [x.path, x.kind]), [
    ["proj/b.md", "modified"],
    ["etc/c.md", "unsealed"],
  ]);
});

const DAY = 86_400_000;
const ENTRIES = [
  // proj/a.md: 3개 버전, 20일 스팬, 최초 블록 900001
  { notePath: "proj/a.md", seq: "1", block: "900001", ts: 10 * DAY },
  { notePath: "proj/a.md", seq: "5", block: "900100", ts: 20 * DAY },
  { notePath: "proj/a.md", seq: "9", block: "900200", ts: 30 * DAY },
  // etc/c.md: 1개 버전, 블록 미상("?")
  { notePath: "etc/c.md", seq: "3", block: "?", ts: 15 * DAY },
];

test("timeline: 폴더별 최초 블록·기간·건수, 최초시각 오름차순", () => {
  const rows = timeline(ENTRIES);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { folder: "proj", firstBlock: 900001, firstTs: 10 * DAY, lastTs: 30 * DAY, count: 3 });
  assert.strictEqual(rows[1].folder, "etc");
  assert.strictEqual(rows[1].firstBlock, 0); // "?" 블록은 0(미상)으로
});

test("certCandidates: 버전 수 내림차순, 스팬 일수 계산", () => {
  const c = certCandidates(ENTRIES, 5);
  assert.strictEqual(c[0].notePath, "proj/a.md");
  assert.strictEqual(c[0].versions, 3);
  assert.strictEqual(c[0].spanDays, 20);
  assert.strictEqual(c[0].firstBlock, 900001);
  assert.strictEqual(c[1].versions, 1);
});

test("certCandidates: limit 적용", () => {
  assert.strictEqual(certCandidates(ENTRIES, 1).length, 1);
});

test("heatmapWeeks: 12주×7일 격자, 마지막 셀이 오늘, 봉인일 매칭", () => {
  const grid = heatmapWeeks(["2026-07-09", "2026-07-01"], "2026-07-09", 12);
  assert.strictEqual(grid.length, 12);
  assert.strictEqual(grid[0].length, 7);
  const last = grid[11][6];
  assert.strictEqual(last.date, "2026-07-09");
  assert.strictEqual(last.sealed, true);
  const all = grid.flat();
  assert.strictEqual(all.filter((c) => c.sealed).length, 2);
  assert.strictEqual(all[0].date, "2026-04-17"); // 84일 전(83일 차감)
});

const SYNC_LEDGER = { "a.md": "H1", "b.md": "H2", "c.md": "H3" }; // 확정 3건
const SYNC_ARCHIVE = { "a.md": "H1", "b.md": "OLD" };             // b는 구해시, c는 없음 → 대기 2
const SYNC_MIRROR = { "a.md": "H1" };                             // b,c 없음 → 대기 2
const SYNC_ENTRIES = [{ notePath: "a.md", seq: "1", block: "900500", ts: 1 }, { notePath: "b.md", seq: "2", block: "?", ts: 2 }];
const allEligible = () => true;

test("syncStatus: 원장 대비 아카이브/미러 대기 수와 최신 블록(nanal 꺼짐=null)", () => {
  const s = syncStatus(SYNC_LEDGER, SYNC_ARCHIVE, SYNC_MIRROR, SYNC_ENTRIES, null, allEligible);
  assert.deepStrictEqual(s, { confirmed: 3, archivePending: 2, mirrorPending: 2, latestBlock: 900500, nanalDone: 0, nanalPending: 0 });
});

test("syncStatus: nanalIndex가 null이면 eligible과 무관하게 nanal 축은 항상 0", () => {
  const s = syncStatus(SYNC_LEDGER, SYNC_ARCHIVE, SYNC_MIRROR, SYNC_ENTRIES, null, () => false);
  assert.strictEqual(s.nanalDone, 0);
  assert.strictEqual(s.nanalPending, 0);
});

test("syncStatus: nanal 켜짐 + 전부 완료(최신 해시로 업로드됨)", () => {
  const nanalIndex = { "a.md": "H1", "b.md": "H2", "c.md": "H3" }; // 전부 최신 해시
  const s = syncStatus(SYNC_LEDGER, SYNC_ARCHIVE, SYNC_MIRROR, SYNC_ENTRIES, nanalIndex, allEligible);
  assert.strictEqual(s.nanalDone, 3);
  assert.strictEqual(s.nanalPending, 0);
});

test("syncStatus: nanal 켜짐 + 일부 대기(구 해시·미존재 혼합)", () => {
  const nanalIndex = { "a.md": "H1", "b.md": "OLD" }; // b는 구해시, c는 없음 → 대기 2, 완료 1
  const s = syncStatus(SYNC_LEDGER, SYNC_ARCHIVE, SYNC_MIRROR, SYNC_ENTRIES, nanalIndex, allEligible);
  assert.strictEqual(s.nanalDone, 1);
  assert.strictEqual(s.nanalPending, 2);
});

test("syncStatus: nanalEligible 필터 — 대상 아닌 경로는 done/pending 어느 쪽에도 안 잡힘", () => {
  const nanalIndex = { "a.md": "H1" }; // a만 업로드됨
  // b, c는 nanalBackfill=false 시나리오에서 mtime 필터로 제외됐다고 가정(eligible=false)
  const eligible = (p: string) => p === "a.md";
  const s = syncStatus(SYNC_LEDGER, SYNC_ARCHIVE, SYNC_MIRROR, SYNC_ENTRIES, nanalIndex, eligible);
  assert.strictEqual(s.nanalDone, 1); // a만 집계
  assert.strictEqual(s.nanalPending, 0); // b, c는 eligible=false라 대기로도 안 잡힘
});

test("heatmapCounts: 달력 정렬(월요일 시작)·레벨 경계·미래 칸", () => {
  // 2026-07-09는 목요일 → 마지막 열은 07-06(월)~07-12(일), 07-10부터 future
  const grid = heatmapCounts(
    { "2026-07-09": 1, "2026-07-08": 3, "2026-07-07": 5, "2026-07-06": 9 },
    "2026-07-09",
    12,
  );
  assert.strictEqual(grid.length, 12);
  const last = grid[11];
  assert.strictEqual(last[0].date, "2026-07-06");
  assert.strictEqual(last[0].level, 4); // 9건 → 7+
  assert.strictEqual(last[1].level, 3); // 5건 → 4-6
  assert.strictEqual(last[2].level, 2); // 3건 → 2-3
  assert.strictEqual(last[3].level, 1); // 1건
  assert.strictEqual(last[3].date, "2026-07-09");
  assert.strictEqual(last[4].future, true); // 07-10(금)은 미래
  assert.strictEqual(grid[0][0].date, "2026-04-20"); // 12주 전 월요일
});

// digest 주기(2026-08-02) — **서버 digests.rs::period_key 와 같은 표기여야 한다.**
// 어긋나면 팀원이 쓴 글이 서버 눈에는 다른 기간이라 영원히 미작성으로 남는다.
test("periodKey: 주간·월간·분기 표기가 서버와 같다", () => {
  assert.strictEqual(periodKey("monthly", "2026-08-02"), "2026-08");
  assert.strictEqual(periodKey("monthly", "2026-12-31"), "2026-12");
  assert.strictEqual(periodKey("quarterly", "2026-08-02"), "2026-Q3");
  assert.strictEqual(periodKey("quarterly", "2026-01-01"), "2026-Q1");
  assert.strictEqual(periodKey("quarterly", "2026-12-31"), "2026-Q4");
  assert.strictEqual(periodKey("weekly", "2026-08-02"), "2026-W31");
  assert.strictEqual(periodKey("weekly", "2026-01-01"), "2026-W01");
});

test("previousPeriod: 진행 중인 기간을 가리키지 않는다", () => {
  assert.strictEqual(previousPeriod("monthly", "2026-08-01"), "2026-07");
  assert.strictEqual(previousPeriod("monthly", "2026-01-15"), "2025-12");
  assert.strictEqual(previousPeriod("quarterly", "2026-07-01"), "2026-Q2");
  assert.strictEqual(previousPeriod("quarterly", "2026-01-05"), "2025-Q4");
  assert.strictEqual(previousPeriod("weekly", "2026-08-02"), "2026-W30");
});

test("periodLabel: 사람이 읽는 이름", () => {
  assert.strictEqual(periodLabel("2026-07"), "2026년 7월");
  assert.strictEqual(periodLabel("2026-Q3"), "2026년 3분기");
  assert.strictEqual(periodLabel("2026-W31"), "2026년 31주");
});
