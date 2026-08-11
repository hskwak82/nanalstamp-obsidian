// modals.ts — 봉인·아카이브·복원·계정 관련 모달 12종. main.ts에서 순수 이동(2026-07-26).
// 업무·폴더 모달은 taskmodals.ts에 따로 있다(성격이 다르고 서버 계약도 다르다).
// 뷰 타입 문자열을 constants.ts에서 받는 이유: 여기서 views.ts를 참조하면
// views → modals와 맞물려 값 순환이 된다.

import { App, FuzzySuggestModal, Notice, Platform, Setting, TFile, requestUrl } from "obsidian";
import { NanalModal } from "./modalbase";
import { t, reviewVerdictLabel } from "./i18n";
import { fmtDate, fmtDateTime, fmtUtc } from "./fmtutil";
import { nodeReq, errMsg, sha256Hex, sha256HexBytes, basenameOf, safeName, defaultArchivePathSafe } from "./pathutil";
import { GITHUB_OAUTH_CLIENT_ID, GITHUB_DEFAULT_REPO } from "./constants";
import type NanalStampPlugin from "./main";
import { isMarkdownPath } from "./sealscope";
import { blobExt, fmtBytes } from "./storagecore";
import type { RewindEntry } from "./rewindcore";
import type { HistRow } from "./notebrowsercore";

// 그날로: 이력 행 렌더 슬롯 — 저장처 버튼(el)에 복원 진입점을 붙이려면 seq·when·로컬 유무까지 함께 들고 다녀야 한다.
export type HistSlot = { hash: string; el: HTMLElement; seq: string; when: string; hasLocal: boolean };

// 첫 실행 온보딩: "지금 봉인 — 과거는 소급 증명 불가" 안내 + 설정 유도
// 증명/타임라인 모달: 활성 노트의 봉인 상태·seq·received_at·비트코인 앵커 + 연속 지표
export class ProofModal extends NanalModal {
  private histObserver: IntersectionObserver | null = null;
  constructor(app: App, private plugin: NanalStampPlugin, private file: TFile) {
    super(app);
  }
  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("nanalstamp-proof-modal"); // 확대·외곽·정돈은 styles.css
    contentEl.empty();
    contentEl.addClass("nanalstamp-proof-content"); // flex column: 헤더 / 스크롤 본문 / 고정 푸터
    // 고정 헤더 — 스크롤과 무관하게 항상 상단
    const header = contentEl.createDiv({ cls: "nanalstamp-proof-header" });
    header.createEl("h2", { text: t.proofTitle });
    header.createDiv({ text: this.file.basename, cls: "nanalstamp-proof-file" });
    // 스크롤 본문
    const body = contentEl.createDiv({ cls: "nanalstamp-proof-body" });
    body.createEl("p", { text: t.proofChecking, cls: "setting-item-description" });

    const info = await this.plugin.proofFor(this.file);
    body.empty();

    const head = body.createDiv({ cls: `nanalstamp-proof-chip is-${info.status}` });
    switch (info.status) {
      case "sealed": head.setText(t.proofSealedHead); break;
      case "changed": head.setText(t.proofChangedHead); break;
      case "pending": head.setText(t.proofPendingHead); break;
      case "outscope": head.setText(t.proofOutScopeHead); break;
      default: head.setText(t.proofUnsealedHead);
    }

    if (info.error) body.createEl("p", { text: t.proofErr, cls: "mod-warning" });

    if (info.status === "sealed") {
      // 상태 정보를 라벨:값 2열 그리드로(라벨 muted, 값 normal·tabular-nums). "라벨: 값" 문구를 첫 ": "로 분리.
      const status = body.createDiv({ cls: "nanalstamp-proof-status" });
      const statRow = (text: string) => {
        const idx = text.indexOf(": ");
        if (idx > 0) {
          status.createSpan({ cls: "k", text: text.slice(0, idx) });
          status.createSpan({ cls: "v", text: text.slice(idx + 2) });
        } else {
          status.createSpan({ cls: "k", text: "" });
          status.createSpan({ cls: "v", text });
        }
      };
      if (typeof info.seq === "number") statRow(t.proofSeq(info.seq));
      // received_at 은 epoch(초)다. 그대로 넣으면 화면에 `봉인 시각: 1785430822` 가 뜬다
      // (오픈 전 검수에서 발견 — 아래 봉인 이력은 fmtDateTime 을 쓰는데 여기만 빠져 있었다).
      // 숫자면 사람이 읽는 시각으로, 이미 문자열이면 그대로 쓴다.
      if (info.receivedAt) {
        const at = typeof info.receivedAt === "number"
          ? fmtDateTime(new Date(info.receivedAt * 1000)) : String(info.receivedAt);
        statRow(t.proofReceived(at));
      }
      if (info.blockHeight) statRow(t.proofAnchorConfirmed(info.blockHeight));
      else if (info.anchored) statRow(t.proofAnchorPending);
      else statRow(t.proofAnchorNone);
    } else if (info.status === "changed") {
      body.createEl("p", { text: t.proofChangedBody, cls: "setting-item-description" });
    } else if (info.status === "unsealed") {
      body.createEl("p", { text: t.proofUnsealedBody, cls: "setting-item-description" });
    }

    // (전체 통계 '연속 봉인·총 N건'은 노트 단위 창에 부적절해 제거 — 노트별 총 봉인수는 이력 제목에 표시.)

    // 점검 상태 배지 — 봉인·팀 소속 사용자만 리뷰가 있다. 404·403·네트워크는 null → 섹션 생략.
    const reviews = await this.plugin.fetchReviewStatus(this.file);
    if (reviews && reviews.length > 0) {
      body.createEl("hr");
      body.createEl("p", { text: t.reviewSectionTitle, cls: "setting-item-name" });
      for (const r of reviews) {
        if (r.status === "signed") {
          const when = fmtUtc(r.reviewed_at ?? 0);
          body.createEl("p", { text: t.reviewSigned(reviewVerdictLabel(r.statement ?? ""), r.reviewer_email || "—", when) });
        } else if (r.status === "pending") {
          body.createEl("p", { text: t.reviewPending, cls: "setting-item-description" });
        } else if (r.status === "declined") {
          body.createEl("p", { text: t.reviewDeclined(r.decline_note ?? ""), cls: "setting-item-description" });
        }
      }
    }

    // 봉인 이력 섹션 placeholder — 이력 조회가 모달 오픈을 막지 않도록 먼저 현재 정보/닫기 버튼을 렌더한 뒤
    // 비동기로 채운다. 실패·비어있음이면 아무것도 추가하지 않는다(잡음 금지).
    // 이 노트에 대한 작업 — 리본에서 여기로 모았다(2026-07-30). 대상이 "지금 이 노트"이므로
    // 그 노트의 증명 화면이 제자리다. 리본은 내보내기·검토(패키지·점검 요청)만 남겼다.
    if (info.status === "sealed") {
      const acts = body.createDiv({ cls: "nanalstamp-proof-actions" });
      const act = (label: string, fn: () => void) => {
        const b = acts.createEl("button", { text: label, cls: "nanalstamp-hist-btn" });
        b.onclick = fn;
      };
      // 건당 증명서 발급 버튼은 뺐다(2026-08-05) — 제출 패키지가 그 일을 흡수했다.
      act(t.publicCmd, () => { this.close(); void this.plugin.makePublicLink(); });
      act(t.pkgCmd, () => { this.close(); this.plugin.openSubmissionPackage(); });
    }

    const histHost = body.createDiv();

