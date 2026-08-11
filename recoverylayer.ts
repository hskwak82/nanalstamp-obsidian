// recoverylayer.ts — 보관 누락 복구. 봉인은 됐는데 원문이 nanalStorage 에 없는 것을 다시 올린다.
//
// 왜 필요한가(2026-07-29 실측): 봉인 1,311건 중 260건에 원문이 없었다. 원인이 하나가 아니다 —
// 봉인 직후 지워진 파일, 업로드 실패가 **메모리에만 남아** Obsidian 종료와 함께 사라진 것,
// nanalIndex 에 "올렸다"고 기록됐지만 실제로는 안 올라간 것(351건)이 섞여 있었다.
//
// 원인을 하나로 특정하는 대신 **결과를 수렴시킨다.** 서버가 "무엇이 없는지" 알려주고,
// 여기서 vault 또는 **로컬 git 아카이브**에서 꺼내 다시 올린다. 아카이브는 봉인마다 커밋하므로
// 과거 버전도 남아 있다 — 그래서 지금 vault 에 없는 옛 버전까지 되살릴 수 있다.
//
// 기존 ledgerSweep 은 이 구멍을 못 메운다: **현재 파일의 현재 내용**만 보기 때문이다.
import { Notice, TFile, requestUrl } from "obsidian";
import { t } from "./i18n";
import { sha256Hex, sha256HexBytes, hashPath } from "./pathutil";
import { PackageLayer } from "./packagelayer";

export interface MissingItem {
  seq: number;
  file_hash: string;
  path_hash: string;
  received_at: number;
}

/// 되살릴 수 없다고 판정된 한 건 — 사람에게 **무엇을** 잃었는지 말하기 위한 최소 정보.
export interface LostItem {
  seq: number;
  at: number;
  /// 아카이브 이력에서 되찾은 노트 경로. 한 번도 커밋된 적이 없으면 null.
  name: string | null;
}

export interface RecoveryReport {
  sealed: number;
  stored: number;
  missingTotal: number;
  /// 이번에 실제로 올린 건수.
  restored: number;
  /// 이번 배치에서 원본을 찾지 못한 건수.
  lost: number;
  /// 원본이 어디에도 없어 **되살릴 수 없는** 건수(지워진 파일 등).
  unrecoverable: number;
  /// 아직 남은 건수(한 번에 다 처리하지 않는다).
  remaining: number;
  /// 되살릴 수 없다고 **확정된** 것들 — 다시 시도해도 결과가 같다.
  lostList: LostItem[];
}

/// 서버가 준 path_hash 가 실제 해시인지(=경로가 가려져 있는지) 본다.
/// 초기 기록은 이 자리에 평문 경로가 들어 있다 — 그때는 그대로 경로로 쓸 수 있다.
function isPathHashed(v: string): boolean { return /^[0-9a-f]{64}$/.test(v); }

/// 한 번에 되살릴 건수 — 백그라운드라 조금씩. 남으면 다음 틱이 이어받는다.
const GAP_RECOVER_BATCH = 25;
/// 한 번에 훑어볼 목록 크기. 되살릴 수 있는 것을 찾으려면 앞쪽만 봐서는 안 된다.
const RECOVER_SCAN_LIMIT = 2000;
/// 평상시 점검 간격. 마지막 점검 이후 이만큼 지나야 다시 본다(세션 시작 여부와 무관).
const GAP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/// 누락이 남아 있을 때의 간격 — 고칠 것이 있으면 더 자주 본다.
const GAP_RETRY_MS = 60 * 60 * 1000;

export abstract class RecoveryLayer extends PackageLayer {
  private gapWatchBusy = false;

