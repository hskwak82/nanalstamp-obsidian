// 사슬 고리 계산 — 순수, node --test 로 검증.
//
// 왜 클라이언트가 이걸 계산하나(2026-07-30): 봉인 요청이 200 을 받아도 그것은
// "응답이 왔다"일 뿐 **"내가 보낸 그것을 기록했다"가 아니다.** 예전 응답에는 보낸 hash 도
// path 도 없어 대조할 방법이 아예 없었다.
//
// 이제 서버가 file_hash·path·prev_hash 를 함께 주므로, 봉인하는 그 자리에서 고리를 다시
// 계산해 서버가 **내 내용으로** 고리를 만들었는지 확인한다. 단순 echo 보다 강하다 —
// 값 하나만 달라도 해시가 어긋난다.
//
// 계산식은 검증기 3종·서버와 **같은 계약**이다. 한쪽만 고치면 그 순간 갈린다:
//   서버      attestation/plugin.rs::plugin_digest
//   제출자료  packagecore.chainCheckFile 의 머리말
//   검증기    verify-unix / verify-windows / check.js
export const CHAIN_ZERO = "0".repeat(64);

/// 고리 해시의 원문. 파이프로 이은 여섯 조각 — 순서와 구분자가 곧 포맷이다.
export function entryPreimage(
  userId: string, seq: number, prevHash: string, fileHash: string, path: string, receivedAt: number,
): string {
  return `${userId}|${seq}|${prevHash}|${fileHash}|${path}|${receivedAt}`;
}

export interface SealAck {
  seq?: number;
  file_hash?: string;
  path?: string;
  prev_hash?: string;
  entry_hash?: string;
  received_at?: number;
}

export type AckVerdict =
  | { ok: true }
  | { ok: false; why: "sent-mismatch" | "link-mismatch" }
  | { ok: null };   // 확인할 수 없음(구서버·계정 미상) — 실패로 취급하지 않는다

/// 봉인 응답이 내가 보낸 내용을 담고 있는가.
///
/// 두 가지를 본다:
///   (1) 돌려준 file_hash 가 내가 보낸 것과 같은가            — 내 것이 맞는가
///   (2) entry_hash 가 그 여섯 조각으로 다시 계산되는가        — 그 내용으로 고리를 만들었는가
///
/// 확인할 수 없으면(구서버가 필드를 안 주거나 계정 id 를 모르면) **실패로 만들지 않는다.**
/// 봉인 자체는 성공했을 수 있는데 확인 수단이 없다고 되돌리면 그게 더 나쁘다.
export async function verifySealAck(
  ack: SealAck, sentHash: string, userId: string | undefined,
  sha256: (s: string) => Promise<string>,
): Promise<AckVerdict> {
  if (!userId || !ack.entry_hash || !ack.file_hash || ack.prev_hash === undefined
      || ack.path === undefined || ack.seq === undefined || ack.received_at === undefined) {
    return { ok: null };
  }
  if (ack.file_hash.toLowerCase() !== sentHash.toLowerCase()) return { ok: false, why: "sent-mismatch" };
  const got = await sha256(entryPreimage(
    userId, ack.seq, ack.prev_hash, ack.file_hash, ack.path, ack.received_at));
  if (got.toLowerCase() !== ack.entry_hash.toLowerCase()) return { ok: false, why: "link-mismatch" };
  return { ok: true };
}