    void this.appendHistory(histHost);
  }

  // 봉인 이력 섹션(전체 + 무한 스크롤)을 비동기로 append. 첫 페이지 20건 렌더 후 하단 sentinel 노출 시
  // 다음 페이지를 이어 로드한다. 각 행에 아카이브 확정 버전이 있으면 "원문 보기" 버튼. 폴백(구서버)은 전량 1회.
  private async appendHistory(host: HTMLElement) {
    const first = await this.plugin.fetchHistoryPage(this.file);
    if (!first || first.rows.length === 0) return; // 잡음 금지: 실패·비어있음이면 섹션 생략

    const isMd = isMarkdownPath(this.file.path);
    const safe = safeName(this.file.path);
    const rel = isMd ? `notes/${safe}.md` : `attachments/${safe}`;
    // 아카이브 대응표(seq→커밋)는 첫 로드 때 1회만 만들어 재사용 — 이후 새 페이지 행도 같은 map으로 "원문 보기" 판단.
    const archiveOn = this.plugin.dashboardArchiveOn();
    const bySeq = new Map<string, { oid: string; ts: number; tzo: number; seq: string; block: string }>();
    if (archiveOn) {
      // git.log 는 최신순 → 같은 seq 가 여러 커밋에 있으면 첫(=최신) 것만 채택(확정 커밋이 pending 을 덮어쓰지 않게).
      for (const v of await this.plugin.archiveVersionsOf(rel)) if (!bySeq.has(v.seq)) bySeq.set(v.seq, v);
    }

    host.createEl("hr");
    host.createEl("p", { text: t.histSectionTitle(first.total ?? first.rows.length), cls: "setting-item-name" });
    const scroller = host.createDiv({ cls: "nanalstamp-hist-scroll" });
    const rowsHost = scroller.createDiv();
    const sentinel = scroller.createDiv({ cls: "nanalstamp-hist-sentinel" });

    // B: '원문 보기'를 저장처별 버튼으로 — 실제 저장된 곳만 노출한다.
    // 로컬(git 아카이브 seq 대응 커밋) / GitHub(현재 미러본과 해시 일치 시) / nanalStamp(존재 일괄 확인 후 비동기 추가).
    const nanalExt = isMd ? "md" : blobExt(this.file.path);
    const renderRow = (row: { seq: number; receivedAt: number; fileHash: string; confirmed: boolean; block?: number }): HistSlot | null => {
      const when = fmtDateTime(new Date(row.receivedAt * 1000)); // received_at 은 epoch(초)
      const isConfirmed = row.confirmed && typeof row.block === "number";
      // 확정(비트코인 앵커됨) / 대기 를 클래스로 시각 구분. 확정만 ₿ 블록·색 강조, 대기는 흐리게.
      const item = rowsHost.createDiv({ cls: `nanalstamp-hist-row ${isConfirmed ? "is-confirmed" : "is-pending"}` });
      const main = item.createDiv({ cls: "nanalstamp-hist-main" });
      main.createSpan({ cls: "nanalstamp-hist-when", text: when });
      const meta = main.createSpan({ cls: "nanalstamp-hist-meta" });
      meta.createSpan({ cls: "nanalstamp-hist-seq", text: `seq ${row.seq}` });
      if (isConfirmed) {
        meta.createSpan({ cls: "nanalstamp-hist-btc", text: `₿ ${(row.block as number).toLocaleString()}` });
      } else {
        meta.createSpan({ cls: "nanalstamp-hist-wait", text: t.histAnchorWait });
      }
      const btns = item.createDiv({ cls: "nanalstamp-hist-srcs" });
      const ver = bySeq.get(String(row.seq));
      if (archiveOn && ver) {
        const btn = btns.createEl("button", { cls: "nanalstamp-hist-btn", text: t.histSrcLocal, attr: { title: t.histViewSource } });
        btn.onclick = () => {
          void this.plugin.openArchiveSource(this.file.path, ver, safe, rel, isMd);
          this.close();
        };
      }
      // GitHub 미러는 최신본만 파일로 유지(과거 버전은 repo 커밋 이력) — 이 행 해시가 현재 미러본일 때만 링크.
      if (row.fileHash && this.plugin.settings.mirrorIndex[this.file.path] === row.fileHash) {
        const url = this.plugin.githubMirrorUrl(this.file);
        if (url) {
          const btn = btns.createEl("button", { cls: "nanalstamp-hist-btn", text: t.histSrcGithub, attr: { title: t.histViewSource } });
          btn.onclick = () => { window.open(url); };
        }
      }
      // 그날로: 로컬 아카이브에 이 버전 커밋이 있으면 [복원] — 소스 버튼과 같은 노출 원칙(있는 곳만).
      if (archiveOn && ver && row.fileHash) {
        const rb = btns.createEl("button", { cls: "nanalstamp-hist-btn", text: t.rewindRestoreBtn });
        rb.onclick = () => {
          new RestoreConfirmModal(this.app, this.plugin, {
            notePath: this.file.path, expectedHash: row.fileHash, oid: ver.oid, isMd,
            seq: String(row.seq), when,
          }).open();
          this.close();
        };
      }
      return row.fileHash
        ? { hash: row.fileHash, el: btns, seq: String(row.seq), when, hasLocal: !!(archiveOn && ver) }
        : null;
    };

    // nanalStamp 버튼은 서버에 존재를 일괄 확인한 뒤(페이지당 1회) 있는 행에만 붙인다.
    const fillNanal = async (slots: HistSlot[]) => {
      if (slots.length === 0) return;
      const uniq = [...new Set(slots.map((s) => s.hash))];
      const exists = await this.plugin.nanalExists(uniq.map((h) => ({ sha256: h, ext: nanalExt })));
      if (!exists) return; // 실패·구서버 → 버튼 생략(잡음 금지)
      const ok = new Set(uniq.filter((_, i) => exists[i]));
      for (const s of slots) {
        if (!ok.has(s.hash)) continue;
        const btn = s.el.createEl("button", { cls: "nanalstamp-hist-btn", text: t.histSrcNanal, attr: { title: t.histViewSource } });
        btn.onclick = () => {
          void this.plugin.openNanalView(this.file.path, s.hash, isMd);
          this.close();
        };
        // 그날로: 로컬 복원 버튼이 이미 있으면 중복 노출하지 않는다 — nanal 소스로만 복원 가능한 행에만 추가.
        if (!s.hasLocal) {
          const rb = s.el.createEl("button", { cls: "nanalstamp-hist-btn", text: t.rewindRestoreBtn });
          rb.onclick = () => {
            new RestoreConfirmModal(this.app, this.plugin, {
              notePath: this.file.path, expectedHash: s.hash, isMd, seq: s.seq, when: s.when,
            }).open();
            this.close();
          };
        }
      }
    };

    const firstSlots = first.rows.map(renderRow).filter((s): s is HistSlot => s !== null);
    void fillNanal(firstSlots);

    // 폴백(구서버)이거나 더 없으면 무한 스크롤 불필요 — 전량 렌더 완료.
    if (first.fallback || !first.hasMore) return;

    let lastSeq = first.rows[first.rows.length - 1].seq;
    let hasMore: boolean = first.hasMore;
    let loading = false; // 중복 로드 가드(in-flight)

    const loadNext = async () => {
      if (loading || !hasMore) return;
      loading = true;
      // 로딩 중 한 줄 표시(로드 완료 시 제거) — sentinel 바로 위에.
      const loadingEl = scroller.createEl("p", { text: t.histLoadingMore, cls: "setting-item-description nanalstamp-hist-loading" });
      scroller.insertBefore(loadingEl, sentinel);
      const page = await this.plugin.fetchHistoryPage(this.file, lastSeq);
      loadingEl.remove();
      loading = false;
      if (!page) { hasMore = false; this.histObserver?.unobserve(sentinel); return; }
      const pageSlots = page.rows.map(renderRow).filter((s): s is HistSlot => s !== null);
      void fillNanal(pageSlots);
      if (page.rows.length > 0) lastSeq = page.rows[page.rows.length - 1].seq;
      hasMore = page.hasMore && page.rows.length > 0;
      if (!hasMore) { this.histObserver?.unobserve(sentinel); return; }
      // 새 행 추가 후에도 sentinel 이 여전히 보이면(짧은 목록) 재관측으로 이어서 로드.
      this.histObserver?.unobserve(sentinel);
      this.histObserver?.observe(sentinel);
    };

    // 스크롤은 이제 본문(.nanalstamp-proof-body)이 담당 — sentinel 관측 root 를 그 스크롤 컨테이너로.
    const scrollRoot = host.closest(".nanalstamp-proof-body");
    this.histObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) void loadNext();
    }, { root: scrollRoot });
    this.histObserver.observe(sentinel);
  }

  onClose() {
    this.histObserver?.disconnect();
    this.histObserver = null;
    this.contentEl.empty();
  }
}

