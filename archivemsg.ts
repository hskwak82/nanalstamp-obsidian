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

// 커밋 메시지에서 **노트 경로**를 뽑는다. 아카이브에서 어떤 파일이 이 커밋에 담겼는지 알려면
// 트리를 통째로 훑는 수밖에 없어 보이지만, 커밋 메시지가 이미 그 답을 갖고 있다.
// (실측: 트리 순회는 커밋 1,539개 × 파일 수백 개라 끝나지 않았다 — 2026-07-30)
// seq 앞까지를 greedy 로 잡아 경로에 `· seq` 가 들어가도 마지막 것이 구분자가 된다.
export function archiveNotePath(msg: string): string | null {
  const m = msg.match(/^nanalStamp: (.*)·\s*seq\s*\S+/);
  if (!m) return null;
  const p = m[1].trim();
  return p || null;
}