  /// 상시 감시 — 봉인은 됐는데 원문이 보관되지 않은 것이 있으면 **스스로 알아채고 올린다.**
  ///
  /// 왜 자동인가: 구독의 핵심이 원문 보관이다. 사람이 점검 버튼을 눌러야만 발견되는
  /// 구조라면 대부분은 영영 모른 채 지나간다 — 실제로 260건이 그렇게 쌓였다(2026-07-30).
  /// 조용히 소량씩 고치고, 스스로 못 고치는 것이 있을 때만 알린다.
  async watchStorageGaps(force = false): Promise<void> {
    if (!this.settings.apiKey || !this.nanalActive() || this.authFailed) return;
    if (this.gapWatchBusy) return;
    // **경과 시간**으로 판정한다. 인터벌만 믿으면 Obsidian 을 껐다 켤 때마다 점검이 돌아
    // 서버를 헛되이 훑고(S3 목록 조회다), 반대로 며칠 안 켜면 그동안 한 번도 안 돈다.
    // 남은 누락이 있으면 더 자주 본다 — 고칠 것이 있는 상태를 오래 두지 않는다.
    const since = Date.now() - (this.settings.storageGapCheckedAt || 0);
    const due = this.settings.storageGapSeen > 0 ? GAP_RETRY_MS : GAP_INTERVAL_MS;
    if (!force && since < due) return;
    this.gapWatchBusy = true;
    this.settings.storageGapCheckedAt = Date.now();
    try {
      const got = await this.fetchMissing(1);
      // 서버가 아는 확정 건수가 우리와 다르면 즉시 맞춘다 — 어긋난 채로 두면 그 차이만큼
      // 고칠 수 없는 건수가 운영 알람에 계속 잡힌다.
      if (got && got.knownLost !== (this.settings.unrecoverableHashes ?? []).length) {
        await this.reportUnrecoverable();
      }
      if (!got || got.total === 0) { this.settings.storageGapSeen = 0; await this.persist(); return; }

      // 한 번에 조금씩만 — 백그라운드 작업이 사용자의 vault 를 붙잡으면 안 된다.
      const r = await this.recoverMissing(GAP_RECOVER_BATCH);
      // **자동으로 더 해 볼 수 있는 것**만 센다. 되살릴 수 없다고 확정된 것을 계속 세면
      // 감시가 영원히 "고칠 게 남았다"고 믿고 한 시간마다 같은 실패를 반복한다(2026-07-30).
      const left = r ? Math.max(0, r.remaining - r.lostList.length) : got.total;
      this.settings.storageGapSeen = left;
      await this.persist();

      // 되살릴 수 없는 것이 새로 확정됐을 때 **한 번만** 알린다. 매번 띄우면 소음이 되고,
      // 아예 말하지 않으면 "보관되고 있다"는 잘못된 안심을 준다.
      if (r && r.lostList.length > 0 && this.settings.storageLostNoticed !== r.lostList.length) {
        this.settings.storageLostNoticed = r.lostList.length;
        await this.persist();
        new Notice(t.gapNotice(r.lostList.length), 10000);
      }
    } catch { /* 다음 틱에 다시 본다 */ }
    finally { this.gapWatchBusy = false; }
  }

  /// 점검이 방금 끝났음을 기록한다(수동 실행·주기 감시 공용).
  /// 사람이 직접 눌렀는데 주기 감시가 곧바로 같은 일을 또 하면 낭비다.
  async noteGapChecked(remaining?: number): Promise<void> {
    this.settings.storageGapCheckedAt = Date.now();
    if (remaining !== undefined) this.settings.storageGapSeen = remaining;
    await this.persist();
  }