// P6: 아카이브 버전 선택 모달 — 이 노트가 git 아카이브에 남긴 확정 버전들을 나열,
// 하나를 고르면 그 시점 원문+증명을 readBlob으로 읽어 오프라인 검증 후 번들(FREE)/증명서(PRO)로 내보낸다.
// 현재 노트는 절대 건드리지 않는다.
export class ArchiveVersionModal extends NanalModal {
  constructor(
    app: App,
    private plugin: NanalStampPlugin,
    private notePath: string,
    private safe: string,
    private versions: Array<{ oid: string; ts: number; tzo: number; seq: string; block: string; safe?: string; srcPath?: string }>,
    private titleText: string = t.pitModalTitle,
    private pickText: string = t.pitPick,
  ) {
    super(app);
  }

  onOpen() {
    this.renderList();
  }

  onClose() {
    this.contentEl.empty();
  }

  // 개명 전 이력 합산 버전은 아카이브 안에서 옛 safe로 저장돼 있다 — 읽기·복원·내보내기 전부 버전별 safe 우선.
  private safeOf(ver: { safe?: string }): string { return ver.safe ?? this.safe; }

  private renderList() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    contentEl.createDiv({ text: basenameOf(this.notePath), cls: "setting-item-name" });
    contentEl.createEl("p", { text: this.pickText, cls: "setting-item-description" });
    for (const ver of this.versions) {
      const when = fmtDateTime(new Date(ver.ts * 1000));
      const desc = t.pitVersionDesc(ver.seq, ver.block) + (ver.srcPath ? ` · ${t.pitFromOld(basenameOf(ver.srcPath))}` : "");
      new Setting(contentEl)
        .setName(when)
        .setDesc(desc)
        .addButton((b) => b.setButtonText(t.pitSelectBtn).setCta().onClick(() => void this.renderDetail(ver)))
        .addButton((b) => b.setButtonText(t.rewindRestoreBtn).onClick(async () => {
          // 기대 해시 = 커밋 동반 proof의 file_hash(외부 기준) — 없으면 원문 자체 해시(경로 태그용, 진본성 게이트 아님).
          const read = await this.plugin.readArchivedVersion(ver.oid, this.safeOf(ver));
          if (!read) { new Notice(t.pitReadFail); return; }
          const eh = String(read.proof?.file_hash || "") || (await sha256Hex(read.note));
          new RestoreConfirmModal(this.app, this.plugin, {
            notePath: this.notePath, expectedHash: eh, oid: ver.oid, isMd: true,
            seq: ver.seq, when, srcSafe: ver.safe,
          }).open();
          this.close();
        }));
    }
  }

  private async renderDetail(ver: { oid: string; ts: number; tzo: number; seq: string; block: string; safe?: string; srcPath?: string }) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    contentEl.createDiv({ text: basenameOf(this.notePath), cls: "setting-item-name" });
    const loading = contentEl.createEl("p", { text: t.pitReading, cls: "setting-item-description" });

    const read = await this.plugin.readArchivedVersion(ver.oid, this.safeOf(ver));
    loading.remove();
    if (!read) {
      contentEl.createEl("p", { text: t.pitReadFail, cls: "mod-warning" });
      new Setting(contentEl).addButton((b) => b.setButtonText(t.pitBackToList).onClick(() => this.renderList()));
      return;
    }
    const v = await this.plugin.selfVerifyArchived(read.note, read.proof);
    const dateLabel = fmtDate(new Date(ver.ts * 1000));

    const verdict = contentEl.createEl("p");
    verdict.addClass(v.ok ? "setting-item-name" : "mod-warning");
    verdict.setText(v.ok ? t.pitVerifyOk : !v.hashMatch ? t.pitVerifyHashBad : t.pitVerifyNoBlock);
    // 내용은 일치하나 블록만 없음(=봉인 시점 pending 사본) → "미앵커"로 오해 않도록 온라인 이력 안내.
    if (!v.ok && v.hashMatch) contentEl.createEl("p", { text: t.pitAnchorHint, cls: "setting-item-description" });

    contentEl.createEl("p", { text: t.pitDetailDate(fmtDateTime(new Date(ver.ts * 1000))) });
    if (v.seq != null) contentEl.createEl("p", { text: t.pitDetailSeq(String(v.seq)) });
    if (v.block != null) contentEl.createEl("p", { text: t.pitDetailBlock(String(v.block)) });
    contentEl.createEl("p", { text: t.pitDetailHash(v.expected || v.computed), cls: "setting-item-description" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.pitExportBundle).setCta().onClick(async () => {
        try {
          const p = await this.plugin.exportPitBundle(this.safeOf(ver), dateLabel, ver.oid, read.note, read.proofRaw, v);
          new Notice(t.pitBundleOk(p));
        } catch (e) { new Notice(t.pitExportFail(errMsg(e))); }
      }))
      .addButton((b) => b.setButtonText(t.pitExportCert).onClick(async () => {
        try {
          const p = await this.plugin.exportPitCertificate(this.safeOf(ver), basenameOf(this.notePath), read.note, dateLabel, ver.oid, v, read.proofRaw);
          if (p) new Notice(t.pitCertOk(p));
        } catch (e) { new Notice(t.pitExportFail(errMsg(e))); }
      }));
    new Setting(contentEl).addButton((b) => b.setButtonText(t.pitBackBtn).onClick(() => this.renderList()));
  }
}

