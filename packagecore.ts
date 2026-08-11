// 제출 패키지 조립 — 원본 + 증명을 zip 한 장으로 묶어 남에게 준다.
//
// 받는 사람은 개발자가 아니다(감사관·심사위원·변호사). 그래서 판정 기준은 하나다:
// **아무것도 설치하지 않고 3분 안에 결과를 볼 수 있는가.** 그 결과를 내는 검증기는
// plans/submission/ 에 있고, 이 파일은 그 검증기가 읽을 자료를 만든다 —
// 형식이 어긋나면 심사자 화면에서 "확인되지 않았습니다"가 뜬다. 형식은 계약이다.
//
// zip 을 직접 쓰는 이유: JSZip 을 넣으면 번들이 커지고, 무엇보다 **패키지 안에 우리가
// 만들지 않은 코드**가 하나 더 늘어난다. 저장(0)·deflate(8) 두 방식만 쓰는 zip 은
// 200줄이면 되고, 브라우저 CompressionStream 이 압축을 대신해 준다.

export interface ChainEntry {
  seq: number;
  prev_hash: string;
  file_hash: string;
  path: string;        // 경로 **해시**(서버는 노트 경로를 모른다)
  received_at: number;
  entry_hash: string;
}

export interface AnchorInfo {
  head_seq: number;
  head_entry_hash: string;
  block_height: number;
  merkle_root: string | null;
  ots_b64: string;
}

/// 점검자 서명 — 연구노트 자체규정이 요구하는 **인적 확인**.
/// 사슬·비트코인은 "그때 그 내용이 있었다"를 말하지만 "사람이 확인했다"는 말하지 못한다.
export interface ReviewSig {
  seq: number;
  statement: string;              // reviewed | approved
  merkle_root?: string | null;    // 묶음의 서명 대상(항목 1개면 그 기록의 해시)
  viewed_root?: string | null;    // 실제로 열어 본 항목들의 루트
  item_count?: number;
  verdict_root?: string | null;   // 항목별 판정까지 묶은 서명(nsrd1)이면 있다
  reviewer_user_id: string | null;
  reviewer_email: string | null;
  reviewed_at: number | null;
  payload_hash: string | null;
  signature: string | null;
}

export interface PackageData {
  user_id: string;
  chain: ChainEntry[];
  anchors: AnchorInfo[];
  reviews?: ReviewSig[];
  covered_to: number;
  last_seq: number;
  pending_from: number | null;
}

/// 패키지에 담을 파일 하나 — vault 실제 경로와, 그 파일이 몇 번째 기록인지.
export interface PackageFile {
  vaultPath: string;   // vault 안의 원래 경로
  seq: number;
  fileHash: string;
  data: Uint8Array;
}

// ── zip 쓰기 ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipItem { name: string; data: Uint8Array; mtime?: number }

/// epoch(초) → MS-DOS 시각·날짜 쌍. zip 은 1980년을 기준으로 하는 옛 포맷을 쓴다.
export function dosStamp(epoch?: number): [number, number] {
  const d = epoch ? new Date(epoch * 1000) : new Date();
  const y = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/// 파일 권한. 더블클릭으로 도는 검사 프로그램만 실행 비트를 준다 —
/// 연구노트에까지 실행 권한을 주면 받는 쪽 보안 정책에 걸릴 수 있다.
export function unixMode(name: string): number {
  const exec = /\.(command|sh)$/i.test(name);
  return exec ? 0o100755 : 0o100644;
}

/// deflate-raw 로 줄여 본다. 줄지 않으면(이미 압축된 png·pdf) 저장 방식으로 둔다 —
/// 압축이 커지는 경우가 실제로 있고, 그러면 파일만 키운다.
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  // typeof 가드는 의도다(window 참조 아님): 이 모듈은 플러그인·포털·node 테스트 세 런타임이
  // 공유한다 — 서버 포털 번들(server/portal/packagecore.js)과 `node --test` 에는 window 가 없다.
  const CS = typeof CompressionStream !== "undefined" ? CompressionStream : undefined;
  if (!CS || data.length === 0) return null;
  try {
    const cs = new CS("deflate-raw");
    const buf = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(cs)).arrayBuffer();
    const out = new Uint8Array(buf);
    return out.length < data.length ? out : null;
  } catch {
    return null;   // 이 런타임에 없으면 저장 방식으로 — 결과물은 똑같이 열린다
  }
}