  /// 서버에서 "원문 없는 기록" 목록을 받는다.
  async fetchMissing(limit = 200): Promise<{ sealed: number; stored: number; total: number; knownLost: number; items: MissingItem[] } | null> {
    if (!this.settings.apiKey) return null;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/storage/missing?limit=${limit}&reporter_id=${this.reporterId()}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status !== 200) return null;
      const mj = res.json as { sealed?: number; stored?: number; missing_total?: number; unrecoverable_known?: number; missing?: MissingItem[] } | null;
      return {
        sealed: mj?.sealed ?? 0,
        stored: mj?.stored ?? 0,
        total: mj?.missing_total ?? 0,
        knownLost: mj?.unrecoverable_known ?? 0,
        items: mj?.missing ?? [],
      };
    } catch {
      return null;
    }
  }

  /// 누락분을 찾아 다시 올린다. onProgress 는 (처리, 전체).
  /// onScan 은 **아카이브를 훑는 동안**의 진행 — 이 구간이 가장 오래 걸리는데 예전에는
  /// 아무 표시가 없어 눌러도 멈춘 것처럼 보였다(2026-07-30).
  async recoverMissing(
    limit = 200,
    onProgress?: (done: number, total: number) => void,
    onScan?: (done: number, total: number) => void,
  ): Promise<RecoveryReport | null> {
    // 목록은 **넉넉히** 받는다. 서버는 seq 순으로 주는데 앞쪽이 전부 "지워진 파일"이면
    // 배치가 매번 같은 자리를 맴돌아 뒤쪽의 되살릴 수 있는 것에 영영 닿지 못한다
    // (2026-07-30 실측: 25건 배치가 seq 0~24 만 반복 시도하고 한 건도 못 올렸다).
    const got = await this.fetchMissing(RECOVER_SCAN_LIMIT);
    if (!got) return null;

    // 이미 "어디에도 없다"가 확정된 것은 건너뛴다. 아카이브에도 vault 에도 없는 원본은
    // 다시 훑어도 결과가 같다 — 반복하면 진전 없는 재시도만 영원히 돈다.
    // (사람이 '전부 다시 시도'를 누르면 이 목록을 비우고 처음부터 다시 본다.)
    const skip = new Set(this.settings.unrecoverableHashes ?? []);
    const items = got.items.filter((i) => !skip.has(i.file_hash));

    // 경로 해시 → vault 경로. 서버는 경로를 모르므로 이 표는 이쪽에서만 만들 수 있다.
    const byPathHash = new Map<string, string>();
    for (const f of this.app.vault.getFiles()) byPathHash.set(await hashPath(f.path), f.path);

    // 되살릴 수 있는 것을 **두 곳에서** 찾는다:
    //   (1) 지금 vault 에 그 경로가 살아 있고 내용이 그대로인 것
    //   (2) **로컬 git 아카이브** — 봉인 시점에 커밋되므로 지워진 노트의 옛 버전도 남아 있다
    // (2)를 빠뜨리면 대부분을 놓친다: 실측에서 누락 260건 중 226건이 아카이브에 있었는데도
    // "경로를 안 다음에 아카이브를 본다"는 순서 때문에 한 건도 못 찾았다(2026-07-30).
    const wanted = new Set(items.map((i) => i.file_hash));
    const fromArchive = await this.findInArchiveByHashes(wanted, onScan);

    let restored = 0, lost = 0, done = 0, unrecoverable = 0;
    const newlyLost: MissingItem[] = [];
    for (const it of items) {
      if (restored >= limit) break;
      onProgress?.(done++, Math.min(items.length, limit));
      // 초기 버전은 path_hash 자리에 **평문 경로**를 보냈다(실측 260건 중 251건). 그래서
      // 해시 표로만 찾으면 vault 에 살아 있는 파일조차 못 찾는다 — 두 형태를 모두 받는다.
      const rel = isPathHashed(it.path_hash) ? byPathHash.get(it.path_hash) : it.path_hash;
      // 경로가 없으면(지워진 노트) 아카이브 이름을 그대로 쓴다 — 확장자만 맞으면 된다.
      const target = rel ?? `_복구/${it.seq}.md`;
      // 대형 첨부는 내용주소 저장소에 **파일로** 있다. 경로를 그대로 넘겨 스트리밍으로 올린다 —
      // 바이트로 받으면 625MB 가 통째로 힙에 올라가 업로드 스트리밍이 무의미해진다.
      const cas = this.casPathOf(it.file_hash);
      if (cas) {
        const proof = await this.proofBodyFor(it.file_hash);
        if (await this.uploadRecoveredFile(target, it.file_hash, cas.path, cas.size, proof)) {
          restored++;
          if (rel) this.settings.nanalIndex[rel] = it.file_hash;
        } else lost++;
        continue;
      }
      let bytes: Uint8Array | null = null;
      if (rel) bytes = await this.readIfMatches(rel, it.file_hash);
      if (!bytes) bytes = fromArchive.get(it.file_hash) ?? null;
      if (!bytes) { unrecoverable++; newlyLost.push(it); continue; }
      if (await this.uploadRecoveredBytes(target, it.file_hash, bytes, await this.proofBodyFor(it.file_hash))) {
        restored++;
        if (rel) this.settings.nanalIndex[rel] = it.file_hash;
      } else lost++;
    }
    onProgress?.(done, done);

    // 이번에 못 찾은 것을 확정 목록에 더한다 — 다음 자동 점검이 같은 자리를 다시 파지 않게.
    // 그리고 **서버가 더 이상 누락이라 하지 않는 것은 뺀다.** 되살아났거나(다른 기기가 올렸거나)
    // 애초에 대상이 아니었던 것(서버가 만든 기록)이 확정 목록에 남으면, 고칠 것이 없는데도
    // 목록만 부풀어 진짜 문제를 가린다 — 실제로 23건이 그렇게 잘못 확정돼 있었다(2026-07-30).
    // 목록이 상한에 잘렸으면 정리하지 않는다 — 안 받아온 것을 "없어졌다"고 오해해
    // 확정을 풀면 다음 점검이 그 자리를 다시 파기 시작한다.
    const complete = got.items.length >= got.total;
    const stillMissing = new Set(got.items.map((i) => i.file_hash));
    const lostHashes = new Set(Array.from(skip).filter((h) => !complete || stillMissing.has(h)));
    for (const it of newlyLost) lostHashes.add(it.file_hash);
    this.settings.unrecoverableHashes = Array.from(lostHashes);

    // **이름을 되찾는다.** "seq 431" 만으로는 무엇을 잃었는지 알 수 없다.
    // 그 노트가 한 번이라도 아카이브에 커밋된 적이 있으면 경로해시로 이름이 나온다.
    const lostItems = got.items.filter((i) => lostHashes.has(i.file_hash));
    let names = new Map<string, string>();
    if (lostItems.length > 0) {
      try { names = await this.archivePathsByHash(); } catch { /* 이름 없이도 건수는 알린다 */ }
    }
    const lostList: LostItem[] = lostItems.map((i) => ({
      seq: i.seq, at: i.received_at,
      name: isPathHashed(i.path_hash) ? (names.get(i.path_hash) ?? null) : i.path_hash,
    }));

    await this.persist();
    void this.reportUnrecoverable();   // 확정 목록이 늘었으면 서버 알람에서 빠지게 알린다
    return {
      sealed: got.sealed, stored: got.stored, missingTotal: got.total,
      restored, lost,
      unrecoverable,
      remaining: Math.max(0, got.total - restored),
      lostList,
    };
  }

  /// 확정 목록을 서버에 맞춘다(전체 교체). **점검 주기에 묶지 않는다** —
  /// 목록은 이미 정해져 있는데 다음 점검(최대 6시간)까지 서버가 모르면 그동안 알람이 계속 온다.
  /// **원본이 어디에 있는지는 이 기기만 안다** — 서버는 S3 만 보므로 "어디에도 없다"를
  /// 스스로 판정할 수 없다. 서버는 이 목록을 운영 알람에서만 뺀다(감사 리포트·처분내역에는 그대로 드러난다).
  ///
  /// **보낸 적이 있어도 다시 보낸다.** 지문이 같으면 건너뛰게 했더니 서버 쪽 목록이 비었을 때
  /// (복원·수동 조작·마이그레이션) 클라이언트는 "이미 보고했다"고 믿어 영원히 맞춰지지 않았다 —
  /// 실제로 그렇게 어긋났다(2026-07-30). 34건이면 2KB 남짓이라 매번 보내도 비용이 없다.
  /// 이 vault 의 보고자 id — 없으면 만들어 둔다(한 번 정하면 바뀌지 않아야 한다).
  protected reporterId(): string {
    if (!this.settings.reporterId) {
      this.settings.reporterId = "r-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      void this.persist();
    }
    return this.settings.reporterId;
  }

  async reportUnrecoverable(): Promise<void> {
    if (!this.settings.apiKey || this.authFailed) return;
    const list = (this.settings.unrecoverableHashes ?? []).slice().sort();
    const sig = await sha256Hex(list.join(","));
    // 나눠 보낸다. 서버 본문 상한이 64KB 라 해시 950개쯤에서 잘리는데, 이 API 는
    // "이 목록이 전부"라는 뜻이라 조용히 잘리면 **덜 알려진 목록이 전부인 것처럼** 굳는다.
    // 첫 조각은 교체(append 없음), 나머지는 이어붙인다. 중간에 끊기면 목록이 짧아져
    // 알람이 더 오는 쪽으로 실패한다 — 덜 오는 쪽으로 실패하면 새 누락이 묻힌다.
    const CHUNK = 500;
    const chunks: string[][] = [];
    for (let i = 0; i < Math.max(list.length, 1); i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
    try {
      for (let i = 0; i < chunks.length; i++) {
      const res = await requestUrl({
        url: `${this.base()}/attest/storage/unrecoverable`,
        method: "PUT",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ hashes: chunks[i], reporter_id: this.reporterId(),
                               ...(i > 0 ? { append: true } : {}) }),
        throw: false,
      });
      // 200 만 보고 넘어가지 않는다 — 서버가 **몇 건을 기록했는지**까지 맞아야 성공이다.
      // 200 은 "응답이 왔다"일 뿐 "내가 보낸 것을 그대로 넣었다"가 아니다.
      const recorded = Number((res.json as { recorded?: number } | null)?.recorded ?? -1);
      if (res.status !== 200 || recorded !== chunks[i].length) {
        console.warn("[nanalstamp] 되살릴 수 없음 보고 실패", res.status, "기록", recorded, "/", chunks[i].length);
        return;                                  // 서명을 갱신하지 않으므로 다음 점검에 전량 재시도
      }
      }
      this.settings.unrecoverableReported = sig;
      await this.persist();
    } catch { /* 네트워크 실패 — 다음 점검에서 다시 시도한다 */ }
  }

  /// "되살릴 수 없음" 판정을 전부 지운다. 다른 기기에서 동기화됐거나 백업을 되돌린 뒤라면
  /// 결과가 달라질 수 있다 — 사람이 그렇게 판단했을 때만 부른다.
  async clearUnrecoverable(): Promise<void> {
    this.settings.unrecoverableHashes = [];
    this.settings.storageLostNoticed = 0;
    await this.persist();
    void this.reportUnrecoverable();   // 비운 것도 알려야 서버가 다시 세기 시작한다
  }

  /// 그 경로의 현재 내용이 찾는 해시와 같으면 돌려준다.
  private async readIfMatches(rel: string, fileHash: string): Promise<Uint8Array | null> {
    const f = this.app.vault.getAbstractFileByPath(rel);
    if (!(f instanceof TFile)) return null;
    try {
      const cur = new Uint8Array(await this.app.vault.readBinary(f));
      return (await sha256HexBytes(cur)) === fileHash ? cur : null;
    } catch { return null; }
  }

  /// 그 해시의 증명 번들(없으면 최소 형태). 업로드에 함께 올라간다.
  protected async proofBodyFor(fileHash: string): Promise<string> {
    // 복구는 지워진 노트를 다뤄 경로를 모른다 — **양쪽 계정에 묻는다**.
    // 팀 계정을 안 쓰면 두 키가 같아 한 번만 나간다.
    const got = await this.askBothAccounts(async (key) => {
      try {
        const res = await requestUrl({
          url: `${this.base()}/attest/bundle?hash=${fileHash}`,
          method: "GET",
          headers: { "x-nanal-api-key": key },
          throw: false,
        });
        if (res.status === 200 && (res.json as { found?: boolean } | null)?.found) return JSON.stringify(res.json, null, 2);
      } catch { /* 번들을 못 받아도 원문 복구는 진행한다 */ }
      return null;
    });
    return got ?? "";
  }

}