// 첨부 아카이브 버전 목록 모달 — ArchiveVersionModal(.md 전제: 검증·증명서)과 달리
// 첨부는 버전을 고르면 바로 원문 뷰(ArchiveSourceView)로 넘긴다.
export class AttachmentVersionModal extends NanalModal {
  constructor(
    app: App,
    private plugin: NanalStampPlugin,
    private notePath: string,
    private safe: string,
    private rel: string,
    private versions: Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>,
    private titleText: string = t.pitModalTitle,
    private pickText: string = t.pitPick,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    contentEl.createDiv({ text: basenameOf(this.notePath), cls: "setting-item-name" });
    contentEl.createEl("p", { text: this.pickText, cls: "setting-item-description" });
    for (const ver of this.versions) {
      const when = fmtDateTime(new Date(ver.ts * 1000));
      new Setting(contentEl)
        .setName(when)
        .setDesc(t.pitVersionDesc(ver.seq, ver.block))
        .addButton((b) => b.setButtonText(t.histViewSource).setCta().onClick(() => {
          void this.plugin.openArchiveSource(this.notePath, ver, this.safe, this.rel, false);
          this.close();
        }))
        .addButton((b) => b.setButtonText(t.rewindRestoreBtn).onClick(async () => {
          const bytes = await this.plugin.archiveReadBytes(ver.oid, this.rel);
          if (!bytes) { new Notice(t.pitReadFail); return; }
          new RestoreConfirmModal(this.app, this.plugin, {
            notePath: this.notePath, expectedHash: await sha256HexBytes(bytes), oid: ver.oid, isMd: false,
            seq: ver.seq, when,
          }).open();
          this.close();
        }));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 시작 범위 모달: 로그인 직후(신규) 또는 업데이트 후 첫 로드(기존 사용자)에 1회 — 봉인·보관 범위를 고른다.
// "로그인만 하면 동작" 철학대로 기본값(전부 봉인·전부 보관)이 그대로 [시작]을 누르면 적용되는 CTA.
// RestoreConfirmModal 관례를 따른다 — Setting 기반 토글·버튼, onClose는 비움.
/// 이 계정으로 쓰던 설정이 남아 있을 때 — 이어서 쓸지, 새로 시작할지 묻는다.
///
/// 왜 묻나: 계정을 오가며 쓰는 사람에게 매번 처음부터 정하게 하면, **시작 시점이 오늘로 잡혀**
/// 자리를 비운 사이 고쳐진 노트가 영영 봉인 대상에서 빠진다. 그 선택은 사람이 해야 한다.
export class AccountResumeModal extends NanalModal {
  constructor(app: App, private plugin: NanalStampPlugin, private uid: string) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    const p = this.plugin.savedProfileFor(this.uid);
    this.titleEl.setText(t.acctResumeTitle);
    if (!p) { this.close(); return; }

    contentEl.createEl("p", { text: t.acctResumeDesc });

    // 무엇을 되살리는지 그대로 보여준다 — 고르기 전에 알아야 한다.
    const box = contentEl.createDiv({ cls: "nanalstamp-kv-box" });
    const row = (k: string, v: string) => {
      const d = box.createDiv({ cls: "nanalstamp-kv-row" });
      d.createSpan({ text: k, cls: "nanalstamp-kv-key" });
      d.createSpan({ text: v });
    };
    if (p.email) row(t.acctResumeAccount, p.email);
    row(t.acctResumeScope, p.includeFolders.trim() || t.acctResumeWholeVault);
    if (p.excludeFolders.trim()) row(t.acctResumeExclude, p.excludeFolders.trim());
    row(t.acctResumeSince, p.sealSince > 0 ? new Date(p.sealSince).toLocaleString("ko-KR") : t.acctResumeNoLimit);
    row(t.acctResumeSaved, new Date(p.savedAt).toLocaleString("ko-KR"));

    contentEl.createEl("p", { text: t.acctResumeHint, cls: "setting-item-description" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.acctResumeFresh).onClick(() => {
        this.close();
        new OnboardingScopeModal(this.app, this.plugin).open();   // 처음 로그인과 같은 물음
      }))
      .addButton((b) => b.setButtonText(t.acctResumeContinue).setCta().onClick(() => {
        this.plugin.applyAccountProfile(this.uid);
        new Notice(t.acctResumeDone, 8000);
        this.close();
      }));
  }
}

export class OnboardingScopeModal extends NanalModal {
  private draftBackfill: boolean;
  private draftNanalBackfill: boolean;
  private draftWholeVault: boolean;

  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app);
    this.draftBackfill = plugin.settings.autoBackfill;
    this.draftNanalBackfill = plugin.settings.nanalBackfill;
    this.draftWholeVault = plugin.settings.sealWholeVault;
  }

