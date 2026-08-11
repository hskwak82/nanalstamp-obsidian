// packagemodal.ts — 제출 패키지 만들기 화면.
//
// 이 화면이 하는 말은 두 가지뿐이다: **무엇이 들어가는가**, 그리고 **무엇이 빠지는가.**
// 빠지는 것을 감추면 제출자가 그걸 모른 채 자료를 내보내고, 심사자 화면에서 처음 알게 된다.
import { App, Notice, Setting, TFolder } from "obsidian";
import { NanalModal } from "./modalbase";
import { t } from "./i18n";
import { fmtBytes } from "./storagecore";
import type NanalStampPlugin from "./main";
import { endOfDayEpoch, OriginSource } from "./packagecore";
import type { PackageData } from "./packagecore";
import { SubscriptionRequired } from "./packagelayer";
import type { PackagePlan } from "./packagelayer";

export class SubmissionPackageModal extends NanalModal {
  private data: PackageData | null = null;
  /// 이번에 낼 사슬(0020). 팀 폴더를 쓰면 팀 자료가 기본 — 팀원이 만드는 자료는 대개 그것이다.
  private chain: "team" | "solo" = "solo";
  private plan: PackagePlan | null = null;
  private folder = "";
  private label = "";
  private busy = false;
  private dropped = 0;
  private verified = false;   // 앵커를 공개 원장과 대조했는가
  private mode: "now" | "date" = "now";
  private atDate = "";                    // YYYY-MM-DD
  private source: OriginSource = "auto";
  /// 발급자가 담지 않기로 한 순번. **기본은 비어 있다** — 증빙의 목적은 완전성이고,
  /// 빼는 것은 의식적인 선택이어야지 모르고 빠지는 일이 없어야 한다.
  private exclude = new Set<number>();
  /// 변경 이력 표를 담을 것인가. 원문과 **따로** 묻는다 — 원문을 빼 놓고 이력에 이름이 나오면
  /// 제목만으로도 불리할 수 있어, 빼는 의미가 사라진다.
  private withTimeline = true;

  /// 차감 확인을 이미 받았는가. 한 번 확인하면 이 창을 닫을 때까지 다시 묻지 않는다 —
  /// 같은 조작을 두 번 묻는 것은 확인이 아니라 성가심이다.
  private creditConfirmed = false;

  /// `free` — 구독자가 아니라 **크레딧으로 만드는 사람**이다. 차감 사실을 화면에 계속 적고,
  ///          '만들기' 앞에 확인을 세운다.
  /// `noCredit` — 크레딧이 0인 걸 이미 아는 상태. 서버를 부르지 않고 바로 구매 안내로 간다.
  /// `credits` — 지금 남은 크레딧(확인 화면에 적는다). 정확한 값은 서버가 갖고 있고 이건
  ///          마지막으로 받아 둔 값이라, 없으면(0) 그 줄을 아예 적지 않는다.
  constructor(
    app: App, private plugin: NanalStampPlugin,
    private free = false, private noCredit = false, private credits = 0,
  ) {
    super(app);
    this.label = plugin.teamRoot() || t.pkgDefaultLabel;
  }

  onOpen() {
    this.modalEl.addClass("nanalstamp-package-modal");
    // 팀 폴더를 쓰면 팀 자료가 기본이다 — 팀원이 내는 것은 대개 그쪽이고, 개인 기록은
    // 위 전환 링크로 따로 만든다.
    if (this.plugin.teamRoot()) this.chain = "team";
    // 크레딧이 없는 걸 이미 아는 상태면 서버를 부르지 않는다 — 기다릴 이유가 없다.
    if (this.noCredit) { this.renderSubscribe(); return; }
    void this.load();
  }

  onClose() { this.contentEl.empty(); }

