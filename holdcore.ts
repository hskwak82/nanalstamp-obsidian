// holdcore.ts — 봉인을 **보류**할 사유를 정하는 순수 모듈(Obsidian API 무의존).
//
// 왜 봉인 자체를 막는가(2026-07-30 정책):
//   예전에는 상한을 넘는 첨부만 클라우드 보관에서 빼고 노트는 그대로 봉인했다. 그러면
//   (1) 첨부 없는 연구 기록이 증거로 남아 나중에 "그 사진 어디 있나"가 되고,
//   (2) 쓸데없이 큰 동영상이 계속 쌓이는데 사용자는 아무 신호를 못 받는다.
//   그래서 **넘으면 그 노트의 봉인을 하지 않는다.** 사용자가 크기를 줄이거나 상위 요금제로
//   올려야 진행된다 — 조치가 필요하다는 사실을 그 순간에 알린다.
//
// 두 사유의 성격이 다르다:
//   · 첨부 상한 — 지금 고칠 수 있다(파일 축소·링크 제거). 전 티어 적용.
//   · 보관 쿼터 — 이미 보관된 것은 WORM 이라 지울 수 없다. 출구는 상위 요금제뿐이고,
//     **유료(스토리지 사용) 사용자에게만** 적용된다. FREE 는 로컬 아카이브만 쓰므로 무관하다.

/// 보류 사유. 안내 문구가 사유마다 달라야 해서 값으로 구분한다.
export type HoldReason =
  | { kind: "attach"; path: string; size: number; limitMB: number; byTeam: boolean }
  | { kind: "quota"; used: number; quota: number; need: number };

export const MB = 1024 * 1024;

/// 유효 첨부 상한(MiB). 0 = 무제한.
/// 팀 정책과 요금제 상한 중 **더 엄격한 쪽**을 쓴다 — 조직이 더 조일 수 있어야 한다.
/// 어느 쪽이 걸렸는지도 함께 돌려준다(안내 문구가 "팀 정책 때문"임을 밝혀야 하므로).
export function effectiveLimit(planMB: number, teamMB: number | null): { limitMB: number; byTeam: boolean } {
  const team = teamMB != null && teamMB > 0 ? teamMB : 0;
  const plan = planMB > 0 ? planMB : 0;
  if (team && plan) return team < plan ? { limitMB: team, byTeam: true } : { limitMB: plan, byTeam: false };
  if (team) return { limitMB: team, byTeam: true };
  return { limitMB: plan, byTeam: false };
}

/// 상한을 넘는 첨부가 있으면 그중 **가장 큰 것**을 돌려준다(고쳐야 할 것부터 보이게).
export function overLimitAttachment(
  attachments: Array<{ path: string; size: number }>, limitMB: number,
): { path: string; size: number } | null {
  if (!(limitMB > 0)) return null;
  const cap = limitMB * MB;
  let worst: { path: string; size: number } | null = null;
  for (const a of attachments) {
    if (a.size <= cap) continue;
    if (!worst || a.size > worst.size) worst = a;
  }
  return worst;
}

/// 이번 봉인이 보관 쿼터를 넘기는가. quota 0 = 스토리지 미사용(FREE) → 언제나 통과.
export function overQuota(used: number, quota: number, need: number): boolean {
  if (!(quota > 0)) return false;
  return used + need > quota;
}

/// 이 파일을 봉인해도 되는가. 안 되면 사유를 돌려준다.
///
/// `attachments` 는 **이 노트가 참조하는 첨부**(노트 자신이 첨부면 자기 자신 하나).
/// 첨부 하나만 넘어도 노트 전체가 보류된다 — 부분만 담긴 증거를 만들지 않기 위해서다.
export function sealHold(
  own: { path: string; size: number; isNote: boolean },
  attachments: Array<{ path: string; size: number }>,
  limitMB: number, byTeam: boolean,
  storage: { used: number; quota: number } | null,
): HoldReason | null {
  const targets = own.isNote ? attachments : [own];
  const over = overLimitAttachment(targets, limitMB);
  if (over) return { kind: "attach", path: over.path, size: over.size, limitMB, byTeam };
  if (storage) {
    // 이번에 새로 올릴 양 — 이미 올린 것은 다시 세지 않는다(호출부가 미업로드분만 넘긴다).
    const need = targets.reduce((n, a) => n + a.size, 0) + (own.isNote ? own.size : 0);
    if (overQuota(storage.used, storage.quota, need)) {
      return { kind: "quota", used: storage.used, quota: storage.quota, need };
    }
  }
  return null;
}

/// 이 크기를 담을 수 있는 **가장 싼 요금제**. 없으면 null("상위 요금제로도 안 됩니다").
/// 안내에 "Max(300MB)로 올리면 됩니다"까지 적으려면 이 계산이 필요하다 —
/// 막기만 하고 길을 알려주지 않으면 사용자는 무엇을 해야 할지 모른다.
export function planThatFits(
  plans: Array<{ code: string; name: string; attachment_max_mb: number; amount_krw: number }>,
  size: number, currentMB: number,
): { code: string; name: string; attachment_max_mb: number } | null {
  const need = Math.ceil(size / MB);
  return plans
    .filter((p) => p.attachment_max_mb > currentMB && p.attachment_max_mb >= need)
    .sort((a, b) => a.amount_krw - b.amount_krw)[0] ?? null;
}