  onOpen() {
    // 중복 오픈 가드 — 부팅 시(onLayoutReady)와 로그인 버튼 두 트리거가 겹쳐도 하나만(리뷰 지적).
    this.plugin.scopeModalOpen = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.onboardScopeTitle });
    contentEl.createEl("p", { text: t.onboardScopeIntro, cls: "setting-item-description" });

    // 섹션 0 — **어디를 봉인할지**(2026-07-28). 이 선택 전에는 봉인이 시작되지 않으므로 맨 위에 둔다.
    // 팀 루트가 있으면 범위가 이미 정해져 있으니 이 섹션은 뜻이 없다.
    if (!this.plugin.teamRoot()) {
      new Setting(contentEl).setName(t.onboardScopePickName).setHeading();
      const warnEl = contentEl.createEl("p", { cls: "setting-item-description mod-warning" });
      const paint = () => {
        const picked = this.draftWholeVault || !!this.plugin.settings.includeFolders;
        warnEl.setText(picked ? "" : t.onboardScopeNoneWarn);
        warnEl.toggle(!picked);
      };
      new Setting(contentEl)
        .setName(t.onboardScopePickDesc)
        .addButton((b) => b.setButtonText(t.onboardScopePickBtn).onClick(() => {
          // 트리에서 고르면 includeFolders가 채워진다 — 닫히고 나서 경고를 다시 칠한다.
          this.plugin.openFolderScopePicker(() => paint());
        }));
      new Setting(contentEl)
        .setName(t.onboardScopeWholeName)
        .setDesc(t.onboardScopeWholeDesc)
        .addToggle((tg) => tg.setValue(this.draftWholeVault).onChange((v) => { this.draftWholeVault = v; paint(); }));
      paint();
    }

    // 섹션 A — 봉인 범위(항상 표시, 스토리지 미사용 FREE 포함)
    new Setting(contentEl).setName(t.onboardSealSectionName).setHeading();
    new Setting(contentEl)
      .setName(t.onboardSealAllName)
      .setDesc(t.onboardSealAllDesc)
      .addToggle((tg) => tg.setValue(this.draftBackfill).onChange((v) => (this.draftBackfill = v)));

    // 섹션 A2 — 지난 버전이 쌓이는 곳(2026-07-29 사용자 지적). "무엇을 봉인할지" 고른 사람이
    // 바로 이어서 알아야 할 것은 "그게 어디에 남는가"다. 특히 FREE에서는 이 폴더가 원문을 보존하는
    // 유일한 저장처이고 기기에 묶여 있다 — 그 사실을 설정 깊숙이 두면 아무도 모른 채 굴러간다.
    new Setting(contentEl).setName(t.onboardArchiveSectionName).setHeading();
    if (!Platform.isDesktopApp) {
      contentEl.createEl("p", { text: t.onboardArchiveMobile, cls: "setting-item-description" });
    } else {
      const pathSetting = new Setting(contentEl)
        .setName(t.archivePathName) // 설정탭과 같은 이름 — 나중에 설정에서 찾을 때 같은 말로 찾게
        .setDesc(t.onboardArchivePathDesc)
        .addButton((b) =>
          b.setButtonText(t.archivePickBtn).onClick(async () => {
            // 설정탭의 폴더선택과 같은 경로(applyArchivePath) — 이관·중복·vault내부 판정을 한 군데서만 한다.
            let chosen = "";
            try {
              const remote = nodeReq("@electron/remote");
              const r = await remote?.dialog?.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
              if (r && !r.canceled && r.filePaths?.[0]) chosen = r.filePaths[0];
            } catch { /* 다이얼로그 불가 → 설정탭에서 직접 입력. 여기서는 조용히 넘긴다 */ }
            if (!chosen) return;
            const res = await this.plugin.applyArchivePath(chosen);
            if (res.status === "migrated") new Notice(t.archiveMigrated(res.a || "", res.b || ""));
            else if (res.status === "exists") new Notice(t.archiveExists);
            else if (res.status === "set") new Notice(t.archiveSet(res.b || ""));
            else if (res.status === "invault") new Notice(t.archiveInVault);
            else if (res.status === "error") new Notice(t.archiveNotWritable(res.b || chosen));
            paintArchivePath();
          })
        );
      const hereEl = pathSetting.descEl.createDiv({ cls: "nanalstamp-onboard-path" });
      const paintArchivePath = () =>
        hereEl.setText(t.onboardArchiveHere(this.plugin.settings.archivePath || defaultArchivePathSafe(this.app.vault.getName())));
      paintArchivePath();
      contentEl.createEl("p", { text: t.onboardArchiveSyncWarn, cls: "setting-item-description" });
    }

    // 기기 종속 경고 + 구독 안내. 세 갈래로 나누는 이유: "구독하면 nanalStorage에도"는
    // 이미 구독 중인 사람에게는 틀린 말이고, 스토리지를 꺼 둔 사람에게는 켜라는 말이어야 한다.
    if (this.plugin.nanalActive()) {
      contentEl.createEl("p", { text: t.onboardArchivePaidNote, cls: "setting-item-description" });
    } else if (this.plugin.isPro()) {
      contentEl.createEl("p", { text: t.onboardArchiveStorageOff, cls: "setting-item-description mod-warning" });
    } else {
      const box = contentEl.createDiv({ cls: "nanalstamp-onboard-upsell" });
      box.createEl("p", { text: t.onboardArchiveFreeWarn, cls: "nanalstamp-onboard-upsell-warn" });
      box.createEl("p", { text: t.onboardArchiveFreeCta });
      const btn = box.createEl("button", { text: t.onboardArchiveUpgradeBtn, cls: "mod-cta" });
      btn.onclick = () => this.plugin.openExternal("/pricing");
    }

    // 섹션 B — 원문 보관 범위(스토리지 사용 가능 + 켜짐일 때만)
    if (this.plugin.nanalActive()) {
      new Setting(contentEl).setName(t.onboardStorageSectionName).setHeading();
      const capEl = contentEl.createEl("p", { text: t.storageUsageLoading, cls: "setting-item-description" });
      new Setting(contentEl)
        .setName(t.onboardStorageAllName)
        .setDesc(t.onboardStorageAllDesc)
        .addToggle((tg) => tg.setValue(this.draftNanalBackfill).onChange((v) => (this.draftNanalBackfill = v)));
      void this.renderCapacity(capEl); // 쿼터 조회는 비동기 — 렌더를 막지 않는다
    }

    new Setting(contentEl).addButton((b) =>
      b.setButtonText(t.onboardStartBtn).setCta().onClick(async () => {
        this.plugin.settings.autoBackfill = this.draftBackfill;
        // 소급을 끄면 **이 순간이 이 계정의 봉인 시작 시점**이다. 그 이전 파일은 대상이 아니다
        // (미봉인이 아니라 대상 아님 — main.sealTarget 주석 참조). 켜면 제한 없음.
        this.plugin.settings.sealSince = this.draftBackfill ? 0 : Date.now();
        if (this.plugin.nanalActive()) {
          this.plugin.settings.nanalBackfill = this.draftNanalBackfill;
          if (!this.draftNanalBackfill) this.plugin.settings.nanalSince = Date.now(); // "지금부터"만 소급 대상
        }
        this.plugin.settings.sealWholeVault = this.draftWholeVault;
        this.plugin.settings.scopeChosen = true; // 다시 뜨지 않게 — 이 모달의 유일한 목적
        await this.plugin.saveSettings();
        if (this.draftBackfill) this.plugin.startBackfill(); // 꺼짐은 설정탭과 동일 관례: 다음 백필 틱이 스스로 멈춘다
        this.plugin.updateTaskRibbon();          // 범위가 정해졌으면 리본 경고를 즉시 내린다
        void this.plugin.updateActiveStatus();
        this.close();
      })
    );
  }

  // 예상 소급 보관 용량 vs 쿼터. lastUsage 캐시가 없으면 조회 후 채운다 — 렌더 프리즈 방지로 onOpen과 분리.
  private async renderCapacity(el: HTMLElement): Promise<void> {
    const bytes = this.plugin.scopeSealableBytes();
    if (!this.plugin.lastUsage) await this.plugin.fetchStorageUsage();
    if (!this.contentEl.isConnected) return; // 조회 중 모달이 닫혔으면 DOM 조작 스킵
    const u = this.plugin.lastUsage;
    if (u && u.quota > 0) {
      el.setText(t.onboardCapacityLine(fmtBytes(bytes), fmtBytes(u.quota)));
      if (u.used + bytes > u.quota) {
        el.addClass("mod-warning");
        const warn = el.createDiv({ cls: "mod-warning" });
        warn.createSpan({ text: t.onboardCapacityWarn + " " });
        const link = warn.createEl("a", { text: t.pricingCmd });
        link.onclick = () => this.plugin.openExternal("/pricing");
      }
    } else {
      el.setText(t.onboardCapacityLine(fmtBytes(bytes), "—"));
    }
  }

  onClose() {
    this.plugin.scopeModalOpen = false; // 재오픈 허용([시작] 안 눌렀으면 다음 트리거에서 다시 뜬다)
    this.contentEl.empty();
  }
}