  private async load() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pkgTitle });
    const loading = contentEl.createEl("p", { text: t.pkgLoading, cls: "setting-item-description" });
    try {
      // 사슬만 받고 바로 화면을 띄운다. **앵커 대조(공개 원장 왕복)는 여기서 하지 않는다** —
      // 그것 때문에 창이 뜨기까지 한참 걸렸다(2026-07-29 지적). 대조는 '정보 보기'에서 한다.
      // 사슬이 팀·개인으로 갈려 있다(0020). 한 번에 한쪽만 담는다 — 섞으면 고리가 끊긴다.
      // 팀 폴더를 쓰는 사람은 팀 자료가 기본이고, 개인 자료는 아래에서 바꿔 만든다.
      this.data = await this.plugin.fetchPackageData(this.chain);
    } catch (e) {
      loading.remove();
      if (e instanceof SubscriptionRequired) { this.renderSubscribe(e.checkoutUrl); return; }
      contentEl.createEl("p", { text: t.pkgLoadFail(String((e as Error)?.message ?? e)) });
      return;
    }
    loading.remove();
    this.render();
  }

  /// 크레딧이 없을 때의 안내 — **막고 끝내지 않는다.** 왜 유료인지 한 줄로 말하고,
  /// **그 자리에서 살 수 있게** 한다.
  ///
  /// 예전에는 요금제 페이지로 보내는 버튼 하나뿐이었다(구독 전용이던 시절). 이제 FREE 도
  /// 건당으로 만들 수 있으므로, 요금제로만 보내면 사용자는 "한 번만 내면 되는 길"을 스스로
  /// 찾아야 한다. 건당 구매를 먼저 두고, 구독은 그 옆에 둔다.
  private renderSubscribe(url?: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pkgSubTitle });
    contentEl.createEl("p", { text: t.pkgSubWhy });
    const box = contentEl.createDiv({ cls: "nanalstamp-pkg-preview" });
    box.createDiv({ text: t.pkgSubFreeHas, cls: "setting-item-name" });
    box.createDiv({ text: t.pkgSubFreeDesc, cls: "setting-item-description" });
    contentEl.createEl("p", { text: t.pkgSubHow, cls: "setting-item-description" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.pkgSubBuy).setCta().onClick(() => {
        this.close();
        void this.plugin.startCheckout("cert_single");
      }))
      .addButton((b) => b.setButtonText(t.pkgSubCta).onClick(() => {
        this.close();
        if (url) window.open(url, "_blank"); else this.plugin.openExternal("/pricing");
      }));
  }

  private render() {
    const { contentEl } = this;
    const d = this.data;
    if (!d) return;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pkgTitle });

    // 어느 범위를 내는지 **먼저** 말한다. 팀 자료와 개인 기록은 사슬이 달라 한 자료에 함께
    // 담기지 않는다 — 그 사실을 모르면 "왜 노트가 빠졌지"가 된다.
    if (this.plugin.teamRoot()) {
      const bar = contentEl.createEl("p", { cls: "setting-item-description" });
      bar.setText(this.chain === "team" ? t.pkgScopeTeam : t.pkgScopeSolo);
      const sw = bar.createEl("a", { text: " " + (this.chain === "team" ? t.pkgScopeToSolo : t.pkgScopeToTeam) });
      sw.setAttr("href", "#");
      sw.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.chain = this.chain === "team" ? "solo" : "team";
        void this.load();
      });
    }

    // 확정 앵커가 없으면 만들 수 없다. **앵커 대기분은 패키지에 넣지 않는다** —
    // 서버 서명만 있는 기록은 "발급사가 그렇다고 한다"는 뜻이라 제3자에게 증명력이 약하다.
    if (!d.anchors.length) {
      contentEl.createEl("p", { text: t.pkgNoAnchor });
      contentEl.createEl("p", { text: t.pkgNoAnchorWhy, cls: "setting-item-description" });
      new Setting(contentEl)
        .addButton((b) => b.setButtonText(t.pkgAnchorNow).setCta().onClick(() => {
          this.close();
          void this.plugin.anchorNow();
        }));
      return;
    }

    const last = d.anchors[0];
    contentEl.createEl("p", { text: t.pkgCoverage(d.covered_to, last.block_height) });
    if (this.dropped) {
      // 뺀 이유를 숨기지 않는다 — 왜 범위가 줄었는지 사용자가 알아야 한다.
      contentEl.createEl("p", { text: t.pkgAnchorDropped(this.dropped), cls: "nanalstamp-pkg-warn" });
    }
    if (d.pending_from !== null) {
      contentEl.createEl("p", {
        text: t.pkgPendingWarn(d.last_seq - d.pending_from + 1),
        cls: "setting-item-description",
      });
    }

    // 언제 기준인가 — 연구노트 제출은 대개 과제 기간 단위라 "그날 기준"이 필요하다.
    new Setting(contentEl)
      .setName(t.pkgModeName)
      .setDesc(t.pkgModeDesc)
      .addDropdown((dd) => {
        dd.addOption("now", t.pkgModeNow);
        dd.addOption("date", t.pkgModeDate);
        dd.setValue(this.mode);
        dd.onChange((v) => { this.mode = v as "now" | "date"; this.plan = null; this.render(); });
      });

    if (this.mode === "date") {
      new Setting(contentEl)
        .setName(t.pkgDateName)
        .setDesc(t.pkgDateDesc)
        .addText((tx) => {
          tx.inputEl.type = "date";
          tx.setValue(this.atDate || new Date().toISOString().slice(0, 10));
          this.atDate = tx.getValue();
          tx.onChange((v) => { this.atDate = v; this.plan = null; });
        });

      // 원본을 어디서 가져올 것인가. **기기는 잃어버릴 수 있다** — nanalStorage 가 있는
      // 이유가 그것이라, 기본은 기기 우선이되 없으면 자동으로 nanalStorage 로 넘어간다.
      new Setting(contentEl)
        .setName(t.pkgSourceName)
        .setDesc(t.pkgSourceDesc)
        .addDropdown((dd) => {
          dd.addOption("auto", t.pkgSourceAuto);
          dd.addOption("device", t.pkgSourceDevice);
          dd.addOption("storage", t.pkgSourceStorage);
          dd.setValue(this.source);
          dd.onChange((v) => { this.source = v as OriginSource; this.plan = null; this.render(); });
        });
    }

    // 범위 — 기본은 vault 전체. 봉인 범위 폴더가 있으면 후보로 올린다.
    const folders = this.folderCandidates();
    new Setting(contentEl)
      .setName(t.pkgScopeName)
      .setDesc(t.pkgScopeDesc)
      .addDropdown((dd) => {
        dd.addOption("", t.pkgScopeAll);
        // 노트 하나만 보내고 싶을 때 — 예전 '증명 번들 내보내기'가 하던 일이다.
        const active = this.app.workspace.getActiveFile();
        if (active) dd.addOption(active.path, t.pkgScopeThisNote(active.basename));
        for (const f of folders) dd.addOption(f, f);
        dd.setValue(this.folder);
        dd.onChange((v) => { this.folder = v; this.plan = null; this.render(); });
      });

    new Setting(contentEl)
      .setName(t.pkgLabelName)
      .setDesc(t.pkgLabelDesc)
      .addText((tx) => tx.setValue(this.label).onChange((v) => { this.label = v; }));

    // 미리보기 — 무엇이 들어가고 무엇이 빠지는지. 버튼을 상자 바로 위에 둬서
    // "이 상자를 채우는 버튼"임이 드러나게 한다.
    const check = new Setting(contentEl).setName(t.pkgCheckName).setDesc(t.pkgCheckDesc);
    const box = contentEl.createDiv({ cls: "nanalstamp-pkg-preview" });
    check.addButton((b) => b.setButtonText(t.pkgCheck).setDisabled(this.busy)
      .onClick(() => void this.doPlan(box)));
    if (this.plan) this.renderPreview(box, this.plan);
    else box.createEl("p", { text: t.pkgPreviewHint, cls: "setting-item-description" });

    // 값이 얼마인지는 **누르기 전에** 보여야 한다. 확인 화면은 누른 뒤에 뜨므로, 그 전에도
    // 알 수 있도록 돈이 나가는 버튼 바로 위에 한 줄 적는다.
    if (this.free) contentEl.createEl("p", { text: t.pkgCreditNotice, cls: "setting-item-description" });

    // '만들기'만 하단에 둔다 — 두 버튼이 나란히 있으면 어느 것이 실행인지 헷갈린다.
    new Setting(contentEl)
      .addButton((b) => b
        .setButtonText(t.pkgBuild).setCta()
        .setDisabled(!this.plan || this.plan.files.length === 0 || this.busy)
        .onClick(() => void this.doBuild()));
  }

  /// **봉인 범위 안의** 폴더만 고를 수 있게 한다(2026-07-29 지적).
  ///
  /// vault 최상위를 전부 늘어놓으면 봉인되지 않은 폴더가 대부분이고, 그걸 고르면 "담길
  /// 파일이 없습니다"만 나온다. 고를 수 없는 것을 보여주지 않는 것이 목록의 일이다.
  ///
  /// 하위 폴더까지 넣는 이유: 제출 범위를 좁히려면 루트만으로는 부족하다("팀루트/과제A"처럼).
  /// 깊이는 3단까지 — 그 아래는 목록이 길어져 오히려 고르기 어렵다.
  private folderCandidates(): string[] {
    const out = new Set<string>();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder) || f.path === "/") continue;
      if (f.path.split("/").length > 3) continue;
      if (!this.plugin.inPackageScope(f.path)) continue;
      out.add(f.path);
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  private async doPlan(box: HTMLElement) {
    if (!this.data || this.busy) return;
    this.busy = true;
    box.empty();
    const p = box.createEl("p", { text: t.pkgVerifying, cls: "setting-item-description" });
    let needCredit = false;
    try {
      // 앵커를 공개 원장과 먼저 대조한다 — 통과하지 못할 증거는 담지 않는다.
      // 한 번 대조했으면 다시 하지 않는다(폴더만 바꿔 다시 볼 때 기다리지 않도록).
      if (!this.verified) {
        const { data, dropped } = await this.plugin.verifyAnchors(this.data);
        this.data = data;
        this.dropped = dropped.length;
        this.verified = true;
      }
      const prog = (done: number, total: number) => { p.setText(t.pkgScanning(done, total)); };
      this.plan = this.mode === "date"
        ? await this.plugin.planPackageAt(this.folder, this.data, endOfDayEpoch(this.atDate), this.source, prog, this.exclude)
        : await this.plugin.planPackage(this.folder, this.data, prog);
      box.empty();
      this.renderPreview(box, this.plan);
    } catch (e) {
      // 크레딧이 떨어졌으면 오류가 아니라 **다음 행동**이다(402). 여기서 바로 살 수 있게 한다.
      // needCredit 을 세우는 이유: finally 의 render() 가 방금 그린 구매 안내를 덮어쓴다.
      if (e instanceof SubscriptionRequired) { needCredit = true; this.renderSubscribe(e.checkoutUrl); }
      else {
        box.empty();
        box.createEl("p", { text: t.pkgLoadFail(String((e as Error)?.message ?? e)) });
      }
    } finally {
      this.busy = false;
      if (!needCredit) this.render();
    }
  }

  private renderPreview(box: HTMLElement, plan: PackagePlan) {
    box.empty();
    const bytes = plan.files.reduce((a, f) => a + f.data.length, 0);
    box.createDiv({ text: t.pkgIncluded(plan.files.length, fmtBytes(bytes)), cls: "setting-item-name" });

    if (plan.origins) {
      const o = plan.origins;
      box.createDiv({ text: t.pkgOriginBreak(o.device, o.storage), cls: "setting-item-description" });
      if (plan.lost) box.createDiv({ text: t.pkgOriginLost(plan.lost), cls: "nanalstamp-pkg-warn" });
    }

    // 빠지는 것을 **반드시** 보여 준다. 이유가 다르면 사용자가 할 일도 다르다.
    if (plan.pending.length) {
      box.createDiv({ text: t.pkgExclPending(plan.pending.length), cls: "nanalstamp-pkg-warn" });
      this.fileList(box, plan.pending);
    }
    if (plan.unsealed.length) {
      box.createDiv({ text: t.pkgExclUnsealed(plan.unsealed.length), cls: "setting-item-description" });
      this.fileList(box, plan.unsealed);
    }
    if (!plan.files.length) box.createDiv({ text: t.pkgNothing, cls: "nanalstamp-pkg-warn" });

    // ── 무엇을 담을지는 발급자가 고른다 ──────────────────────────────────
    // 증거를 전부 낼 의무는 없다. 다만 **낸 것이 전부인 척하면 안 된다** — 빼기로 한 것은
    // 「제외함」으로 처분내역에 남고, 봉인 사실 자체는 사슬에 그대로 있다.
    this.renderChoices(box, plan);
  }

  /// 지금 기기에 없는 것만 묻는다. 지금 있는 노트는 물을 이유가 없다.
  private renderChoices(box: HTMLElement, plan: PackagePlan) {
    const gone = plan.files.filter((f) => !this.app.vault.getAbstractFileByPath(f.vaultPath));
    const wrap = box.createDiv({ cls: "nanalstamp-pkg-choices" });
    if (gone.length) {
      wrap.createDiv({ text: t.pkgPickTitle(gone.length), cls: "setting-item-name" });
      wrap.createDiv({ text: t.pkgPickDesc, cls: "setting-item-description" });
      for (const f of gone.slice(0, 30)) {
        const row = wrap.createDiv({ cls: "nanalstamp-pkg-choice" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = !this.exclude.has(f.seq);
        cb.onchange = () => {
          if (cb.checked) this.exclude.delete(f.seq); else this.exclude.add(f.seq);
          this.plan = null;   // 다시 계획해야 처분내역이 맞는다
        };
        row.createSpan({ text: `${f.vaultPath}` });
      }
      if (gone.length > 30) wrap.createDiv({ text: t.pkgMore(gone.length - 30), cls: "setting-item-description" });
      if (this.exclude.size) {
        wrap.createDiv({ text: t.pkgPickExcluded(this.exclude.size), cls: "nanalstamp-pkg-warn" });
      }
    }
    // 변경 이력은 원문과 **따로** 고른다.
    new Setting(wrap)
      .setName(t.pkgTimelineName)
      .setDesc(t.pkgTimelineDesc)
      .addToggle((tg) => tg.setValue(this.withTimeline).onChange((v) => { this.withTimeline = v; }));
  }

  /// 목록이 길면 앞의 몇 개만 — 전부 늘어놓으면 정작 요약이 안 보인다.
  private fileList(box: HTMLElement, paths: string[]) {
    const ul = box.createEl("ul", { cls: "nanalstamp-pkg-files" });
    for (const p of paths.slice(0, 8)) ul.createEl("li", { text: p });
    if (paths.length > 8) ul.createEl("li", { text: t.pkgMore(paths.length - 8) });
  }

  /// 차감 확인 — **돈이 나가는 조작**이라 누르기 전에 묻는다.
  ///
  /// 별도 창을 띄우지 않고 이 창 안에서 묻는다: 모달 위에 모달을 쌓으면 어느 창이 답을
  /// 기다리는지 흐려지고(창이 여럿이면 포커스된 창에 뜬다), 자동화도 오진한다.
  private renderCreditConfirm() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pkgCreditTitle });
    contentEl.createEl("p", { text: t.pkgCreditBody });
    if (this.credits > 0) {
      contentEl.createEl("p", { text: t.pkgCreditRemain(this.credits), cls: "setting-item-description" });
    }
    contentEl.createEl("p", { text: t.pkgCreditAgain, cls: "setting-item-description" });
    // 취소를 먼저 둔다 — 기본이 "하지 않음"이어야 한다(ConfirmModal 과 같은 배치).
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.confirmCancel).onClick(() => this.render()))
      .addButton((b) => b.setButtonText(t.pkgCreditGo).setCta().onClick(() => {
        this.creditConfirmed = true;
        void this.doBuild();
      }));
  }

  private async doBuild() {
    if (!this.plan || this.busy) return;
    // 서버는 zip 을 조립하는 순간(요약 PDF)에 1건을 깎는다. 묻는 자리도 같아야 한다.
    if (this.free && !this.creditConfirmed) { this.renderCreditConfirm(); return; }
    this.busy = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pkgTitle });
    const prog = contentEl.createEl("p", { text: t.pkgBuilding });
    try {
      const { path, missing } = await this.plugin.writePackage(
        this.plan, this.label, this.mode === "date" ? this.atDate : undefined,
        (s) => prog.setText(`${t.pkgBuilding} — ${s}`), this.withTimeline);
      // 크레딧이 하나 줄었다 — 캐시한 값을 그대로 두면 설정 화면과 다음 확인 안내가
      // 이전 개수를 말한다. 서버에서 다시 받아 맞춘다(실패해도 만든 자료에는 영향 없다).
      if (this.free) void this.plugin.refreshEntitlement();
      contentEl.empty();
      contentEl.createEl("h2", { text: t.pkgDoneTitle });
      contentEl.createEl("p", { text: path, cls: "setting-item-name" });
      contentEl.createEl("p", { text: t.pkgDoneHow, cls: "setting-item-description" });
      if (missing.length) {
        contentEl.createEl("p", { text: t.pkgAssetsMissing, cls: "nanalstamp-pkg-warn" });
      }
      new Setting(contentEl)
        .addButton((b) => b.setButtonText(t.pkgReveal).setCta().onClick(() => this.plugin.revealPackage(path)))
        .addButton((b) => b.setButtonText(t.pkgOpenCheck).onClick(() => this.plugin.openExternal("/check")));
    } catch (e) {
      // 만드는 도중에 크레딧이 모자란 것으로 판명되면(402) 그것은 고장이 아니다 —
      // "서버 응답 402" 를 보여 주면 사용자는 고칠 수 없는 오류로 읽는다.
      if (e instanceof SubscriptionRequired) { this.renderSubscribe(e.checkoutUrl); return; }
      contentEl.empty();
      contentEl.createEl("h2", { text: t.pkgTitle });
      contentEl.createEl("p", { text: t.pkgBuildFail(String((e as Error)?.message ?? e)) });
      new Notice(t.pkgBuildFail(String((e as Error)?.message ?? e)));
    } finally {
      this.busy = false;
    }
  }
}
