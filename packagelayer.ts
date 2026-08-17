// packagelayer.ts — 제출 패키지(원본 + 증명) 조립. 순수 계산은 packagecore.ts 에 있다.
//
// 이 기능이 제품의 마지막 한 걸음이다: 봉인·앵커가 아무리 정확해도, 그것을 **남에게 줄 수
// 없으면** 쓸모가 없다. 받는 사람은 개발자가 아니고(감사관·심사위원·변호사) 명령줄을 쓰지
// 못한다. 그래서 패키지에는 더블클릭으로 도는 검증기가 함께 들어간다.
//
// 왜 vault 를 가진 플러그인이 만드는가: 서버는 노트 **경로를 모른다**(해시만 저장한다).
// "어느 파일이 몇 번째 기록인가"를 맞출 수 있는 것은 원본을 가진 이쪽뿐이다.
import { TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import { t } from "./i18n";
import { sha256HexBytes, hashPath, safeName } from "./pathutil";
import { blobExt } from "./storagecore";
import { ArchiveLayer } from "./archivelayer";
import {
  PackageData, PackageFile, AnchorInfo,
  buildZip, chainCheckFile, fileSeqFile, blockInfoFile, otsFileName,
  tsrFileName, tsaInfoFile,
  latestCoveredSeq, packageFolderName,
  partitionVerifiedAnchors, coverageOf,
  snapshotAt, tallyOrigins, ChainEntry, OriginSource, OriginTally,
  dispositionFile, Disposition,
  timelineRows, timelineFile,
  fillReadme, readmeFields, reviewFile,
} from "./packagecore";

/// 패키지에 동봉할 자산 — **서버에서 받아** 넣는다.
///
/// 플러그인에 구워 넣지 않는 이유: 검증 로직은 계속 다듬어지는데, 구워 넣으면 고칠 때마다
/// 플러그인을 다시 배포해야 하고 그 사이에 만든 패키지에는 옛 검증기가 들어간다.
/// 받아 오기에 실패해도 패키지는 유효하다 — 웹(/check)과 표준 도구 경로가 그대로 살아 있고,
/// 안내문에 그 사실을 적는다.
const ASSETS: { url: string; name: string; binary?: boolean }[] = [
  { url: "/portal/check/readme.html", name: "00_먼저-읽어주세요.html" },
  { url: "/portal/check/verify-unix.command", name: "검증하기(맥·리눅스).command" },
  { url: "/portal/check/verify-windows.bat", name: "검증하기(윈도우).bat" },
  { url: "/portal/check/verify-windows.ps1", name: "_검증.ps1" },
  { url: "/portal/check/no-script.md", name: "스크립트_없이_확인하는_법.md" },
];

/// 구독이 필요하다는 신호. 오류 메시지가 아니라 **다음 행동**을 담는다.
export class SubscriptionRequired extends Error {
  constructor(public checkoutUrl?: string) {
    super("subscription-required");
    this.name = "SubscriptionRequired";
  }
}

/// 패키지를 만들 수 없는 이유 — 사용자에게 **무엇을 해야 하는지**까지 말해야 한다.
export type PackageBlock =
  | { kind: "no-anchor" }                              // 확정 앵커가 하나도 없다
  | { kind: "no-files"; scanned: number }              // 범위 안에 봉인된 파일이 없다
  | { kind: "error"; message: string };

export interface PackagePlan {
  data: PackageData;
  files: PackageFile[];      // 앵커가 덮는 것만
  pending: string[];          // 아직 고정 전이라 뺀 파일(사용자에게 알린다)
  unsealed: string[];         // 사슬에 없는 파일(봉인 안 됨)
  /// 날짜 모드에서만 채워진다 — 어디서 몇 개를 가져왔는가.
  origins?: OriginTally;
  /// 그 시점 원본을 어디서도 찾지 못한 것(경로 해시). 이름을 모를 수 있어 개수로만 쓴다.
  lost?: number;
  /// 담기지 못한 기록의 사유(순번 → 처분). 침묵하면 불리한 기록을 뺀 것과 구별할 수 없다.
  reasons?: Map<number, Disposition>;
  /// 이 자료의 기준 시점(초). 검증기가 "무엇이 들어 있어야 하는가"를 재계산하는 데 쓴다.
  atEpoch?: number;
}

export abstract class PackageLayer extends ArchiveLayer {
  /// 서버에서 사슬·앵커를 받는다.
  ///
  /// 402(구독 필요)는 **오류가 아니라 안내**다. "서버 응답 402" 같은 문구를 보여주면
  /// 사용자는 고장으로 읽고, 정작 해야 할 일(구독)을 알 수 없다.
  /// 이번 패키지가 다루는 사슬. 모달이 정하고, 조립 중 사슬을 다시 받을 때 같은 값을 쓴다 —
  /// 중간에 갈리면 요약 PDF 의 봉인 기록이 "사슬에 없습니다"로 걸린다.
  ///
  /// ★ 2026-08-05 까지 **어디에서도 대입되지 않아 늘 `"solo"` 였다**(선언 1·읽기 3·쓰기 0).
  ///   주석만 "모달이 정한다"고 적혀 있었고 실제로는 아무도 정해 주지 않았다. 그래서 팀 자료를
  ///   만들어도 요약 PDF·봉인·크레딧 차감이 전부 개인 쪽으로 갔다. 대입은 `fetchPackageData`
  ///   한 곳에서 한다 — 사슬을 받아 오는 그 순간이 "이번 자료가 어느 쪽인가"가 정해지는 때이고,
  ///   모달이 팀↔개인을 전환할 때마다 다시 받으므로 저절로 따라온다.
  protected pkgChain: "team" | "solo" = "solo";

  /// chain 은 **어느 사슬을 낼 것인가**(0020). 사슬이 갈려 있으므로 한 번에 한쪽만 담는다 —
  /// 섞으면 고리가 이어지지 않아 검증기가 떨어뜨린다.
  async fetchPackageData(chain: "team" | "solo" = "solo"): Promise<PackageData> {
    // 이번 자료가 어느 사슬인지 여기서 확정한다. 뒤따르는 요약 PDF·봉인·재수신이 전부 이 값을
    // 본다 — 받아 온 사슬과 그 뒤 조작이 갈리면 요약 문서가 자료와 다른 말을 하게 된다.
    this.pkgChain = chain;
    const res = await requestUrl({
      url: `${this.base()}/attest/package?chain=${chain}`,
      method: "GET",
      // 그 사슬을 가진 계정에게 묻는다 — 팀 자료를 개인 키로 물으면 빈 사슬이 온다.
      headers: { "x-nanal-api-key": this.keyFor(chain === "team") },
      throw: false,
    });
    if (res.status === 402) throw new SubscriptionRequired((res.json as { checkout_url?: string } | null)?.checkout_url);
    if (res.status !== 200) throw new Error(`서버 응답 ${res.status}`);
    return res.json as PackageData;
  }

  /// 앵커가 주장하는 블록을 **공개 블록 조회 사이트에 직접 물어** 대조한다.
  ///
  /// 심사자가 하게 될 일을 만드는 쪽에서 먼저 한다. 여기서 걸러 두면 패키지 안의 증거는
  /// 반드시 통과한다 — 실패하는 증거를 보내는 것이 가장 나쁘다(제출자는 손쓸 수 없다).
  /// 조회 자체가 안 되면(폐쇄망) 걸러내지 않는다: 인터넷 문제로 멀쩡한 증거를 떨어뜨리면
  /// 패키지를 아예 만들 수 없게 된다.
  async verifyAnchors(data: PackageData): Promise<{ data: PackageData; dropped: AnchorInfo[] }> {
    const real = new Map<number, string | null>();
    for (const a of data.anchors) {
      if (real.has(a.block_height)) continue;
      try {
        const h = await requestUrl({
          url: `https://mempool.space/api/block-height/${a.block_height}`, method: "GET", throw: false });
        if (h.status !== 200) { real.set(a.block_height, null); continue; }
        const b = await requestUrl({
          url: `https://mempool.space/api/block/${h.text.trim()}`, method: "GET", throw: false });
        real.set(a.block_height, b.status === 200 ? ((b.json as { merkle_root?: string } | null)?.merkle_root ?? null) : null);
      } catch {
        real.set(a.block_height, null);
      }
    }
    const { good, bad } = partitionVerifiedAnchors(data.anchors, real);
    // 앵커를 뺐으면 덮는 범위도 줄어든다 — 그러지 않으면 "고정됨"으로 표시된 파일이
    // 실제로는 덮이지 않은 채 패키지에 들어간다.
    const covered = coverageOf(good);
    return {
      data: { ...data, anchors: good, covered_to: covered,
              pending_from: covered < data.last_seq ? covered + 1 : null },
      dropped: bad,
    };
  }

  /// 범위 안의 파일을 훑어 "사슬에 있고 앵커가 덮는" 것만 골라낸다.
  ///
  /// 파일마다 SHA-256 을 다시 계산한다 — 저장된 색인을 믿지 않는다. 색인이 어긋나 있으면
  /// 내용이 바뀐 파일을 "봉인됨"으로 넣게 되고, 그건 심사자 화면에서 위조로 읽힌다.
  async planPackage(
    folder: string, data: PackageData, onProgress?: (done: number, total: number) => void,
  ): Promise<PackagePlan> {
    const root = folder.replace(/\/+$/, "");
    const all = this.app.vault.getFiles().filter((f) =>
      !root || f.path === root || f.path.startsWith(root + "/"));

    const files: PackageFile[] = [];
    const pending: string[] = [];
    const unsealed: string[] = [];
    let done = 0;
    for (const f of all) {
      onProgress?.(done++, all.length);
      const buf = await this.app.vault.readBinary(f);
      const bytes = new Uint8Array(buf);
      const fileHash = await sha256HexBytes(bytes);
      const ph = await hashPath(f.path);
      const hit = latestCoveredSeq(data.chain, ph, fileHash, data.covered_to);
      if (hit) {
        files.push({ vaultPath: f.path, seq: hit.seq, fileHash, data: bytes });
        continue;
      }
      // 사슬에는 있으나 앵커 뒤라면 "대기", 아예 없으면 "봉인 안 됨" — 둘은 원인이 다르고
      // 사용자가 할 일도 다르다(앵커를 걸어라 vs 봉인부터 해라).
      const anywhere = data.chain.some((e) => e.path === ph && e.file_hash === fileHash);
      (anywhere ? pending : unsealed).push(f.path);
    }
    onProgress?.(all.length, all.length);
    return { data, files, pending, unsealed };
  }

  /// 특정 날짜 시점의 패키지 계획.
  ///
  /// **왜 원본 출처가 갈리나:** 기기는 잃어버릴 수 있다. nanalStorage 가 있는 이유가 그것이고,
  /// 로컬 아카이브가 없거나 그 기간을 담고 있지 않으면 nanalStorage 가 유일한 출처가 된다.
  /// 그래서 기본은 "기기 우선, 없으면 nanalStorage"다.
  ///
  /// 어느 쪽에서 가져오든 **해시가 사슬의 값과 맞아야** 담는다. 맞지 않으면 조용히 빼지 않고
  /// 세어서 알린다 — 출처는 가용성 문제이지 신뢰 문제가 아니게 만드는 것이 이 검사다.
  async planPackageAt(
    folder: string, data: PackageData, atEpoch: number, source: OriginSource,
    onProgress?: (done: number, total: number) => void,
    /// 발급자가 담지 않기로 한 순번. 원본만 빠지고 **사슬과 개수·사유는 그대로 남는다**.
    exclude?: Set<number>,
  ): Promise<PackagePlan> {
    const snap = snapshotAt(data.chain, atEpoch, data.covered_to);

    // 경로 해시 → vault 경로. 서버는 이름을 모르므로 이쪽에서 표를 만든다.
    //
    // ★ 범위 필터를 여기서 걸지 않는다(2026-07-31). 예전에는 표를 만들 때 범위 밖을 걸렀고,
    //   그래서 표에 없으면 무조건 "범위밖"이라 적었다. 그런데 **제목만 바꿔도 표에서 사라진다** —
    //   사슬에는 봉인 당시 경로 해시가 박혀 있는데 그 이름의 파일이 이제 없기 때문이다.
    //   실측: 확정된 노트의 제목을 바꾸자 원본이 패키지에서 통째로 빠지고 사유가 "범위밖"이라
    //   적혔다. 범위 안에 있는데도. 그건 거짓이고, 불리한 기록을 흔적 없이 빼는 길이 된다.
    //   이제 이름을 **먼저 최대한 찾고**, 그 다음에 범위를 판정한다.
    const root = folder.replace(/\/+$/, "");
    const inScope = (rel: string) => !root || rel === root || rel.startsWith(root + "/");
    const nameOf = new Map<string, string>();
    for (const f of this.app.vault.getFiles()) nameOf.set(await hashPath(f.path), f.path);
    for (const [rel] of Object.entries(this.settings.sealedIndex || {})) {
      const h = await hashPath(rel);
      if (!nameOf.has(h)) nameOf.set(h, rel);   // 지금은 없지만 봉인된 적 있는 경로
    }
    // ★ 로컬 아카이브 커밋 로그 — **추정이 아니다.** 봉인하던 순간의 경로가 커밋 메시지에
    //   그대로 적혀 있다(`nanalStamp: <경로> · seq N`). 제목이 바뀌었든 지웠든 상관없다.
    //   개명 계보(내용 지문 대조)에 기댈 이유가 없다 — 그건 추정이고 실패할 수 있다.
    //   실측(사슬의 파일 항목 45건): 이 표가 8건을 더 찾아낸다. 그 8건이 "범위밖"으로 빠지던 것들이다.
    try {
      for (const e of await this.rewindLog()) {
        const h = await hashPath(e.notePath);
        if (!nameOf.has(h)) nameOf.set(h, e.notePath);
      }
    } catch (err) { console.error("[nanalstamp] package nameOf archive", err); }

    const files: PackageFile[] = [];
    const rows: Array<{ from: "device" | "storage" | null }> = [];
    // 빠진 것은 **왜** 빠졌는지 남긴다. 개수만 세면 "범위 밖"과 "원본을 지웠다"가 같아 보인다.
    const reasons = new Map<number, Disposition>();
    let done = 0, lost = 0;
    for (const [ph, e] of snap) {
      onProgress?.(done++, snap.size);
      // 발급자가 뺀 것 — **가장 먼저** 본다. 뺄 것을 굳이 읽어 올 이유가 없다.
      if (exclude?.has(e.seq)) { lost++; reasons.set(e.seq, "제외함"); continue; }
      const rel = nameOf.get(ph);
      // 셋을 구분한다. 예전에는 전부 "범위밖"이었고, 그래서 처분내역이 거짓말을 했다.
      if (!rel) { lost++; reasons.set(e.seq, "경로미상"); continue; }   // 이름 자체를 모른다
      if (!inScope(rel)) { lost++; reasons.set(e.seq, "범위밖"); continue; } // 이름은 아는데 고른 범위 밖
      const got = await this.fetchOriginalAt(rel, e, source);
      rows.push({ from: got?.from ?? null });
      if (!got) { lost++; reasons.set(e.seq, "원본없음"); continue; }
      files.push({ vaultPath: rel, seq: e.seq, fileHash: e.file_hash, data: got.data });
    }
    onProgress?.(snap.size, snap.size);
    files.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
    return { data, files, pending: [], unsealed: [], origins: tallyOrigins(rows), lost, reasons, atEpoch };
  }

  /// 그 시점 원본 한 개를 가져온다. **해시가 맞는 것만** 돌려준다.
  private async fetchOriginalAt(
    rel: string, e: ChainEntry, source: OriginSource,
  ): Promise<{ data: Uint8Array; from: "device" | "storage" } | null> {
    const ok = async (bytes: Uint8Array) => (await sha256HexBytes(bytes)) === e.file_hash;

    // (1) 이 기기의 git 아카이브 — 빠르고 전송이 없다.
    if (source === "auto" || source === "device") {
      try {
        const safe = safeName(rel);
        const isMd = rel.toLowerCase().endsWith(".md");
        const versions = await this.archiveVersionsOf(isMd ? `notes/${safe}.md` : `attachments/${safe}`);
        for (const v of versions) {
          const bytes = await this.archiveReadBytes(v.oid, isMd ? `notes/${safe}.md` : `attachments/${safe}`);
          if (bytes && await ok(bytes)) return { data: bytes, from: "device" };
        }
      } catch { /* 아카이브가 없거나 이 기간을 담고 있지 않다 — 아래로 넘어간다 */ }
    }

    // (2) nanalStorage — 기기를 잃었거나 아카이브가 그 기간을 덮지 못할 때의 답.
    if (source === "auto" || source === "storage") {
      try {
        const isMd = rel.toLowerCase().endsWith(".md");
        const got = await this.nanalFetch(e.file_hash, blobExt(rel), isMd);
        if (!("error" in got)) {
          const bytes = typeof got.data === "string"
            ? new TextEncoder().encode(got.data) : new Uint8Array(got.data);
          if (await ok(bytes)) return { data: bytes, from: "storage" };
        }
      } catch { /* 미구독·미업로드·네트워크 — 아래에서 '못 찾음'으로 센다 */ }
    }
    return null;
  }

  /// 동봉 자산을 서버에서 받는다. 실패한 것은 빼고, 무엇이 빠졌는지 돌려준다.
  private async fetchAssets(): Promise<{ items: { name: string; data: Uint8Array }[]; missing: string[] }> {
    const items: { name: string; data: Uint8Array }[] = [];
    const missing: string[] = [];
    for (const a of ASSETS) {
      try {
        const res = await requestUrl({ url: `${this.base()}${a.url}`, method: "GET", throw: false });
        if (res.status !== 200) { missing.push(a.name); continue; }
        items.push({ name: a.name, data: new Uint8Array(res.arrayBuffer) });
      } catch {
        missing.push(a.name);
      }
    }
    return { items, missing };
  }

  /// zip 을 조립해 vault 안에 쓴다. 반환값은 저장된 경로.
  /// atYmd 를 주면 **그날 기준** 패키지다 — 파일 이름과 안내가 그 날짜를 말해야 한다.
  /// 오늘 만든 것과 3월 말 기준 것이 같은 이름이면 받는 쪽이 구분할 수 없다.
  /// onStep 은 **어디까지 갔는지** 알린다. 없으면 '만들기'를 누른 뒤 아무 표시 없이
  /// 몇 분이 지나가고, 사용자는 멈춘 것인지 진행 중인지 알 수 없다(2026-07-30 e2e 에서 겪었다).
  async writePackage(
    plan: PackagePlan, label: string, atYmd?: string, onStep?: (s: string) => void,
    /// 변경 이력 표를 담을 것인가. 담지 않기로 했으면 **담지 않았다는 사실**을 적는다.
    withTimeline = true,
  ): Promise<{ path: string; missing: string[] }> {
    const step = (t: string) => { onStep?.(t); console.debug("[nanalstamp] 패키지:", t); };
    step("준비");
    const { data, files } = plan;
    const anchors = data.anchors;
    // 요약 PDF 를 봉인하면 사슬이 한 건 늘어난다 — 그때 이 값을 갱신한다.
    let chain = data.chain;
    const ymd = atYmd || new Date().toISOString().slice(0, 10);
    const folderName = packageFolderName(label, ymd);

    const items: { name: string; data: Uint8Array; mtime?: number }[] = [];
    const enc = new TextEncoder();
    let pdfEntry: { seq: number; hash: string } | null = null;   // 요약 PDF 의 봉인 기록
    const push = (name: string, body: string | Uint8Array, mtime?: number) =>
      items.push({ name: `${folderName}/${name}`,
                   data: typeof body === "string" ? enc.encode(body) : body, mtime });

    // 원본 — vault 구조를 그대로 살린다. 심사자가 "어느 폴더의 무엇"인지 알아야 한다.
    // 파일 시각은 **그 버전이 봉인된 시각**으로 준다(사슬에서 읽는다).
    const sealedAt = new Map(chain.map((e) => [e.seq, e.received_at]));
    for (const f of files) push(`노트/${f.vaultPath}`, f.data, sealedAt.get(f.seq));

    // 비트코인 — .ots 는 **바이너리 그대로** 넣는다. 검증기가 33..65 바이트를 직접 읽는다.
    for (const a of anchors) push(`비트코인/${otsFileName(a)}`, b64ToBytes(a.ots_b64));
    push("비트코인/블록정보.txt", blockInfoFile(anchors));

    // 신뢰기관 타임스탬프(RFC 3161 TSA) — 이중 앵커의 두 번째 축. .tsr(DER) 원본 그대로.
    // ("공인" 표기 금지 — 공인 TSA 제도는 2020년 전자서명법 개정으로 폐지됐다.)
    // 비트코인 블록 대조 필터를 거치지 않는다 — TSA 검증은 openssl 이 오프라인으로 한다.
    const tsa = data.tsa_anchors ?? [];
    if (tsa.length > 0) {
      for (const t of tsa) push(`신뢰기관타임스탬프/${tsrFileName(t)}`, b64ToBytes(t.tsr_b64));
      push("신뢰기관타임스탬프/발급정보.txt", tsaInfoFile(tsa));
    }

    // 한 장짜리 요약 증명서(PDF) — 심사자가 결재·보관용으로 쓴다. 영문인 이유는
    // PDF 엔진의 builtin 폰트가 Latin-1 만 그리기 때문이다(한글 안내는 HTML 이 맡는다).
    // 실패해도 패키지는 유효하다 — 증거는 사슬과 비트코인이지 이 문서가 아니다.
    //
    // ★ 402(크레딧 필요)만은 예외다. 이건 "만들지 못했다"가 아니라 **"아직 값을 치르지
    //   않았다"**는 뜻이라, 조용히 넘기면 증명서 없는 자료가 완성된 것처럼 나간다.
    //   아래 catch 가 전부 삼키므로 여기서 던지지 않고 표시만 해 두었다가 밖에서 던진다.
    let needCredit: SubscriptionRequired | null = null;
    try {
      // 담은 앵커·범위를 그대로 넘긴다 — 서버가 DB 를 다시 읽으면 걸러낸 앵커가 되살아나
      // PDF 가 패키지와 다른 말을 한다(실측).
      step(t.pkgStepPdf);
    // 사슬 이름을 **반드시 실어 보낸다.** 서버는 값이 없으면 개인으로 떨어뜨리는데(pick_chain),
    // 그건 의도된 기본값이다 — 팀을 기본으로 두면 개인 자료를 내려던 사람이 모르는 채 조직
    // 기록을 내보내게 된다. 즉 서버가 추론할 수 없고 이쪽이 말해 주어야 한다. 안 보내면
    // PDF 가 섞인다: blocks·covered·files 는 팀 값인데 chain_len·head_entry_hash 는 개인 사슬에서
    // 읽히고, 팀의 covered_to 를 개인 사슬에서 찾으니 엉뚱한 기록이 찍힌다(2026-08-05).
    const q = `files=${files.length}&as_of=${encodeURIComponent(ymd)}`
        + `&blocks=${anchors.map((a) => a.block_height).join(",")}`
        + `&covered=${data.covered_to}`
        + `&chain=${this.pkgChain}`;
      const res = await requestUrl({
        url: `${this.base()}/attest/package/summary.pdf?${q}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.keyFor(this.pkgChain === "team") },
        throw: false,
      });
      if (res.status === 402) needCredit = new SubscriptionRequired((res.json as { checkout_url?: string } | null)?.checkout_url);
      if (res.status === 200) {
        const pdf = new Uint8Array(res.arrayBuffer);
        push("증명서(요약).pdf", pdf);

        // ★ 요약 문서도 **봉인한다**(2026-07-29). 서명만으로는 발급자 키를 믿어야 하는데,
        //   봉인하면 다음 앵커에서 비트코인이 보증한다 — 훨씬 강하다. 만든 당일에는 아직
        //   확정 전이라 "고정 대기"로 표시되고, 그 사이를 아래 서명이 메운다.
        const pdfHash = await sha256HexBytes(pdf);
        const seq = await this.sealSummaryPdf(pdfHash, folderName);
        if (seq !== null) {
          pdfEntry = { seq, hash: pdfHash };
          // 사슬을 **다시 받는다** — 검증기는 파일 목록의 값이 사슬에도 있는지 대조하므로,
          // 봉인 전 스냅샷을 그대로 쓰면 요약 PDF 가 "기록이 사슬에 없습니다"로 걸린다.
          try {
            step(t.pkgStepChain);
    const fresh = await this.fetchPackageData(this.pkgChain);
            if (fresh.chain.some((e) => e.seq === seq)) chain = fresh.chain;
          } catch { pdfEntry = null; }   // 못 받으면 목록에도 넣지 않는다(서명으로만 보증)
        }

        // 서명도 함께 넣는다 — 앵커 확정 전(보통 하루)에는 이것이 유일한 방어다.
        const sig = res.headers?.["x-nanal-signature"] ?? res.headers?.["X-Nanal-Signature"];
        if (sig) {
          push("증명/_증명서서명.txt",
            "# 위 폴더의 '증명서(요약).pdf' 가 발급자가 만든 그대로인지 확인하는 값입니다.\n" +
            "# 이 문서는 봉인되어 다음 앵커에서 비트코인에 고정됩니다 — 그 뒤에는 서명 없이도\n" +
            "# 사슬로 확인됩니다. 서명은 확정 전(보통 하루)을 메우는 수단입니다.\n" +
            "# 확인: https://nanalstamp.com/check 에 이 zip 을 올리면 함께 검사합니다.\n" +
            "# 계산식: Ed25519.verify( 발급자공개키, 아래 서명, SHA256(증명서(요약).pdf) )\n" +
            `서명: ${sig}\n`);
        }
      }
    } catch { /* 없어도 검증에는 지장이 없다 */ }
    // 값을 치르지 않은 상태다 — zip 을 쓰지 않고 그대로 돌려보낸다(모달이 구매 안내를 띄운다).
    if (needCredit) throw needCredit;

    // 증명 — **PDF 봉인 뒤에** 쓴다. 그래야 요약 문서의 기록이 파일 목록에 들어가고,
    // 검증기가 노트와 같은 방식으로 대조한다(다음 앵커에서 비트코인이 보증한다).
    push("증명/_사슬검사용.txt", chainCheckFile(data.user_id, chain));
    push("증명/_파일별순번.txt", fileSeqFile(files, pdfEntry ?? undefined));
    // 사슬의 **모든** 기록에 처분을 매긴다 — 이 자료는 부분집합이므로, 빠진 것을 밝히지 않으면
    // 불리한 기록을 일부러 뺀 것과 구별할 수 없다(2026-07-30).
    push("증명/_처분내역.txt", dispositionFile(
      chain, plan.atEpoch ?? Math.floor(Date.now() / 1000), data.covered_to,
      new Set(files.map((f) => f.seq)), plan.reasons ?? new Map<number, Disposition>()));
    push("증명/_전체체인.json", JSON.stringify({
      "발급": "nanalStamp",
      "사용자ID": data.user_id,
      "기준일": ymd,
      "만든날": new Date().toISOString().slice(0, 10),
      "기록수": chain.length,
      "비트코인에_고정된_마지막_순번": data.covered_to,
      "점검서명": data.reviews ?? [],
      "체인": chain,
    }, null, 1));
    // 변경 이력 — 사슬 원본은 JSON 이라 사람이 못 읽는다. 감사관이 실제로 보는 것은 이 표다.
    // 담지 않기로 했으면 **담지 않았다는 사실을 적는다** — 조용히 빼면 "원래 없었다"로 읽힌다.
    if (withTimeline) {
      const atE = plan.atEpoch ?? Math.floor(Date.now() / 1000);
      const nameByHash = new Map<string, string>();
      for (const f of files) nameByHash.set(await hashPath(f.vaultPath), f.vaultPath);
      for (const [rel] of Object.entries(this.settings.sealedIndex || {})) {
        const h = await hashPath(rel);
        if (!nameByHash.has(h)) nameByHash.set(h, rel);
      }
      try {
        for (const e of await this.rewindLog()) {
          const h = await hashPath(e.notePath);
          if (!nameByHash.has(h)) nameByHash.set(h, e.notePath);
        }
      } catch { /* 아카이브가 없어도 표는 만든다 — 이름만 덜 채워진다 */ }
      // 지금 기기에 없는 것. **사슬로는 확인할 수 없는 사실**이라 표에서 따로 표시된다.
      const missingNow = new Set<string>();
      for (const [h, rel] of nameByHash) {
        if (!this.app.vault.getAbstractFileByPath(rel)) missingNow.add(h);
      }
      push("증명/_변경이력.txt", timelineFile(timelineRows(chain, atE, nameByHash), missingNow));
    } else {
      push("증명/_변경이력.txt",
        "# 발급자가 변경 이력 표를 담지 않기로 했습니다.\n" +
        "# 봉인 사실 자체는 사슬(증명/_전체체인.json)에 그대로 있으며, 순번·시각·해시로 확인할 수 있습니다.\n" +
        "# 이 표가 더해 주는 것은 **경로 이름과 기기 상태**뿐입니다.\n");
    }
    // 스크립트 검증기용 표 — 서명이 있을 때만 넣는다(빈 파일은 "무엇을 봐야 하나"를 늘린다).
    if (data.reviews?.length) push("증명/_점검서명.txt", reviewFile(data.reviews));


    step(t.pkgStepAssets);
    const { items: assets, missing } = await this.fetchAssets();
    const fields = readmeFields(files, chain, anchors, atYmd,
                                new Date().toISOString().slice(0, 10));
    for (const a of assets) {
      // 안내문만 이 자료의 실제 값으로 채운다. 채우지 않으면 템플릿의 예시 숫자가 그대로
      // 나가고, 심사자는 가장 먼저 여는 문서에서 사실과 다른 값을 본다(2026-07-29 실측).
      if (a.name.endsWith(".html")) {
        push(a.name, fillReadme(new TextDecoder().decode(a.data), fields));
      } else {
        push(a.name, a.data);
      }
    }
    if (missing.length) {
      // 검증기를 못 넣었으면 **그 사실을 패키지 안에 적는다.** 조용히 빠뜨리면 심사자는
      // 검증할 방법이 없다고 생각하고 자료 전체를 물리게 된다.
      push("검증기를_받지_못했습니다.txt",
        "이 자료를 만들 때 검사 프로그램을 내려받지 못했습니다(네트워크 문제).\n" +
        `빠진 것: ${missing.join(", ")}\n\n` +
        "확인은 그대로 가능합니다. 다음 중 하나를 쓰십시오.\n" +
        "  1) https://nanalstamp.com/check 에 이 zip 을 끌어다 놓기\n" +
        "  2) 같은 주소에서 검사 프로그램을 내려받아 이 폴더에 두고 더블클릭\n");
    }

    step(t.pkgStepZip);
    const zip = await buildZip(items);

    step(t.pkgStepSave);
    const dir = "nanalStamp 제출자료";
    if (!(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }
    const path = normalizePath(`${dir}/${folderName}.zip`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const ab = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, ab);
    else await this.app.vault.createBinary(path, ab);
    return { path, missing };
  }

  /// 요약 PDF 를 사슬에 봉인한다. 성공하면 seq, 실패하면 null(패키지는 그대로 유효하다).
  ///
  /// 경로는 가상 경로를 해시해 쓴다 — 실제 vault 파일은 아니지만 사슬 계산식이 경로를 요구한다.
  private async sealSummaryPdf(hash: string, folderName: string): Promise<number | null> {
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest`,
        method: "POST",
        // 요약 PDF 는 **그 자료의 사슬**에 봉인한다 — 다른 사슬에 넣으면 검증기가
        // "이 기록이 사슬에 없습니다"로 떨어뜨린다.
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(this.pkgChain === "team") },
        // `/attest` 는 **본문의 `team_scope` 로만** 사슬을 고른다(seal.rs:55). 키를 팀 것으로
        // 바꿔도 그것만으로는 개인 사슬에 들어간다 — 경로를 아는 쪽이 말해 주어야 한다(0017·0020
        // 과 같은 원칙). 팀 미소속이면 보내지 않는다: 그때는 팀 범위라는 개념 자체가 없다.
        body: JSON.stringify({
          hash,
          path: await hashPath(`${folderName}/증명서(요약).pdf`),
          ...(this.teamRoot() ? { team_scope: this.pkgChain === "team" } : {}),
        }),
        throw: false,
      });
      const seq = res.status === 200 ? (res.json as { seq?: number } | null)?.seq : null;
      return typeof seq === "number" ? seq : null;
    } catch {
      return null;
    }
  }

  /// 만든 zip 을 시스템 파일 탐색기에서 보여준다 — vault 안에 있어도 사용자는
  /// "그래서 어디에 있느냐"를 묻는다. 데스크톱에서만 되고, 안 되면 조용히 넘어간다.
  revealPackage(path: string): void {
    try {
      // Store review note: adapter duck-typing is deliberate — desktop-only "reveal in
      // folder" convenience; on mobile getFullPath/showInFolder are absent and we no-op.
      const adapter = this.app.vault.adapter as unknown as { getFullPath?: (p: string) => string };
      const full = adapter.getFullPath?.(path);
      const app = this.app as unknown as { showInFolder?: (p: string) => void };
      if (full && typeof app.showInFolder === "function") app.showInFolder(full);
    } catch { /* 데스크톱이 아니거나 API가 없다 — 경로는 이미 안내했다 */ }
  }
}

/// base64 → 바이트. .ots 는 텍스트로 다루면 안 된다(디코딩 한 번만 거친다).
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