// 그날로 확인 모달 — 파괴적 동작(원위치 교체) 앞 한 번의 명시적 선택(로그아웃 확인창과 같은 문법).
// 사본(기본·안전)이 CTA, 원위치는 warning. 삭제된 노트면 원위치 문구가 "재생성"으로 바뀐다.
export class RestoreConfirmModal extends NanalModal {
  constructor(
    app: App,
    private plugin: NanalStampPlugin,
    private opts: { notePath: string; expectedHash: string; oid?: string; isMd: boolean; seq: string; when: string; srcSafe?: string },
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.rewindConfirmTitle });
    contentEl.createDiv({ text: basenameOf(this.opts.notePath), cls: "setting-item-name" });
    contentEl.createEl("p", { text: t.rewindConfirmMeta(this.opts.seq, this.opts.when), cls: "setting-item-description" });
    const pick = { notePath: this.opts.notePath, expectedHash: this.opts.expectedHash, oid: this.opts.oid, isMd: this.opts.isMd, srcSafe: this.opts.srcSafe };
    const deleted = !(this.app.vault.getAbstractFileByPath(this.opts.notePath) instanceof TFile);
    new Setting(contentEl)
      .setName(t.rewindCopyBtn)
      .setDesc(t.rewindCopyDesc)
      .addButton((b) => b.setButtonText(t.rewindCopyBtn).setCta().onClick(() => {
        this.close();
        void this.plugin.restoreVersion({ ...pick, mode: "copy" });
      }));
    new Setting(contentEl)
      .setName(t.rewindInplaceBtn)
      .setDesc(deleted ? t.rewindInplaceRecreate : t.rewindInplaceDesc)
      .addButton((b) => b.setButtonText(t.rewindInplaceBtn).setWarning().onClick(() => {
        this.close();
        void this.plugin.restoreVersion({ ...pick, mode: "inplace" });
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 삭제된 노트 카드의 수동 개명 연결 — 자동(이벤트·내용 정확 일치)이 못 잇는 잔재(기능 도입 전 개명,
// Obsidian 꺼진 사이 외부 개명+수정)를 사용자가 직접 확정한다. 자동 유사도 추정은 서로 다른 노트를
// 합칠 이론적 위험 때문에 배제(2026-07-22 사용자 결정).
export class RenameLinkSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private plugin: NanalStampPlugin, private oldPath: string, private onDone: () => void) {
    super(app);
    this.setPlaceholder(t.dashLinkPick);
  }
  getItems(): TFile[] {
    const wantMd = isMarkdownPath(this.oldPath);
    return this.app.vault.getFiles().filter((f) => isMarkdownPath(f.path) === wantMd && this.plugin.dashInScope(f.path));
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void {
    this.plugin.setRenameLink(this.oldPath, f.path);
    new Notice(t.dashLinkDone(basenameOf(this.oldPath), basenameOf(f.path)));
    this.onDone();
  }
}

// 그날로: 삭제된 노트 선택 — 경로 퍼지 검색 + 마지막 봉인 시각. 선택하면 P6 버전 모달(버전 목록→열람→복원).
export class DeletedNoteSuggestModal extends FuzzySuggestModal<RewindEntry> {
  constructor(app: App, private plugin: NanalStampPlugin, private items: RewindEntry[]) {
    super(app);
    this.setPlaceholder(t.rewindDeletedPick);
  }
  getItems(): RewindEntry[] { return this.items; }
  getItemText(e: RewindEntry): string { return `${e.notePath} — ${t.rewindLastSealed(fmtDateTime(new Date(e.ts)))}`; }
  onChooseItem(e: RewindEntry): void { void this.plugin.openArchiveModalFor(e.notePath, t.rewindVersionTitle, t.rewindVersionPick); }
}

// 보관 대기 목록 모달 — 대기 칩 클릭. 본질은 재시도가 아니라 투명성(무엇이·왜 안 올라갔나).
export class StoragePendingModal extends NanalModal {
  constructor(app: App, private plugin: NanalStampPlugin, private axis: string, private paths: string[]) { super(app); }
  onOpen() {
    const c = this.contentEl;
    c.createEl("h2", { text: t.pendModalTitle(this.axis) });
    const reason = this.plugin.storagePendingReason();
    if (reason) {
      c.createEl("p", { text: reason, cls: "nanalstamp-restore-line is-error" });
    }
    if (this.paths.length === 0) {
      c.createEl("p", { text: t.pendListEmpty, cls: "nanalstamp-archive-note" });
    } else {
      const list = c.createDiv({ cls: "nanalstamp-pend-list" });
      for (const pth of this.paths.slice(0, 300)) {
        const it = list.createDiv({ cls: "nanalstamp-pend-item" });
        it.createDiv({ text: pth, cls: "nanalstamp-pend-name" });
        // **왜** 안 올라갔는지 함께 적는다. 경로만 보이면 "재시도" 말고 할 수 있는 일이 없다 —
        // 용량 초과인지, 봉인 뒤 파일이 바뀐 것인지에 따라 사용자가 할 일이 다르다(2026-08-01).
        const st = (this.plugin.settings.uploadStall || {})[pth];
        if (st && st.why) {
          it.createDiv({ text: st.why, cls: "nanalstamp-pend-why" });
        }
      }
      if (this.paths.length > 300) c.createEl("p", { text: t.dashMore(this.paths.length - 300), cls: "nanalstamp-archive-note" });
    }
    new Setting(c).addButton((b) => b.setButtonText(t.pendRetryBtn).setCta().onClick(() => {
      this.plugin.kickStorageSync(); // 30초 주기를 기다리지 않고 즉시 1회
      this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

// vault 일괄 재구성 모달 — 기간(선택)·vault(선택) 지정 후 실행. 정책: 롤링 1년 무료 2회(서버 집행).
export class RestoreVaultModal extends NanalModal {
  constructor(app: App, private plugin: NanalStampPlugin) { super(app); }
  private fromStr = "";
  private toStr = "";
  private vaultHash = "";
  private vaults: Array<{ hash: string; name: string }> = [];
  private previewEl: HTMLElement | null = null;

  // YYYY-MM-DD → epoch초. undefined=미입력(전체), null=형식 오류.
  private parseDay(str: string, endOfDay: boolean): number | undefined | null {
    if (!str) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const [y, m, d] = str.split("-").map((x) => parseInt(x, 10));
    const dt = new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
    return Math.floor(dt.getTime() / 1000);
  }

  // 대상 미리보기 — 서버가 note_names.size(봉인 시 동봉)·storage_events(90일) 합산. 차감 없음.
  private async refreshPreview(): Promise<void> {
    const el = this.previewEl;
    if (!el) return;
    const fromTs = this.parseDay(this.fromStr, false);
    const toTs = this.parseDay(this.toStr, true);
    if (fromTs === null || toTs === null) { el.setText(""); return; }
    try {
      const qs = `${fromTs != null ? `&from_ts=${fromTs}` : ""}${toTs != null ? `&to_ts=${toTs}` : ""}${this.vaultHash ? `&vault_hash=${this.vaultHash}` : ""}`;
      const r = await requestUrl({ url: `${this.plugin.base()}/attest/restore/preview?_=1${qs}`, method: "GET", headers: { "x-nanal-api-key": this.plugin.settings.apiKey }, throw: false });
      const pj = r.json as { count?: number; known_bytes?: number; unknown_count?: number } | null;
      if (r.status !== 200 || typeof pj?.count !== "number") { el.setText(""); return; }
      let msg = t.restorePreview(pj.count, fmtBytes(pj.known_bytes ?? 0));
      const u = pj.unknown_count ?? 0;
      if (u > 0) msg += t.restorePreviewUnknown(u);
      el.setText(msg);
    } catch { el.setText(""); }
  }

  async onOpen() {
    // 바깥(배경) 클릭 닫힘 방지 — 기간·vault를 고르는 중 실수로 닫히지 않게, X·Esc로만 닫는다.
    ((this as unknown as { bgEl?: HTMLElement }).bgEl)?.addEventListener(
      "click", (e) => e.stopImmediatePropagation(), { capture: true });
    const c = this.contentEl;
    c.createEl("h2", { text: t.restoreVaultTitle });
    for (const line of t.restoreVaultDesc.split("\n")) c.createEl("p", { text: line, cls: "nanalstamp-archive-note nanalstamp-restore-line" });
    // 잔여 횟수 — 조회 전용(차감 없음). 실패 시 조용히 생략(실행 시 서버가 최종 집행).
    const quotaBox = c.createDiv();
    void (async () => {
      try {
        const r = await requestUrl({ url: `${this.plugin.base()}/attest/restore/status`, method: "GET", headers: { "x-nanal-api-key": this.plugin.settings.apiKey }, throw: false });
        const sj = r.json as { remaining?: number; limit?: number; credits?: number; next_free_at?: number } | null;
        if (r.status === 200 && typeof sj?.remaining === "number") {
          if (sj.remaining > 0) {
            quotaBox.createEl("p", { text: t.restoreRemaining(sj.remaining), cls: "nanalstamp-archive-note nanalstamp-restore-line" });
          } else if (typeof sj.credits === "number" && sj.credits > 0) {
            quotaBox.createEl("p", { text: t.restoreCredits(sj.credits), cls: "nanalstamp-archive-note nanalstamp-restore-line" });
          } else {
            // 소진 — 두 줄로(고정폭 모달에서 중간 줄바꿈 방지): 한도 상태 / 구매 안내
            const next = typeof sj.next_free_at === "number" ? fmtDate(new Date(sj.next_free_at * 1000)) : "?";
            quotaBox.createEl("p", { text: t.restoreVaultLimit(next), cls: "nanalstamp-restore-line is-error" });
            quotaBox.createEl("p", { text: t.restoreBuySoon, cls: "nanalstamp-restore-line is-error" });
          }
        }
      } catch { /* 생략 */ }
    })();
    // 네이티브 date 입력 — 클릭 시 달력, 빈 상태가 명확(placeholder 오인 방지 — 2026-07-22 사용자 지적).
    new Setting(c).setName(t.restoreVaultFrom).addText((tx) => {
      tx.inputEl.type = "date";
      tx.onChange((v) => { this.fromStr = v.trim(); void this.refreshPreview(); });
    });
    new Setting(c).setName(t.restoreVaultTo).addText((tx) => {
      tx.inputEl.type = "date";
      tx.onChange((v) => { this.toStr = v.trim(); void this.refreshPreview(); });
    });
    // vault 선택 — 서버 distinct 목록(복호 이름). 미상(구 봉인)은 "모든 vault"에 포함.
    const vs = await this.plugin.fetchSealedVaults();
    for (const v of vs) {
      const name = await this.plugin.decryptVaultName(v);
      this.vaults.push({ hash: v.vaultHash, name: name ?? v.vaultHash.slice(0, 8) });
    }
    this.vaults.sort((a, b) => a.name.localeCompare(b.name));
    if (this.vaults.length > 0) {
      new Setting(c).setName("vault").addDropdown((dd) => {
        dd.addOption("", t.browserVaultAll);
        for (const v of this.vaults) dd.addOption(v.hash, v.name);
        dd.onChange((v) => { this.vaultHash = v; void this.refreshPreview(); });
      });
    }
    this.previewEl = c.createEl("p", { cls: "nanalstamp-archive-note nanalstamp-restore-line" });
    // 대상 수는 **봉인 원장** 기준이라 보관본이 없는 구 봉인도 센다 — 실행 후 리포트와 어긋나 보이지
    // 않도록 여기서 미리 말한다(2026-07-28).
    c.createEl("p", { text: t.restorePreviewNote, cls: "nanalstamp-archive-note nanalstamp-restore-line" });
    void this.refreshPreview();
    new Setting(c)
      .addButton((b) => b.setButtonText(t.restoreVaultCancel).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t.restoreVaultStart).setCta().onClick(() => {
      const fromTs = this.parseDay(this.fromStr, false);
      const toTs = this.parseDay(this.toStr, true);
      if (fromTs === null || toTs === null) { new Notice(t.restoreVaultBadDate); return; }
      const label = this.vaultHash ? this.vaults.find((v) => v.hash === this.vaultHash)?.name : undefined;
      this.close();
      void this.plugin.runVaultRestore({ fromTs, toTs, vaultHash: this.vaultHash || undefined, vaultLabel: label });
    }));
  }
  onClose() { this.contentEl.empty(); }
}

// 봉인 버전 이력 모달 — 브라우저 행의 "이력" 버튼. /attest/history로 그 노트의 봉인 버전을 나열,
// 버전을 고르면 그 시점 원문을 S3에서 열람(openNanalView — 시점 일관 임베드까지 그 시각 기준).
export class NanalHistoryModal extends NanalModal {
  constructor(
    app: App,
    private plugin: NanalStampPlugin,
    private notePath: string,   // 복호된 경로(표시·열람용)
    private pathHash: string,
    private isMd: boolean,
  ) { super(app); }

  private rows: HistRow[] = [];
  private hasMore = false;
  private loading = false;

  onOpen() {
    this.contentEl.createEl("h2", { text: t.browserHistoryTitle(basenameOf(this.notePath)) });
    void this.loadPage();
  }
  onClose() { this.contentEl.empty(); }

  private async loadPage(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const before = this.rows.length ? this.rows[this.rows.length - 1].seq : undefined;
      const page = await this.plugin.fetchNoteHistory(this.pathHash, before);
      if (page) { this.rows.push(...page.rows); this.hasMore = page.hasMore; }
      this.render();
    } finally { this.loading = false; }
  }

  private render(): void {
    const c = this.contentEl;
    // 제목 아래를 다시 그림(제목은 유지)
    Array.from(c.children).forEach((el, i) => { if (i > 0) el.remove(); });
    if (!this.rows.length) { c.createEl("p", { text: t.browserHistoryEmpty }); return; }
    const list = c.createDiv();
    for (const v of this.rows) {
      const item = list.createDiv({ cls: "nanalstamp-hist-row" });
      item.createSpan({ text: fmtDateTime(new Date(v.receivedAt * 1000)) });
      item.createSpan({ text: `seq #${v.seq}`, cls: "nanalstamp-hist-seq" });
      item.createSpan({ text: v.block != null ? `₿ ${v.block}` : "…", cls: "nanalstamp-hist-status" });
      item.addEventListener("click", () => {
        this.close();
        void this.plugin.openNanalView(this.notePath, v.fileHash, this.isMd, v.receivedAt);
      });
    }
    if (this.hasMore) {
      const more = c.createEl("button", { text: t.browserMore, cls: "nanal-browser-more" });
      more.addEventListener("click", () => void this.loadPage());
    }
  }
}

// 비밀번호 재설정 모달 — 이메일 입력 → 재설정 메일 요청(웹 /reset?token=…에서 완료).
// 커맨드 팔레트 "비밀번호 재설정"에서 열린다. 로그인 안 된 상태에서도 사용 가능.
export class PasswordResetModal extends NanalModal {
  private email = "";
  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.resetModalTitle });
    contentEl.createEl("p", { text: t.resetDesc, cls: "setting-item-description" });
    new Setting(contentEl)
      .setName(t.emailPlaceholder)
      .addText((tx) => { tx.setPlaceholder(t.emailPlaceholder).onChange((v) => (this.email = v.trim())); (tx.inputEl).type = "email"; });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.resetOpenBtn).onClick(() => this.plugin.openExternal("/reset")))
      .addButton((b) => b.setButtonText(t.resetSendBtn).setCta().onClick(async () => {
        if (!this.email) { new Notice(t.resetNeedEmail); return; }
        try { await this.plugin.accountResetRequest(this.email); new Notice(t.resetSent(this.email)); this.close(); }
        catch (e) { new Notice(t.resetFail(errMsg(e))); }
      }));
  }
  onClose() {
    this.contentEl.empty();
  }
}

// GitHub OAuth Device Flow 연결 모달 — PAT 없이 "연결 클릭 + GitHub 승인 한 번"으로
// 토큰 획득 → 로그인명 조회 → private repo(nanalstamp-vault) 자동 준비 → 미러 on.
// 프리즈 재발 방지: 모든 네트워크·폴링·진행표시는 설정 display()가 아니라 이 모달에서만 처리한다.
export class GitHubConnectModal extends NanalModal {
  private cancelled = false;
  private pollTimer?: number;
  private deviceCode = "";
  private interval = 5;      // 폴링 주기(초). slow_down 시 +5.
  private deadline = 0;      // expires_in 만료 시각(ms)
  private waitEl?: HTMLElement;
  constructor(app: App, private plugin: NanalStampPlugin, private onDone: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    // Client ID 미설정(오너 설정 전) → 안내 후 닫기만 제공
    if (!GITHUB_OAUTH_CLIENT_ID) {
      contentEl.createEl("p", { text: t.ghNoClient, cls: "setting-item-description" });
      new Setting(contentEl).addButton((b) => b.setButtonText(t.ghCloseBtn).setCta().onClick(() => this.close()));
      return;
    }
    void this.start();
  }

  onClose() {
    this.cancelled = true; // 폴링 루프 취소
    if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
    this.contentEl.empty();
  }

  // 취소 가능한 sleep(모달 닫으면 타이머 정리)
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.pollTimer = window.setTimeout(resolve, ms); });
  }

  // ① 디바이스 코드 요청 → 안내 렌더 → 폴링 시작
  private async start() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    contentEl.createEl("p", { text: t.ghRequesting, cls: "setting-item-description" });
    try {
      const res = await requestUrl({
        url: "https://github.com/login/device/code",
        method: "POST",
        headers: { "Accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: `client_id=${encodeURIComponent(GITHUB_OAUTH_CLIENT_ID)}&scope=repo`,
        throw: false,
      });
      if (this.cancelled) return;
      const j = res.json as { device_code?: string; user_code?: string; interval?: number; expires_in?: number; verification_uri?: string } | null;
      if (res.status !== 200 || !j?.device_code || !j?.user_code) {
        this.showRetry(t.ghDeviceFail);
        return;
      }
      this.deviceCode = j.device_code;
      this.interval = Math.max(5, Number(j.interval) || 5);
      this.deadline = Date.now() + (Number(j.expires_in) || 900) * 1000;
      this.renderCode(String(j.user_code), String(j.verification_uri || "https://github.com/login/device"));
      void this.poll();
    } catch (e) {
      if (!this.cancelled) this.showRetry(t.ghErr(errMsg(e)));
    }
  }

  // 코드·GitHub 열기·대기 안내를 단계별로 렌더(동기)
  private renderCode(userCode: string, verifyUri: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    // ① 코드(모노스페이스, 크게) + 자동 클립보드 복사(실패 무시)
    contentEl.createEl("p", { text: t.ghStep1, cls: "setting-item-name" });
    contentEl.createDiv({ text: userCode, cls: "nanalstamp-gh-code" });
    try { void navigator.clipboard.writeText(userCode); } catch { /* ignore */ }
    // ② GitHub 열기
    new Setting(contentEl)
      .setName(t.ghStep2)
      .addButton((b) => b.setButtonText(t.ghStep2Btn).setCta().onClick(() => window.open(verifyUri, "_blank")));
    // ③ 승인 안내 + 진행 표시
    contentEl.createEl("p", { text: t.ghStep3, cls: "setting-item-description" });
    this.waitEl = contentEl.createEl("p", { text: t.ghWaiting, cls: "setting-item-description" });
  }

  // ② interval초마다 토큰 폴링. 모달 닫히면(cancelled) 중단.
  private async poll() {
    while (!this.cancelled) {
      await this.sleep(this.interval * 1000);
      if (this.cancelled) return;
      if (Date.now() > this.deadline) { this.showRetry(t.ghExpired); return; }
      let j: { access_token?: string; error?: string; error_description?: string } | null;
      try {
        const res = await requestUrl({
          url: "https://github.com/login/oauth/access_token",
          method: "POST",
          headers: { "Accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: `client_id=${encodeURIComponent(GITHUB_OAUTH_CLIENT_ID)}&device_code=${encodeURIComponent(this.deviceCode)}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
          throw: false,
        });
        j = res.json as { access_token?: string; error?: string; error_description?: string } | null;
      } catch {
        continue; // 일시적 네트워크 오류 → 다음 주기에 재시도
      }
      if (this.cancelled) return;
      if (j?.access_token) { await this.onToken(String(j.access_token)); return; }
      const err = j?.error;
      if (err === "authorization_pending") continue;
      if (err === "slow_down") { this.interval += 5; continue; }
      if (err === "expired_token") { this.showRetry(t.ghExpired); return; }
      if (err === "access_denied") { this.showRetry(t.ghDenied); return; }
      this.showRetry(t.ghErr(j?.error_description || err || "unknown"));
      return;
    }
  }

  // ③ 토큰 획득 후: 로그인명 조회 → repo 준비 → 미러 on → 저장 → 성공 표시
  private async onToken(token: string) {
    if (this.waitEl) this.waitEl.setText(t.ghPreparing);
    this.plugin.settings.githubPat = token;
    // 로그인명(GET /user)
    let login = "";
    try {
      const u = await requestUrl({
        url: "https://api.github.com/user",
        method: "GET",
        headers: this.ghHeaders(token),
        throw: false,
      });
      login = u.status === 200 ? String((u.json as { login?: string } | null)?.login ?? "") : "";
    } catch { /* ignore */ }
    if (this.cancelled) return;
    if (!login) {
      // 토큰은 저장하되(수동 repo 지정으로 미러 가능) user 조회 실패 안내
      await this.plugin.saveSettings();
      this.showRetry(t.ghUserFail);
      return;
    }
    this.plugin.settings.githubUser = login;
    // repo 자동 준비 — githubRepo가 비었을 때만(사용자가 이미 지정했으면 존중)
    if (!this.plugin.settings.githubRepo.trim()) {
      const ok = await this.ensureRepo(token, login);
      if (this.cancelled) return;
      if (!ok) {
        // 연결은 유지(내보내기 on), repo만 수동 지정 안내
        this.plugin.settings.githubExport = true;
        await this.plugin.saveSettings();
        this.onDone();
        this.showRetry(t.ghRepoFail);
        return;
      }
    }
    // GitHub 연결 완료 — 내보내기(탈출구) 켜기
    this.plugin.settings.githubExport = true;
    await this.plugin.saveSettings();
    this.showSuccess(login, this.plugin.settings.githubRepo);
  }

  private ghHeaders(token: string): Record<string, string> {
    return { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  }

  // nanalstamp-vault 확인(없으면 private·auto_init로 생성). 성공 시 settings.githubRepo 설정.
  private async ensureRepo(token: string, login: string): Promise<boolean> {
    const headers = this.ghHeaders(token);
    const full = `${login}/${GITHUB_DEFAULT_REPO}`;
    try {
      const get = await requestUrl({ url: `https://api.github.com/repos/${full}`, method: "GET", headers, throw: false });
      if (get.status === 200) { this.plugin.settings.githubRepo = full; return true; } // 이미 있음
      if (get.status === 404) {
        const create = await requestUrl({
          url: "https://api.github.com/user/repos",
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: GITHUB_DEFAULT_REPO, private: true, auto_init: true }),
          throw: false,
        });
        if (create.status === 201) { this.plugin.settings.githubRepo = full; return true; }
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  private showSuccess(login: string, repo: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    contentEl.createEl("p", { text: t.ghSuccess(login, repo), cls: "setting-item-name" });
    new Setting(contentEl).addButton((b) => b.setButtonText(t.ghCloseBtn).setCta().onClick(() => this.close()));
    this.onDone(); // 설정 화면을 '연결됨' 상태로 갱신
  }

  // 실패/만료/거부 → 메시지 + 닫기·재시도
  private showRetry(msg: string) {
    if (this.cancelled) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    contentEl.createEl("p", { text: msg, cls: "mod-warning" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.ghCloseBtn).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t.ghRetryBtn).setCta().onClick(() => { this.cancelled = false; void this.start(); }));
  }
}
