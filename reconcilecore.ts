// 봉인 대상 판정 — 순수, node --test 로 검증.
//
// 왜 이 파일이 있나(2026-07-30): 지금까지 "무엇을 봉인할지"를 **로컬 인덱스에서 유도**했다.
// sealedIndex 가 "이건 했다"고 하면 건너뛴다. 그런데 그 값은 사실이 아니라 **서버에 대한
// 주장**이다. 주장을 사실처럼 쓰면, 주장이 틀렸을 때 영원히 고쳐지지 않는다.
//
// 실제로 세 번 났다:
//   07-21 계정 전환 7건 · 07-22 서버 DB 초기화 792건 · 07-30 계정 전환 105건
// 방아쇠는 매번 달랐고 모양은 하나다 — **로컬이 "했다"고 말했고 아무도 서버에 물어보지 않았다.**
// 그래서 방아쇠를 하나씩 막는 방식으로는 네 번째가 온다.
//
// 판정을 뒤집는다:
//
//     봉인 대상 = { 범위 안 파일의 현재 해시 }  −  { 서버 사슬에 있는 해시 }
//
// 로컬 주장은 이 계산에 **들어가지 않는다.** 계정 전환·DB 복원·유령 주장·경로 이동·
// 인덱스 손상이 전부 무관해진다 — 매번 서버 진실에서 다시 계산하기 때문이다.
//
// 서버 말을 믿는 것 아니냐 하면: 서버 사슬은 비트코인에 고정돼 있어 서버가 거짓말하면
// 검증기에서 드러난다. 신뢰 사슬이 닫힌다.

/// 한 번에 물어볼 개수. 서버 상한(본문 64KB 에서 유도)보다 넉넉히 작게 잡는다 —
/// 서버가 상한을 낮춰도 클라이언트가 먼저 깨지지 않도록.
export const HAVE_CHUNK = 400;

/// 이 수를 넘으면 한 번에 전부 묻지 않고 **회전**으로 나눈다.
///
/// 왜 임계값을 두나: 대부분의 vault 는 수천 건이라 전부 물어도 몇 백 밀리초다(실측: 1,230건 0.2초).
/// 그때는 나누는 것이 손해다 — 빠진 것이 **다음 대조에서 바로** 드러나는 편이 낫다.
/// 10만 건이 넘어가면 얘기가 다르다: 전량이면 요청 250번에 6MB 라 6시간마다 돌릴 수 없다.
export const RECONCILE_FULL_MAX = 5000;

/// 회전 몫 — 20회면 한 바퀴. 6시간 간격이면 닷새다.
export const RECONCILE_ROTATION = 0.05;

export function chunk<T>(arr: T[], n: number): T[][] {
  // 크기를 한 번만 보정해 **자르기와 전진에 같은 값**을 쓴다.
  // 전진에만 보정하면 n=0 일 때 빈 조각이 무한히 쌓인다 — 나눈 결과가 원본과 달라진다.
  const step = Math.max(1, Math.floor(n) || 1);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step));
  return out;
}

export interface ScannedFile { path: string; hash: string }

/// 서버가 "있다"고 하지 않은 파일들. **없다고 답한 것이 아니라, 있다고 하지 않은 것**이다 —
/// 조회에 실패해 답을 못 받았으면 그건 이 함수가 아니라 호출자가 판단해야 한다(아래 주석 참조).
export function pendingFrom(files: ScannedFile[], present: Set<string>): ScannedFile[] {
  return files.filter((f) => !present.has(f.hash));
}

/// 캐시를 건너뛰고 **다시 읽을** 몫을 고른다.
///
/// 왜 필요한가: 파일 해시는 mtime 캐시로 아낀다(같은 mtime = 같은 내용이라는 로컬 사실).
/// 대개 맞지만 백업 복원·동기화 도구가 mtime 을 보존한 채 내용을 바꾸면 어긋난다.
/// 매번 전량 재해시하면 확실하지만 큰 vault 에서 무겁다. 그래서 **매 대조마다 일부만**
/// 무조건 다시 읽고 커서를 돌린다 — 20회면 전량이 검증된다(6시간 간격이면 닷새).
/// 비용은 1/20 이고 구멍은 며칠 안에 닫힌다.
export function rotationSlice<T>(items: T[], cursor: number, pct: number): { slice: T[]; next: number } {
  if (items.length === 0) return { slice: [], next: 0 };
  const size = Math.max(1, Math.ceil(items.length * pct));
  const start = ((cursor % items.length) + items.length) % items.length;
  const slice: T[] = [];
  for (let i = 0; i < Math.min(size, items.length); i++) slice.push(items[(start + i) % items.length]);
  return { slice, next: (start + size) % items.length };
}

/// 이번 대조에서 서버에 물어볼 파일.
///
/// 규모가 작으면 **전부** 묻는다 — 캐시하지 않는다. 한때 "서버가 있다고 답한 것은 다시 묻지
/// 않는다"로 줄였다가, 그 기록을 손으로 오염시키자 대조가 그대로 속는 것을 실기기 시험에서 봤다.
/// data.json 은 평범한 파일이라 동기화 충돌·복원·버그로 오염될 수 있고, 오염되는 순간
/// 그것은 '서버가 답한 사실'이 아니라 다시 '로컬 주장'이 된다.
///
/// 규모가 크면 나눈다. 다만 나누는 기준이 **로컬 주장이 아니다**:
///   (1) mtime 이 바뀐 것 — 로컬 사실이고, 방금 편집한 것은 즉시 확인된다
///   (2) 회전 커서가 가리키는 몫 — 아무도 안 건드린 파일도 결국 한 바퀴 안에 확인된다
/// 둘 다 오염되어도 회전이 며칠 안에 덮는다. 보장이 "다음 대조"에서 "한 바퀴 안"으로 약해질 뿐
/// 신뢰를 로컬에 넘기지는 않는다.
export function toAsk<T extends { changed: boolean }>(
  files: T[], cursor: number, fullMax = RECONCILE_FULL_MAX, pct = RECONCILE_ROTATION,
): { ask: T[]; next: number; full: boolean } {
  if (files.length <= fullMax) return { ask: files, next: 0, full: true };
  const rot = rotationSlice(files, cursor, pct);
  const picked = new Set(rot.slice);
  const ask = files.filter((f) => f.changed || picked.has(f));
  return { ask, next: rot.next, full: false };
}

/// 마지막 대조가 너무 오래됐는가 — **모른다는 사실 자체를 말해야 한다.**
/// 대조가 못 돌고 있으면 "빠진 것이 없다"가 아니라 "빠졌는지 모른다"가 참이다.
export function reconcileStale(lastAt: number | undefined, now: number, maxAgeMs: number): boolean {
  return !lastAt || now - lastAt > maxAgeMs;
}
