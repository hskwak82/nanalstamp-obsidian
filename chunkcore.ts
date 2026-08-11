// 스토리지 v2a: CDC(content-defined chunking) 분할 + manifest — 순수 모듈(Obsidian API 무의존).
// FastCDC 계열 단순화: gear 롤링 해시로 내용 기준 경계를 정해, 중간 삽입에도 뒤 조각이 재사용된다.
// 파라미터·gear 테이블은 절대 바꾸지 말 것 — 바뀌면 같은 파일이 다른 조각이 되어 dedup이 깨진다(포맷의 일부).

/** 결정적 gear 테이블(xorshift32, 시드 고정) — 구현 간 동일해야 dedup 성립. */
const GEAR: Uint32Array = (() => {
  const t = new Uint32Array(256);
  let s = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    s ^= (s << 13) >>> 0; s >>>= 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0; s >>>= 0;
    t[i] = s;
  }
  return t;
})();

export const CHUNK_MIN = 256 * 1024;        // Glacier 전환 임계(128KB) 상회
export const CHUNK_MAX = 4 * 1024 * 1024;
const AVG_MASK = 0xfffff;                    // 하위 20비트 0 → 평균 ~1MiB 경계
/** 이 크기 이하 원본은 청크 없이 단일 객체(v1 경로). */
export const CHUNK_THRESHOLD = 512 * 1024;

/** 버퍼 앞에서부터 **다음 조각의 끝**(바이트 수)을 찾는다. 경계 규칙은 여기 한 곳에만 있다.
 *
 * 왜 따로 빼는가: 대형 첨부를 스트리밍으로 올리려면 파일을 조금씩 읽으며 같은 경계를 찾아야 하는데,
 * 규칙이 두 벌이 되면 언젠가 갈리고 그 순간 **같은 파일이 다른 조각이 되어 dedup 과 기존 manifest 가
 * 깨진다**(포맷의 일부다). 전체 버퍼 방식과 스트리밍이 이 함수를 공유하면 갈릴 수가 없다.
 *
 * 호출자 계약: `len` 은 buf 에 유효한 바이트 수이고, **CHUNK_MAX 까지 채웠거나 파일 끝**이어야 한다.
 * 덜 찬 상태로 부르면 경계가 앞당겨져 전체 버퍼 방식과 결과가 달라진다. */
export function nextCut(buf: Uint8Array, len: number): number {
  const end = Math.min(CHUNK_MAX, len);
  let h = 0;
  for (let i = Math.min(CHUNK_MIN, end); i < end; i++) {
    h = (((h << 1) >>> 0) + GEAR[buf[i]]) >>> 0;
    if ((h & AVG_MASK) === 0) return i + 1;
  }
  return end;
}

/** 내용 기준 분할. 마지막 조각만 CHUNK_MIN 미만일 수 있다. 빈 입력은 빈 배열.
 * 반환 조각은 입력 버퍼의 subarray 뷰 — 오래 보관하려면 slice할 것. */
export function cdcChunks(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  while (start < data.byteLength) {
    const cut = nextCut(data.subarray(start), data.byteLength - start);
    out.push(data.subarray(start, start + cut));
    start += cut;
  }
  return out;
}

/** chash/csize는 청크 업로드 암호화(다음 태스크) 시 채워지는 암호문 해시·크기 — 평문(hash/size)과 별개. */
export interface ManifestChunk { hash: string; size: number; chash?: string; csize?: number }

/** manifest 직렬화 — 조각 순서·크기·해시. 이어붙이면 원문(전체 해시 == 봉인 해시로 재검증).
 * 필드를 명시 투영해 만든다 — 호출자 객체의 프로퍼티 순서·잉여 필드에 의존하지 않고,
 * enc=false에 chash가 섞이는 것도 구조적으로 차단(같은 입력 = 같은 JSON 문자열, HEAD dedup의 근거).
 * enc=false(기본, v1) 경로 출력은 기존과 바이트 동일해야 한다 — 골든 테스트로 고정. */
export function buildManifest(chunks: ManifestChunk[], totalSize: number, enc = false): string {
  const cs = chunks.map((c) => enc
    ? { hash: c.hash, size: c.size, chash: c.chash, csize: c.csize }
    : { hash: c.hash, size: c.size });
  return JSON.stringify(
    enc ? { version: 1, total_size: totalSize, enc: 1, chunks: cs } : { version: 1, total_size: totalSize, chunks: cs },
  );
}

/** manifest 파싱 — 형식 불량은 null(호출측이 손상 처리). enc 필드 없는 v1(평문) manifest도 하위호환 파싱된다.
 * 교차 불변식: enc=1이면 모든 청크에 유효한 chash·csize가 있어야 한다(v2 계약 — 복호 경로가 청크별 재확인 불필요). */
export function parseManifest(raw: string): { totalSize: number; chunks: ManifestChunk[]; enc: boolean } | null {
  try {
    const j = JSON.parse(raw) as { version?: number; chunks?: unknown[]; total_size?: number; enc?: number } | null;
    if (j?.version !== 1 || !Array.isArray(j.chunks) || typeof j.total_size !== "number") return null;
    if (!Number.isSafeInteger(j.total_size) || j.total_size <= 0) return null;
    const enc = j.enc === 1;
    const chunks: ManifestChunk[] = j.chunks.map((c: unknown) => {
      const o = c as { hash?: unknown; size?: unknown; chash?: unknown; csize?: unknown };
      const chunk: ManifestChunk = { hash: String(o.hash), size: Number(o.size) };
      if (o.chash !== undefined) chunk.chash = String(o.chash);
      if (o.csize !== undefined) chunk.csize = Number(o.csize);
      return chunk;
    });
    if (!chunks.every((c) =>
      /^[0-9a-f]{64}$/.test(c.hash) && Number.isSafeInteger(c.size) && c.size > 0 &&
      (c.chash === undefined ? !enc : /^[0-9a-f]{64}$/.test(c.chash)) &&
      (c.csize === undefined ? !enc : (Number.isSafeInteger(c.csize) && c.csize > 0))
    )) return null;
    return { totalSize: j.total_size, chunks, enc };
  } catch { return null; }
}