/// zip 한 장으로 묶는다. 파일명은 UTF-8(플래그 비트 11)로 넣어 한글 폴더명이 깨지지 않게 한다.
export async function buildZip(items: ZipItem[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const it of items) {
    const nameBytes = enc.encode(it.name);
    const crc = crc32(it.data);
    const packed = await deflateRaw(it.data);
    const method = packed ? 8 : 0;
    const body = packed ?? it.data;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // 버전
    lv.setUint16(6, 0x0800, true);      // 비트 11 = 파일명이 UTF-8
    lv.setUint16(8, method, true);
    // MS-DOS 시각. 비워 두면 1980-01-01 로 풀려 **연구노트가 1980년 파일로 보인다**(실측).
    // 노트에는 그 버전이 봉인된 시각을 준다 — 파일 탐색기에서 정렬·확인이 자연스러워진다.
    // (zip 시각은 누구나 고칠 수 있어 **증거가 아니다.** 증거는 사슬과 비트코인이다.)
    const [dosTime, dosDate] = dosStamp(it.mtime);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, it.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    // "만든 곳" 상위 바이트 = 3(Unix). **한글 파일명이 풀리느냐가 여기에 달려 있다**(2026-07-29 실측):
    // macOS 기본 unzip 은 UTF-8 플래그를 보지 않고, 이 값이 0(MS-DOS)이면 파일명을 CP437 로
    // 해석해 "Illegal byte sequence" 로 압축 해제 자체가 실패한다. Unix 로 표기하면 로컬
    // 인코딩(UTF-8)으로 읽는다. 플래그(비트 11)도 그대로 두어 윈도우 탐색기도 만족시킨다.
    cv.setUint16(4, 0x031e, true);   // 0x03=Unix, 0x1e=zip 3.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, it.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // 유닉스 권한 — 비워 두면 **mode 000** 으로 풀려 심사자가 안내문조차 열지 못한다(실측).
    // 검사 프로그램은 더블클릭이 진입점이라 실행 권한이 반드시 필요하다.
    cv.setUint32(38, (unixMode(it.name) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);

    chunks.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }

  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cenSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

// ── 증명 파일들 ─────────────────────────────────────────────────────────────
//
// 이 세 파일의 형식이 곧 검증기와의 계약이다. 열은 `|` 로 나누고, 주석은 `#` 로 시작한다.
// 첫 줄에 계산식을 적어 두는 이유: 스크립트를 하나도 쓰지 않고 손으로 확인하려는 심사자가
// 계산식을 어디서도 찾지 못하면 방법 3(표준 도구만 쓰기)이 성립하지 않는다.

export function chainCheckFile(user_id: string, chain: ChainEntry[]): string {
  const head =
    "# 사슬 재계산용 자료. 형식: 순번|앞기록|내용해시|경로해시|시각|이기록(정답)\n" +
    `# 계산식: 이기록 = SHA256( ${user_id}|순번|앞기록|내용해시|경로해시|시각 )\n`;
  return head + chain
    .map((e) => `${e.seq}|${e.prev_hash}|${e.file_hash}|${e.path}|${e.received_at}|${e.entry_hash}`)
    .join("\n") + "\n";
}

/// 사슬의 각 기록을 이 자료가 어떻게 처리했는지.
///
/// **왜 필요한가**(2026-07-30): 이 자료는 사슬의 부분집합이다 — 그 시점 스냅샷이므로 옛 버전과
/// 앵커 대기분이 빠진다. 그래서 "사슬 15건, 담긴 파일 5건"이 정상이고, 바로 그 때문에
/// **불리한 기록을 빼도 구별할 수 없었다.** 빠진 것을 침묵하지 않고 한 줄씩 밝힌다.
///
/// 처분 여섯 중 앞의 셋(대체됨·기준시점이후·앵커대기)은 **검증기가 사슬만으로 다시 계산한다** —
/// 사슬은 .ots 에 고정돼 있어 고칠 수 없으므로 이 셋은 위조가 통하지 않는다.
/// 뒤의 둘(범위밖·원본없음)은 발급자의 설명이고 자료 안에서는 확인할 수 없다 — 그렇게 표시한다.
export type Disposition = "포함" | "대체됨" | "기준시점이후" | "앵커대기" | "대상아님" | "범위밖" | "경로미상" | "원본없음" | "제외함";

/// 사슬의 경로 항목이 **vault 파일**을 가리키는가.
///
/// 플러그인은 노트 경로를 늘 해시해서 보낸다(서버는 경로를 모른다). 그래서 이 자리에
/// 평문이 들어 있으면 그것은 파일이 아니라 **서버가 만든 기록**이다 — 업무함의
/// `_task/<uuid>/amend/<n>` 같은 것. 담을 원본 파일이 애초에 없으므로 "있어야 할 목록"에서
/// 빼야 한다. 빼지 않으면 정상 자료마다 "빠진 기록 N건"이 떠서 진짜 신호를 덮는다.
/// 검증기 3종도 같은 규칙으로 판정한다(발급자 주장이 아니라 스스로 계산한다).
export function isFilePath(path: string): boolean { return /^[0-9a-f]{64}$/.test(path); }

const DISP_NOTE: Record<Disposition, string> = {
  "포함": "",
  "대체됨": "같은 파일의 더 나중 기록이 이 자료에 있습니다",
  "기준시점이후": "기준 시점보다 나중에 봉인됐습니다",
  "앵커대기": "아직 비트코인에 고정되지 않았습니다",
  "대상아님": "vault 파일이 아닌 시스템 기록입니다(담을 원본이 없습니다)",
  "범위밖": "발급자가 고른 범위 밖입니다(자료 안에서는 확인 불가)",
  // 이름을 모르면 원본을 찾을 수도, 범위 안인지 판정할 수도 없다. 예전에는 이 경우를
  // "범위밖"이라 적었는데 그건 **거짓말이다** — 범위 밖인지조차 모른다(2026-07-31 실측:
  // 제목만 바꿔도 이렇게 되어 원본이 통째로 빠지면서 "범위밖"이라 적혔다).
  "경로미상": "이 기록이 어느 파일이었는지 알아내지 못했습니다(자료 안에서는 확인 불가)",
  "원본없음": "원본을 어디에서도 찾지 못했습니다(자료 안에서는 확인 불가)",
  // 증거를 전부 낼 의무는 없다. 다만 **낸 것이 전부인 척하면 안 된다** — 뺐다는 사실까지
  // 숨기면 그때부터 위변조다. 이름은 안 적더라도 개수와 사유는 남는다.
  "제외함": "발급자가 이 원본을 담지 않기로 했습니다(봉인 사실은 사슬에 남아 있습니다)",
};

/// 이 자료에 들어가야 할 기록의 순번. **snapshotAt 을 그대로 쓴다** — 규칙을 옮겨 적으면
/// 언젠가 갈리고, 그러면 없는 누락을 있다고 하거나 있는 누락을 놓친다.
/// (검증기 3종도 같은 규칙을 재현한다. 어긋나면 공격시험이 잡도록 시나리오를 뒀다.)
export function expectedSeqs(chain: ChainEntry[], atEpoch: number, coveredTo: number): Set<number> {
  return new Set(Array.from(snapshotAt(chain, atEpoch, coveredTo).values()).map((e) => e.seq));
}

export function dispositionOf(
  e: ChainEntry, atEpoch: number, coveredTo: number, expected: Set<number>,
  included: Set<number>, reasons: Map<number, Disposition>,
): Disposition {
  // 담겼으면 이유 불문 "포함"이다. 요약 PDF 는 방금 봉인돼 앵커 밖이지만 파일은 들어 있다 —
  // 이 순서가 아니면 "앵커대기라는데 파일은 있다"는 모순이 생긴다.
  if (included.has(e.seq)) return "포함";
  if (!isFilePath(e.path)) return "대상아님";
  if (e.received_at > atEpoch) return "기준시점이후";
  if (e.seq > coveredTo) return "앵커대기";
  if (!expected.has(e.seq)) return "대체됨";
  return reasons.get(e.seq) ?? "원본없음";
}

export function dispositionFile(
  chain: ChainEntry[], atEpoch: number, coveredTo: number,
  included: Set<number>, reasons: Map<number, Disposition>,
): string {
  const expected = expectedSeqs(chain, atEpoch, coveredTo);
  const head =
    "# 이 자료가 사슬의 각 기록을 어떻게 처리했는지. 형식: 순번|처분|설명\n" +
    `# 기준시점 ${atEpoch} · 비트코인이 덮는 순번 ${coveredTo} · 사슬 ${chain.length}건\n` +
    "# 검증기는 대체됨·기준시점이후·앵커대기 를 사슬만으로 다시 계산해 확인합니다.\n" +
    "# 범위밖·원본없음 은 발급자의 설명이며 이 자료 안에서는 확인할 수 없습니다.\n";
  return head + chain
    .map((e) => {
      const d = dispositionOf(e, atEpoch, coveredTo, expected, included, reasons);
      return `${e.seq}|${d}|${DISP_NOTE[d]}`;
    })
    .join("\n") + "\n";
}

/// 요약 PDF 도 봉인해 이 목록에 넣는다 — 그러면 검증기가 노트와 **같은 방식으로** 대조하고,
/// 다음 앵커에서 비트코인이 보증한다. 발급자 서명을 믿는 것보다 강하다.
/// 만든 당일에는 아직 앵커 전이라 "고정 대기"로 표시된다(그 사이는 서명이 메운다).
export function fileSeqFile(files: PackageFile[], pdf?: { seq: number; hash: string }): string {
  const head =
    "# 각 파일이 몇 번째 기록으로 봉인됐는지. 형식: 순번|내용해시|파일\n" +
    "# .ots 가 덮는 순번보다 크면 그 파일은 아직 비트코인에 고정되지 않은 것입니다.\n";
  const rows = files.map((f) => `${f.seq}|${f.fileHash}|노트/${f.vaultPath}`);
  // PDF 는 '노트/' 밖에 있으므로 접두를 붙이지 않는다 — 검증기는 적힌 경로 그대로 찾는다.
  if (pdf) rows.push(`${pdf.seq}|${pdf.hash}|증명서(요약).pdf`);
  return head + rows.join("\n") + "\n";
}

export function blockInfoFile(anchors: AnchorInfo[]): string {
  const head =
    "# 이 .ots 파일들이 주장하는 비트코인 블록과 머클루트입니다.\n" +
    "# 형식: 블록번호|머클루트|파일명   (검증 스크립트가 실제 블록과 대조합니다)\n";
  return head + anchors
    .map((a) => `${a.block_height}|${a.merkle_root ?? ""}|${otsFileName(a)}`)
    .join("\n") + "\n";
}

/// 점검 서명을 **스크립트가 읽을 수 있는 표**로도 낸다.
/// 웹은 JSON 을 읽지만, 맥·윈도우 검증기는 표 형식이 훨씬 다루기 쉽다 — 형식이 갈리면
/// 세 검증기의 결과가 갈린다(그것이 이 제품에서 가장 비싼 실패다).
export function reviewFile(reviews: ReviewSig[]): string {
  const head =
    "# 점검자 서명. 형식: 순번|판정|점검자|시각|서명대상해시|열람루트|묶음루트|묶음건수|판정루트\n" +
    "# 판정 reviewed=점검함 · approved=승인함\n" +
    "# 계산식: 서명대상해시 = SHA256( nsrd1|묶음루트|점검자|시각|판정|열람루트|판정루트 )\n" +
    "#   판정루트가 없으면(-) SHA256( nsrb1|묶음루트|점검자|시각|판정|열람루트 )\n" +
    "#   묶음루트 = 그 점검에 든 기록들의 머클 루트(1건이면 그 기록의 해시)\n" +
    "#   열람루트 = 점검자가 실제로 열어 본 기록들의 머클 루트(안 봤으면 -)\n";
  return head + reviews
    .map((r) => [r.seq, r.statement, r.reviewer_email || r.reviewer_user_id || "-",
                 r.reviewed_at ?? 0, r.payload_hash || "-", r.viewed_root || "-",
                 r.merkle_root || "-", r.item_count ?? 1, r.verdict_root || "-"].join("|"))
    .join("\n") + "\n";
}

export function otsFileName(a: AnchorInfo): string {
  return `블록${a.block_height}_head${a.head_seq}.ots`;
}

// ── 범위 계산 ───────────────────────────────────────────────────────────────

/// 어떤 파일이 패키지에 들어갈 수 있는가.
///
/// **앵커 대기분은 넣지 않는다.** 서버 서명만 있는 기록은 "발급사가 그렇다고 한다"는 뜻이라
/// 제3자에게 증명력이 약하다. 넣어 두면 심사자 화면에 "아직 고정 전"이 뜨고, 그건 자료
/// 전체의 신뢰를 깎는다 — 차라리 앵커가 확정된 뒤에 만드는 게 낫다.
export function splitByCoverage<T extends { seq: number }>(
  files: T[], coveredTo: number,
): { included: T[]; pending: T[] } {
  const included: T[] = [];
  const pending: T[] = [];
  for (const f of files) (f.seq <= coveredTo ? included : pending).push(f);
  return { included, pending };
}

/// vault 파일 경로 → 사슬에서 그 파일의 **가장 나중** 기록을 찾는다.
///
/// 같은 파일이 여러 번 봉인되면 기록도 여러 개다. 제출은 "제출 시점의 내용"이 대상이므로
/// 가장 나중 것을 쓴다 — 다만 **앵커가 덮는 범위 안에서** 가장 나중이어야 한다.
/// 그러지 않으면 오늘 고친 내용이 잡혀 "아직 고정 전"으로 빠지고, 어제까지의 멀쩡한
/// 봉인본이 있는데도 그 파일이 통째로 패키지에서 사라진다.
export function latestCoveredSeq(
  chain: ChainEntry[], pathHash: string, fileHash: string, coveredTo: number,
): ChainEntry | null {
  let best: ChainEntry | null = null;
  for (const e of chain) {
    if (e.path !== pathHash) continue;
    if (e.file_hash !== fileHash) continue;
    if (e.seq > coveredTo) continue;
    if (!best || e.seq > best.seq) best = e;
  }
  return best;
}

/// 특정 날짜 시점의 "그 파일의 마지막 봉인 버전"을 경로별로 고른다.
///
/// 왜 필요한가: 연구노트 제출은 대개 **과제 기간 단위**다("2026-03-31 기준"). 지금 vault
/// 내용으로만 만들면 그 뒤에 고친 것이 섞이고, 그날 이후 지운 노트는 아예 빠진다.
///
/// 규칙은 두 가지뿐이다:
///   (1) `received_at <= 기준시각` 인 기록만 본다
///   (2) 그중 앵커가 덮는(`seq <= coveredTo`) 마지막 것을 경로마다 하나씩 고른다
/// 경로가 해시라 이름은 알 수 없다 — 이름은 vault 를 가진 쪽이 붙인다.
export function snapshotAt(
  chain: ChainEntry[], atEpoch: number, coveredTo: number,
): Map<string, ChainEntry> {
  const best = new Map<string, ChainEntry>();
  for (const e of chain) {
    if (!isFilePath(e.path)) continue;   // 서버가 만든 기록은 담을 파일이 없다(isFilePath 주석 참조)
    if (e.received_at > atEpoch) continue;
    if (e.seq > coveredTo) continue;
    const prev = best.get(e.path);
    if (!prev || e.seq > prev.seq) best.set(e.path, e);
  }
  return best;
}

/// 그 날의 끝(로컬 자정 직전) epoch. 날짜를 고르면 "그날까지"가 자연스러운 뜻이다.
export function endOfDayEpoch(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000);
}

/// 원본을 어디서 가져올 것인가.
///
/// **기기는 잃어버릴 수 있다.** nanalStorage 가 있는 이유가 그것이다 — 로컬 아카이브가
/// 없거나 그 기간을 담고 있지 않으면 nanalStorage 가 유일한 출처가 된다. 그래서 기본은
/// "기기 우선, 없으면 nanalStorage"이고, 한쪽만 쓰도록 고를 수도 있게 둔다.
///
/// 어느 쪽에서 가져오든 **해시가 사슬과 맞아야** 담기므로 증거력은 같다(맞지 않으면 제외).
export type OriginSource = "auto" | "device" | "storage";

/// 조회 결과를 출처별로 센다 — 만들기 전에 "어디서 몇 개"를 보여주기 위한 것.
export interface OriginTally { device: number; storage: number; missing: number }

export function tallyOrigins(rows: Array<{ from: "device" | "storage" | null }>): OriginTally {
  const t: OriginTally = { device: 0, storage: 0, missing: 0 };
  for (const r of rows) {
    if (r.from === "device") t.device++;
    else if (r.from === "storage") t.storage++;
    else t.missing++;
  }
  return t;
}

/// 앵커가 주장하는 머클루트가 실제 블록의 것과 같은가.
///
/// **왜 만들 때 확인하는가**(2026-07-29): 조립된 proof 가 실제 블록과 어긋나는 앵커가
/// 실제로 있었다(head_seq 1301 의 3건 전부). 그대로 실으면 심사자 화면에서
/// "확인되지 않았습니다"가 뜨고, 그때는 제출자가 손쓸 수 없다. 만드는 쪽에서 걸러
/// **넣은 것은 반드시 통과하도록** 한다 — 통과하지 못할 증거는 증거가 아니다.
export function partitionVerifiedAnchors(
  anchors: AnchorInfo[], real: Map<number, string | null>,
): { good: AnchorInfo[]; bad: AnchorInfo[] } {
  const good: AnchorInfo[] = [];
  const bad: AnchorInfo[] = [];
  for (const a of anchors) {
    const r = real.get(a.block_height);
    // 조회하지 못한 것(null)은 **버리지 않는다** — 인터넷 문제로 멀쩡한 증거를 떨어뜨리면
    // 오프라인 환경에서 패키지를 아예 못 만든다. 값이 와 있는데 다를 때만 뺀다.
    if (r === undefined || r === null || r === a.merkle_root) good.push(a);
    else bad.push(a);
  }
  return { good, bad };
}

/// 앵커가 덮는 최대 순번 — 걸러낸 뒤 다시 계산해야 한다.
/// 뺀 앵커의 범위를 그대로 두면 "고정됐다"고 표시된 파일이 실제로는 덮이지 않는다.
export function coverageOf(anchors: AnchorInfo[]): number {
  return anchors.reduce((m, a) => Math.max(m, a.head_seq), -1);
}

/// 안내문의 자리표시자를 이 자료의 실제 값으로 채운다.
///
/// **왜 필요한가**(2026-07-29 실측): 템플릿에 만들 때 쓴 예시 값(파일 5개·블록 #959,948)이
/// 그대로 박혀 있어, 209개짜리 자료에도 같은 숫자가 들어갔다. 심사자가 가장 먼저 여는
/// 문서가 사실과 다른 숫자를 말하는 것은 검증 결함보다 앞선 문제다.
///
/// 채우지 못한 자리는 남겨 두지 않는다 — `{{파일수}}` 가 그대로 보이면 미완성으로 읽힌다.
export function fillReadme(html: string, v: Record<string, string>): string {
  return html.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => v[k.trim()] ?? "");
}

