// nanalStamp 스토리지(S3 WORM) 순수 헬퍼 — main.ts에서 분리해 node --test로 검증한다.
// (dashcore/sealscope/archivemsg와 같은 패턴: Obsidian API 의존 없음)

/** sha256 hex(64자) → digest 원바이트의 base64. x-amz-checksum-sha256 헤더 값. 잘못된 입력은 throw. */
export function hexToBase64(hex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("invalid sha256 hex");
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  // btoa: Obsidian(렌더러)·node 18+ 모두 전역 존재
  return btoa(bin);
}

/** 파일 경로 → blob 확장자(소문자 영숫자 1~12자 — 서버 blob_key 규격). 규격 밖이면 "bin". */
export function blobExt(path: string): string {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(path);
  return m ? m[1].toLowerCase() : "bin";
}

/** proof blob 확장자 — 원문과 같은 해시 키에 확장자만 다르게 저장된다(u/<uid>/sha256-<원문해시>.proof). */
export const PROOF_EXT = "proof";

/** 업로드 content-type 추정(대표 확장자만, 나머지는 octet-stream). */
export function blobContentType(path: string): string {
  const e = blobExt(path);
  if (e === "md") return "text/markdown";
  if (e === "png") return "image/png";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "svg") return "image/svg+xml";
  if (e === "pdf") return "application/pdf";
  if (e === "csv") return "text/csv";
  if (e === "json" || e === "excalidraw" || e === "canvas") return "application/json";
  return "application/octet-stream";
}

/** 복원 파일의 vault 상대경로. safe는 safeName(notePath) 결과(md는 확장자 제거됨, 첨부는 확장자 포함). */
export function restoredPath(safe: string, hash: string, isMd: boolean): string {
  const tag = hash.slice(0, 8);
  if (isMd) return `nanalStamp/restored/${safe}.${tag}.md`;
  const m = /^(.*)\.([A-Za-z0-9]{1,12})$/.exec(safe);
  return m ? `nanalStamp/restored/${m[1]}.${tag}.${m[2]}` : `nanalStamp/restored/${safe}.${tag}`;
}

/** C1: presign size 필드용 업로드 본문 크기(바이트). 문자열은 UTF-8 인코딩 기준. */
export function bodyByteSize(body: string | ArrayBuffer): number {
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

/** C1: 사용량 바 표기용 바이트 포맷. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** C2: 스토리지 엔드포인트 — 팀 custody(nanal)면 /storage/team/*, 아니면 /storage/*. */
export function storageEndpoint(base: string, team: boolean, ep: "presign" | "geturl" | "exists" | "usage" | "key"): string {
  return `${base}/storage/${team ? "team/" : ""}${ep}`;
}
