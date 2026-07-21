// 아카이브 커밋 메시지의 단일 소스. 봉인 시점(block 없음)과 확정(₿#block) 2단계를 모두 다룬다.
export function buildArchiveMsg(notePath: string, seq: number | undefined, block: number | undefined): string {
  const base = `nanalStamp: ${notePath} · seq ${seq ?? "?"}`;
  return typeof block === "number" ? `${base} · ₿#${block}` : base;
}

// seq 필수, ₿#block 은 optional(봉인 시점 커밋엔 없음 → block null). 형식 불일치면 null.
// `^nanalStamp:` 로 앵커해 우리 커밋만 파싱하고, 앞을 greedy(.*)로 둬 경로에 `· seq`가 들어가도
// 마지막(=진짜) seq 를 잡는다.
export function parseArchiveMsg(msg: string): { seq: string; block: string | null } | null {
  const m = msg.match(/^nanalStamp:.*·\s*seq\s*(\S+)(?:\s*·\s*₿#(\S+))?/);
  if (!m) return null;
  return { seq: m[1], block: m[2] ?? null };
}
