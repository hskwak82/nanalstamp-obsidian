// "그날로"(Rewind) 순수 로직 — 아카이브 커밋 로그의 pending 포함 파싱·삭제 노트 탐색.
// (dashcore/archivemsg 패턴: Obsidian API 의존 없음, node --test로 검증)
//
// dashcore.parseArchiveCommit은 ₿#block 필수(확정 전용 — 대시보드 집계 의미론).
// 그날로는 봉인만 되고 확정 전에 삭제된 노트도 찾아야 하므로 pending 커밋까지 파싱한다.

export type RewindEntry = { notePath: string; seq: string; block: string | null; ts: number; oid?: string; tzo?: number };

// 커밋 메시지: `nanalStamp: {notePath} · seq {seq}[ · ₿#{block}]` (archivemsg.buildArchiveMsg).
// 경로에 `· seq`가 들어가도 greedy (.+)가 마지막(진짜) seq를 잡는다(archivemsg.parseArchiveMsg와 동일 원칙).
export function parseRewindCommit(message: string, ts: number): RewindEntry | null {
  const m = message.trim().match(/^nanalStamp: (.+) · seq (\S+)( · ₿#(\S+))?$/);
  if (!m) return null;
  return { notePath: m[1], seq: m[2], block: m[4] ?? null, ts };
}

// ── 개명 계보(rename lineage) — 표시 전용(원장·서명 체인 불변) ─────────────────
// 개명하면 아카이브 이력이 경로 단위로 끊겨 옛 경로가 '삭제됨'으로 보이고 이력 카드에 이중 등재된다.
// 이벤트 기록(renameMap)이 1차 근거, 과거 개명은 내용 지문으로 소급 판정한다(main.ts renameLineage):
// 개명은 내용을 바꾸지 않으므로 "옛 경로의 마지막 보관본 == 새 경로의 첫 보관본"이 성립한다.

// 경로별 첫/마지막 커밋 요약 — 후계 후보 선별과 내용 검증(blob 읽기)의 좌표.
export type PathSpan = { firstTs: number; firstOid?: string; lastTs: number; lastOid?: string };

export function pathSpans(entries: RewindEntry[]): Map<string, PathSpan> {
  const map = new Map<string, PathSpan>();
  for (const e of entries) {
    const cur = map.get(e.notePath);
    if (!cur) { map.set(e.notePath, { firstTs: e.ts, firstOid: e.oid, lastTs: e.ts, lastOid: e.oid }); continue; }
    if (e.ts < cur.firstTs) { cur.firstTs = e.ts; cur.firstOid = e.oid; }
    if (e.ts >= cur.lastTs) { cur.lastTs = e.ts; cur.lastOid = e.oid; }
  }
  return map;
}

// 개명 체인 압축: A→B, B→C ⇒ A→C. 사이클(A→B→A, 이름 원상복귀)은 다음 홉이 이미 본 노드면
// 그 직전에서 멈춘다 — 무한루프 없이 각 키가 "도달 가능한 마지막 경로"를 가리키고,
// 어느 쪽이 진짜 계보인지는 호출자의 현존 필터(옛 경로 없음 && 새 경로 있음)가 정한다.
export function collapseRenames(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(map)) {
    let cur = map[k];
    const seen = new Set<string>([k, cur]);
    while (map[cur] !== undefined && !seen.has(map[cur])) { cur = map[cur]; seen.add(cur); }
    if (cur !== k) out[k] = cur;
  }
  return out;
}

// 파일명(확장자 제외) 유사도 0..1 — 정규화(소문자·공백/하이픈/언더스코어 제거) 후 공통 접두 길이 비율.
// 개명은 대개 이름을 잇는다("작업" → "작업 및 인수인계") — 후보 랭킹용이지 게이트가 아니다(확정은 내용).
export function nameSimilarity(pathA: string, pathB: string): number {
  const norm = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/i, "").toLowerCase().replace(/[\s\-_]+/g, "");
  const a = norm(pathA), b = norm(pathB);
  if (!a.length || !b.length) return 0;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i / Math.max(a.length, b.length);
}

// 삭제로 보이는 경로의 후계 후보: "옛 경로 마지막 봉인 이후(슬랙 허용)에 첫 봉인이 시작된" 같은 종류
// (md↔md, 첨부↔첨부)의 다른 경로를 이름 유사도순(동률이면 시간 근접순) 상위 cap개.
// 시간 근접순만으로는 대량 백필 직후 수백 경로가 창에 몰려 진짜 후계가 밀려난다(2026-07-22 실측).
// 내용 검증(blob 비교)은 호출자 몫 — 여기는 blob 읽기 횟수만 줄인다. 다단 개명(A→B→C) 소급을 위해
// "지금은 없는 경로"도 후보에 포함한다(호출자가 collapse로 최종 목적지를 정한 뒤 현존 여부를 거른다).
export function successorCandidates(deletedPath: string, spans: Map<string, PathSpan>, cap = 12, slackMs = 60_000): string[] {
  const d = spans.get(deletedPath);
  if (!d) return [];
  const isMd = /\.md$/i.test(deletedPath);
  return [...spans.entries()]
    .filter(([p, sp]) => p !== deletedPath && /\.md$/i.test(p) === isMd && sp.firstTs >= d.lastTs - slackMs)
    .map(([p, sp]) => ({ p, sp, sim: nameSimilarity(deletedPath, p) }))
    .sort((a, b) => b.sim - a.sim || a.sp.firstTs - b.sp.firstTs)
    .slice(0, cap)
    .map((x) => x.p);
}

// 경로별 최신 항목만 남기고 vault에 없는 경로만 — 최근 봉인순 정렬.
// git.log 순서(최신→과거)에 기대지 않고 ts로 판정한다(머지·리베이스 내성).
export function deletedEntries(entries: RewindEntry[], existsInVault: (path: string) => boolean): RewindEntry[] {
  const latest = new Map<string, RewindEntry>();
  for (const e of entries) {
    const cur = latest.get(e.notePath);
    if (!cur || e.ts > cur.ts) latest.set(e.notePath, e);
  }
  return [...latest.values()].filter((e) => !existsInVault(e.notePath)).sort((a, b) => b.ts - a.ts);
}
