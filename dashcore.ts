// dashcore.ts — 증빙 상태 대시보드의 순수 집계 로직.
// Obsidian/Node 비의존(순수 함수만) — node:test로 검증한다(certgen.ts와 같은 원칙).
// 데이터는 전부 main.ts가 로컬에서 수집해 넘긴다(서버 호출 없음 — 해시 전용 불변식).

export type NoteMeta = { path: string; mtime: number };
// 아카이브 git 커밋 1건 = 확정(비트코인 앵커) 기록 1건. ts는 ms.
export type ArchiveEntry = { notePath: string; seq: string; block: string; ts: number };

// 아카이브/미러 공용 커밋 메시지 포맷(main.ts archiveVersion·mirrorToGithub과 정렬):
//   nanalStamp: {notePath} · seq {seq} · ₿#{block}
// 포맷이 다른 커밋(README 초기 커밋 등)은 null → 집계에서 제외.
export function parseArchiveCommit(message: string, ts: number): ArchiveEntry | null {
  // isomorphic-git 커밋 메시지는 trailing \n을 포함하므로 trim으로 하드닝.
  const m = message.trim().match(/^nanalStamp: (.+) · seq (\S+) · ₿#(\S+)$/);
  if (!m) return null;
  return { notePath: m[1], seq: m[2], block: m[3], ts };
}

export function topFolder(path: string): string {
  const i = path.indexOf("/");
  return i === -1 ? "(root)" : path.slice(0, i);
}

export type CoverageRow = { folder: string; covered: number; total: number };
export type Coverage = { covered: number; modified: number; unsealed: number; total: number; pct: number; byFolder: CoverageRow[] };

// 커버리지 판정 기준: ledgerIndex(확정 증명이 로컬 원장에 기록된 해시) == 현재 파일 해시.
// hashOf는 호출자가 전 노트에 대해 제공(캐시 기반). undefined(읽기 실패)는 modified로 분류
// — "확인 불가"를 "보호됨"으로 보이게 하지 않는다.
export function coverage(notes: NoteMeta[], ledgerIndex: Record<string, string>, hashOf: (path: string) => string | undefined): Coverage {
  let covered = 0, modified = 0, unsealed = 0;
  const folders = new Map<string, { covered: number; total: number }>();
  for (const n of notes) {
    const f = topFolder(n.path);
    const row = folders.get(f) ?? { covered: 0, total: 0 };
    row.total++;
    const sealedHash = ledgerIndex[n.path];
    if (!sealedHash) unsealed++;
    else if (hashOf(n.path) === sealedHash) { covered++; row.covered++; }
    else modified++;
    folders.set(f, row);
  }
  const total = notes.length;
  const byFolder = [...folders.entries()].map(([folder, r]) => ({ folder, covered: r.covered, total: r.total }))
    .sort((a, b) => b.total - a.total);
  // pct는 floor — 공백이 하나라도 남아 있으면 100%로 보이지 않게(100%는 진짜 완전할 때만).
  return { covered, modified, unsealed, total, pct: total ? Math.floor((covered / total) * 100) : 0, byFolder };
}

export type Gap = { path: string; kind: "modified" | "unsealed"; mtime: number };

// 보호 공백: (1) 봉인 후 수정됨(재봉인 필요 — 더 급함) (2) 봉인 이력 자체가 없음.
export function gaps(notes: NoteMeta[], ledgerIndex: Record<string, string>, hashOf: (path: string) => string | undefined): Gap[] {
  const out: Gap[] = [];
  for (const n of notes) {
    const sealedHash = ledgerIndex[n.path];
    if (!sealedHash) out.push({ path: n.path, kind: "unsealed", mtime: n.mtime });
    else if (hashOf(n.path) !== sealedHash) out.push({ path: n.path, kind: "modified", mtime: n.mtime });
  }
  return out.sort((a, b) => (a.kind === b.kind ? b.mtime - a.mtime : a.kind === "modified" ? -1 : 1));
}

const MAXN = Number.MAX_SAFE_INTEGER;
function numBlock(block: string): number {
  const b = parseInt(block, 10);
  return isNaN(b) ? 0 : b;
}

export type TimelineRow = { folder: string; firstBlock: number; firstTs: number; lastTs: number; count: number };

// IP 타임라인: 폴더별 "언제부터 증명이 시작됐나". 법적 시점은 블록 번호가 기준이므로
// 최초 확정 ₿블록을 대표값으로 든다(커밋 ts는 표시용 보조).
export function timeline(entries: ArchiveEntry[]): TimelineRow[] {
  const map = new Map<string, { firstBlock: number; firstTs: number; lastTs: number; count: number }>();
  for (const e of entries) {
    const f = topFolder(e.notePath);
    const r = map.get(f) ?? { firstBlock: MAXN, firstTs: MAXN, lastTs: 0, count: 0 };
    r.count++;
    const b = numBlock(e.block);
    if (b > 0 && b < r.firstBlock) r.firstBlock = b;
    if (e.ts > 0 && e.ts < r.firstTs) r.firstTs = e.ts;
    if (e.ts > r.lastTs) r.lastTs = e.ts;
    map.set(f, r);
  }
  return [...map.entries()]
    .map(([folder, r]) => ({ folder, firstBlock: r.firstBlock === MAXN ? 0 : r.firstBlock, firstTs: r.firstTs === MAXN ? 0 : r.firstTs, lastTs: r.lastTs, count: r.count }))
    .sort((a, b) => a.firstTs - b.firstTs);
}

export type CertCandidate = { notePath: string; versions: number; spanDays: number; firstBlock: number };

// 증명서 후보: 봉인 이력이 깊고(버전 수) 오래된(스팬) 노트 — ₩9,900 증명서 CTA의 근거.
export function certCandidates(entries: ArchiveEntry[], limit = 5): CertCandidate[] {
  const map = new Map<string, { versions: number; minTs: number; maxTs: number; firstBlock: number }>();
  for (const e of entries) {
    const r = map.get(e.notePath) ?? { versions: 0, minTs: MAXN, maxTs: 0, firstBlock: MAXN };
    r.versions++;
    if (e.ts > 0 && e.ts < r.minTs) r.minTs = e.ts;
    if (e.ts > r.maxTs) r.maxTs = e.ts;
    const b = numBlock(e.block);
    if (b > 0 && b < r.firstBlock) r.firstBlock = b;
    map.set(e.notePath, r);
  }
  return [...map.entries()]
    .map(([notePath, r]) => ({
      notePath,
      versions: r.versions,
      spanDays: r.maxTs > r.minTs && r.minTs !== MAXN ? Math.round((r.maxTs - r.minTs) / 86_400_000) : 0,
      firstBlock: r.firstBlock === MAXN ? 0 : r.firstBlock,
    }))
    .sort((a, b) => b.versions - a.versions || b.spanDays - a.spanDays)
    .slice(0, limit);
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function isoDate(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

export type HeatCell = { date: string; sealed: boolean };

// 연속성 히트맵(v1: 이진 — 그날 봉인이 있었나). sealDays는 봉인 성공 로컬 날짜 목록(main.ts settings).
// todayIso를 인자로 받아 순수 함수 유지(테스트 가능). 반환: weeks개의 7일 열(과거→오늘).
export function heatmapWeeks(sealDays: string[], todayIso: string, weeks = 12): HeatCell[][] {
  const set = new Set(sealDays);
  const end = new Date(`${todayIso}T00:00:00`);
  const total = weeks * 7;
  const days: HeatCell[] = [];
  for (let i = total - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    const iso = isoDate(d);
    days.push({ date: iso, sealed: set.has(iso) });
  }
  const grid: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) grid.push(days.slice(w * 7, w * 7 + 7));
  return grid;
}

export type HeatCountCell = { date: string; count: number; level: 0 | 1 | 2 | 3 | 4; future: boolean };

// GitHub 잔디 스타일 히트맵: 열=달력 주(월요일 시작), 행=요일 고정, 셀=일별 봉인 횟수의 5단계 농도.
// 마지막 열은 이번 주(부분) — 오늘 이후 칸은 future=true로 표시만 숨긴다. 레벨 경계: 1 / 2-3 / 4-6 / 7+.
export function heatmapCounts(counts: Record<string, number>, todayIso: string, weeks = 12): HeatCountCell[][] {
  const end = new Date(`${todayIso}T00:00:00`);
  const endDow = (end.getDay() + 6) % 7; // 월=0 … 일=6
  const lastMonday = new Date(end);
  lastMonday.setDate(end.getDate() - endDow);
  const grid: HeatCountCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCountCell[] = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(lastMonday);
      d.setDate(lastMonday.getDate() - (weeks - 1 - w) * 7 + r);
      const iso = isoDate(d);
      const future = d.getTime() > end.getTime();
      const count = future ? 0 : counts[iso] ?? 0;
      const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
      col.push({ date: iso, count, level, future });
    }
    grid.push(col);
  }
  return grid;
}

export type SyncStatus = { confirmed: number; archivePending: number; mirrorPending: number; latestBlock: number };

// 동기화 상태: 확정 증명(ledgerIndex) 대비 로컬 git 아카이브/GitHub 미러가 따라왔는지.
// "대기"는 해당 인덱스에 없거나 구(舊) 해시인 경우 — recordConfirmedProof/sweep이 곧 채울 대상.
export function syncStatus(
  ledgerIndex: Record<string, string>,
  archiveIndex: Record<string, string>,
  mirrorIndex: Record<string, string>,
  entries: ArchiveEntry[],
): SyncStatus {
  let archivePending = 0, mirrorPending = 0;
  for (const [p, h] of Object.entries(ledgerIndex)) {
    if (archiveIndex[p] !== h) archivePending++;
    if (mirrorIndex[p] !== h) mirrorPending++;
  }
  let latestBlock = 0;
  for (const e of entries) {
    const b = numBlock(e.block);
    if (b > latestBlock) latestBlock = b;
  }
  return { confirmed: Object.keys(ledgerIndex).length, archivePending, mirrorPending, latestBlock };
}