/// 안내문에 넣을 값. 요약이지 증거가 아니다 — 그 사실도 안내문이 스스로 밝힌다.
export function readmeFields(
  files: PackageFile[], chain: ChainEntry[], anchors: AnchorInfo[],
  atYmd: string | undefined, todayYmd: string,
): Record<string, string> {
  const seqs = new Set(files.map((f) => f.seq));
  const times = chain.filter((e) => seqs.has(e.seq)).map((e) => e.received_at).sort((a, b) => a - b);
  const day = (t: number) => new Date(t * 1000).toLocaleDateString("ko-KR");
  return {
    기준시점: atYmd || todayYmd,
    기준설명: atYmd ? " (지정하신 기준일)" : " (이 자료를 만든 날)",
    파일수: String(files.length),
    사슬건수: String(chain.length),
    // 예전 문구는 "그때까지 봉인된 파일 N개"였는데 **사실이 아니었다** — 이 자료는 사슬의
    // 부분집합이고 실제로는 15건 중 5건만 담겨 있었다(2026-07-30). 나머지가 있다는 것을 밝힌다.
    처분안내: chain.length > files.length
      ? `사슬에는 기록이 ${chain.length}건 있습니다 — 나머지 ${chain.length - files.length}건이 왜 담기지 않았는지는 ` +
        `<code>증명/_처분내역.txt</code> 에 한 줄씩 적혀 있고, 확인 프로그램이 그 설명을 사슬과 맞춰 봅니다.`
      : "",
    기간: times.length ? (times[0] === times[times.length - 1]
      ? day(times[0]) : `${day(times[0])} ~ ${day(times[times.length - 1])}`) : "—",
    블록목록: anchors.length
      ? anchors.map((a) => `#${a.block_height.toLocaleString()}`).join(" · ") : "—",
    만든날: todayYmd,
  };
}

