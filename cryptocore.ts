// nanalStamp 클라이언트 암호화 코어 (Phase D 크립토-슈레딩) — 순수, node --test 검증.
// 수렴 암호화: (키, nonce)가 HKDF(DEK, salt, info=도메인:평문해시)에서 결정적으로 파생 →
// 같은 사용자의 같은 평문 = 같은 암호문(콘텐츠주소·중복제거 유지). GCM nonce 재사용 안전성은
// "평문해시가 다르면 키·nonce가 다르다"로 보장, 같은 해시·다른 용도(원문 vs manifest)는 도메인으로 분리.
// 설계: docs/superpowers/specs/2026-07-20-crypto-shredding-design.md

export const ENC_MAGIC = new Uint8Array([0x4e, 0x53, 0x45, 0x31]); // "NSE1"
export type EncDomain = "blob" | "manifest" | "name" | "vault" | "scope";

// 경계값: >= 4(매직) + 16(GCM 태그 최소 길이). "> 20"이 아니라 ">= 20"을 택한 이유는
// 빈 평문(0바이트)의 암호문이 정확히 매직 4B + 태그 16B = 20B가 되기 때문 — 빈 파일도
// 봉인·복원 라운드트립이 성립해야 이 함수가 "암호화된 프레임인가"를 일관되게 답한다.
// (실사용에서 빈 노트는 봉인 대상에서 걸러지지만, 코어 모듈 자체의 경계는 그 상위 정책에
// 기대지 않고 독립적으로 옳아야 한다.)
export function isEncrypted(data: Uint8Array): boolean {
  return data.length >= 4 + 16 &&
    data[0] === 0x4e && data[1] === 0x53 && data[2] === 0x45 && data[3] === 0x31;
}

async function deriveKeyNonce(dekB64: string, domain: EncDomain, plainHash: string) {
  const dek = Uint8Array.from(atob(dekB64), (c) => c.charCodeAt(0));
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes");
  const ikm = await crypto.subtle.importKey("raw", dek as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256",
      salt: new TextEncoder().encode("nanalstamp-enc-v1"),
      info: new TextEncoder().encode(`${domain}:${plainHash.toLowerCase()}`) },
    ikm, (32 + 12) * 8);
  const raw = new Uint8Array(bits);
  const key = await crypto.subtle.importKey("raw", raw.slice(0, 32) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, nonce: raw.slice(32) };
}

/**
 * 평문 → NSE1 ‖ AES-256-GCM(ct‖tag). 결정적(수렴).
 * 호출자 계약: plainHash는 data를 유일 결정하는 충돌저항적 커밋먼트여야 한다
 * (blob/manifest: plainHash === sha256(data), name: plainHash === 경로해시이고 data === 그 경로 원문).
 * 위반 시 같은 (키,nonce)로 다른 평문이 암호화되어 GCM 안전성이 붕괴한다.
 */
export async function encryptBlob(dekB64: string, plainHash: string, domain: EncDomain, data: Uint8Array): Promise<Uint8Array> {
  const { key, nonce } = await deriveKeyNonce(dekB64, domain, plainHash);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, data as BufferSource));
  const out = new Uint8Array(4 + ct.length);
  out.set(ENC_MAGIC, 0);
  out.set(ct, 4);
  return out;
}

/** NSE1 프레임 복호 — 변조·키 불일치는 reject. */
export async function decryptBlob(dekB64: string, plainHash: string, domain: EncDomain, data: Uint8Array): Promise<Uint8Array> {
  if (!isEncrypted(data)) throw new Error("not an NSE1 frame");
  const { key, nonce } = await deriveKeyNonce(dekB64, domain, plainHash);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, data.subarray(4) as BufferSource);
  return new Uint8Array(pt);
}