/// 패키지 폴더 이름 — 사람이 파일 탐색기에서 무엇인지 바로 알아야 한다.
export function packageFolderName(label: string, ymd: string): string {
  const safe = label.replace(/[\\/:*?"<>|]/g, "_").trim() || "제출";
  return `제출_${safe}_${ymd}`;
}

// ── 변경 이력 표 ────────────────────────────────────────────────────────────
//
// 왜 필요한가: 사슬 원본은 JSON 이라 사람이 못 읽는다. 감사관이 실제로 보는 것은 표다.
// "그때 무슨 일이 있었나"를 날짜순으로 늘어놓는다.
//
// **잇지 않는다.** 제목이 바뀌면 옛 경로와 새 경로가 각각 줄로 나올 뿐, "A 가 B 가 되었다"고
// 단정하지 않는다. 외부에서 제목도 내용도 바꾸면 어떤 방법으로도 같은 노트임을 알 수 없고,
// 추정으로 이으면 틀렸을 때 증거가 왜곡된다. 나란히 놓고 사람이 판단하게 한다.
//
// 줄마다 **근거**를 표시한다. 사슬에서 나온 것과 만든 이의 기기 상태는 다른 무게를 갖는다 —
// 같은 줄처럼 적으면 검증된 사실인 척하게 된다.

export type TimelineBasis = "사슬" | "기기";

export interface TimelineRow {
  day: string;            // YYYY-MM-DD (로컬)
  path: string;           // 경로 해시
  name: string | null;    // 이름을 아는 경우만(경로 해시로 검증 가능)
  seals: number;          // 그날 이 경로의 봉인 횟수
  firstEver: boolean;     // 이 경로가 처음 나타난 날인가
  lastSeq: number;        // 그날 마지막 순번(₿ 대조용)
  basis: TimelineBasis;
}

/// 로컬 날짜(YYYY-MM-DD). epoch(초)를 받는다.
export function localDay(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/// 사슬에서 변경 이력을 만든다. **추정이 들어가지 않는다** — 전부 봉인된 사실이다.
///
/// 하루 단위로 접는 이유: 한 노트를 하루에 스무 번 고쳐도 줄은 하나여야 표가 읽힌다.
/// 봉인 횟수는 숫자로 남기고, 각 회차의 해시는 사슬에 그대로 있다.
///
/// 서버가 만든 기록(`_task/`·`_move/` 등)은 담지 않는다 — 노트의 변경 이력이 아니다.
export function timelineRows(
  chain: ChainEntry[], atEpoch: number, nameOf: Map<string, string>,
): TimelineRow[] {
  const firstDayOf = new Map<string, string>();   // 경로 → 처음 봉인된 날
  const agg = new Map<string, TimelineRow>();     // `${day}|${path}` → 행
  for (const e of chain) {
    if (!isFilePath(e.path)) continue;
    if (e.received_at > atEpoch) continue;
    const day = localDay(e.received_at);
    const prevFirst = firstDayOf.get(e.path);
    if (!prevFirst || day < prevFirst) firstDayOf.set(e.path, day);
    const k = `${day}|${e.path}`;
    const cur = agg.get(k);
    if (cur) {
      cur.seals += 1;
      if (e.seq > cur.lastSeq) cur.lastSeq = e.seq;
    } else {
      agg.set(k, {
        day, path: e.path, name: nameOf.get(e.path) ?? null,
        seals: 1, firstEver: false, lastSeq: e.seq, basis: "사슬",
      });
    }
  }
  for (const row of agg.values()) row.firstEver = firstDayOf.get(row.path) === row.day;
  // 날짜순, 같은 날은 순번순 — 사람이 위에서 아래로 읽는 순서다.
  return Array.from(agg.values()).sort((a, b) =>
    a.day === b.day ? a.lastSeq - b.lastSeq : a.day.localeCompare(b.day));
}

/// 사람이 읽는 표. 이름을 모르면 **모른다고 적는다** — 경로 해시 앞자리로 가리키되
/// 아는 척하지 않는다.
export function timelineFile(rows: TimelineRow[], missingNow: Set<string>): string {
  const head =
    "# 이 기간에 무슨 일이 있었는지. 하루 단위로 접었습니다.\n" +
    "# [사슬] 은 이 자료의 사슬로 다시 계산해 확인할 수 있습니다.\n" +
    "# [기기] 는 자료를 만든 기기의 상태이며 **이 자료 안에서는 확인할 수 없습니다.**\n" +
    "# 제목이 바뀐 경우 옛 이름과 새 이름이 각각 나옵니다 — 같은 노트라고 단정하지 않습니다.\n";
  const out: string[] = [];
  let day = "";
  for (const r of rows) {
    if (r.day !== day) { day = r.day; out.push(day); }
    const name = r.name ?? `(이름 모름 · 경로해시 ${r.path.slice(0, 12)}…)`;
    const bits = [`봉인 ${r.seals}회`, `순번 ${r.lastSeq}`];
    if (r.firstEver) bits.push("첫 등장");
    out.push(`  ${name}\t${bits.join(" · ")}\t[사슬]`);
    if (missingNow.has(r.path) && r.firstEver === false) { /* 아래 한 번만 */ }
  }
  // "지금 vault 에 없다"는 경로마다 **한 번만** 적는다(날마다 반복하면 표가 묻힌다).
  const noted = new Set<string>();
  const tail: string[] = [];
  for (const r of rows) {
    if (!missingNow.has(r.path) || noted.has(r.path)) continue;
    noted.add(r.path);
    const name = r.name ?? `(이름 모름 · 경로해시 ${r.path.slice(0, 12)}…)`;
    tail.push(`  ${name}\t마지막 봉인 이후 기기에서 사라짐\t[기기]`);
  }
  if (tail.length) {
    out.push("");
    out.push("# 아래는 자료를 만든 기기의 상태입니다 — 사슬로는 확인할 수 없습니다.");
    out.push(...tail);
  }
  return head + out.join("\n") + "\n";
}
