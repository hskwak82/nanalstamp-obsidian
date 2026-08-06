// recoverymodal.ts — 보관 누락 상태를 보여주고 복구를 실행한다.
//
// 이 화면이 답해야 할 질문은 하나다: **내 기록 중 원문이 없는 것이 몇 건인가.**
// 봉인은 됐는데 원문이 없으면 점검자도 심사자도 내용을 볼 수 없다 — 증명은 남지만
// 보여줄 것이 없다. 그 사실을 숫자로 먼저 보이고, 고칠 수 있는 만큼 고친다.
//
// 그리고 **고칠 수 없는 것은 고칠 수 없다고 끝맺는다.** 원본이 어디에도 없는 기록을
// 계속 재시도하면 화면은 영원히 도는데 숫자는 그대로다 — 사람은 진행 중인지 망가진
// 것인지 알 수 없다(2026-07-30 사용자 지적). 판정을 확정하고, 무엇을 잃었는지 이름으로 말한다.
import { App, Setting } from "obsidian";
import { NanalModal } from "./modalbase";
import { t } from "./i18n";
import { fmtDateTime } from "./fmtutil";
import type { LostItem } from "./recoverylayer";
import type NanalStampPlugin from "./main";

/// 한 번에 되살릴 상한 — 사람이 직접 눌렀으면 끝까지 간다(자동 감시만 조금씩 나눠 한다).
const MANUAL_LIMIT = 2000;

export class StorageRecoveryModal extends NanalModal {
  private busy = false;

  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app);
  }

  onOpen() { void this.load(); }
  onClose() { this.contentEl.empty(); }

  private async load() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.recTitle });
    const loading = contentEl.createEl("p", { text: t.recLoading, cls: "setting-item-description" });

    const got = await this.plugin.fetchMissing(1);
    loading.remove();
    if (!got) {
      contentEl.createEl("p", { text: t.recLoadFail });
      return;
    }

    contentEl.createEl("p", { text: t.recWhy, cls: "setting-item-description" });
    const box = contentEl.createDiv({ cls: "nanalstamp-pkg-preview" });
    box.createEl("div", { text: t.recStat(got.sealed, got.stored), cls: "setting-item-name" });
    if (got.total > 0) {
      box.createEl("div", { text: t.recMissing(got.total), cls: "nanalstamp-pkg-warn" });
      box.createEl("div", { text: t.recSource, cls: "setting-item-description" });
    } else {
      box.createEl("div", { text: t.recAllStored, cls: "setting-item-description" });
      return;
    }

    const msg = contentEl.createEl("p", { cls: "setting-item-description" });
    const lostBox = contentEl.createDiv();
    const runSetting = new Setting(contentEl).setDesc(t.recBatchDesc);

    this.addBlobCheck(contentEl, msg);
    runSetting.addButton((b) => b.setButtonText(t.recRun).setCta().onClick(async () => {
      if (this.busy) return;
      this.busy = true;
      b.setDisabled(true);
      lostBox.empty();
      const r = await this.plugin.recoverMissing(MANUAL_LIMIT,
        (d, tt) => msg.setText(t.recProgress(d, tt)),
        (d, tt) => msg.setText(t.recScanning(d, tt)));
      // 사람이 직접 눌렀으면 그 결과가 곧 마지막 점검이다 — 주기 감시가 방금 한 일을
      // 또 하지 않게 시각을 갱신한다. 남은 수는 **자동으로 더 할 수 있는 것**만 센다.
      await this.plugin.noteGapChecked(r ? Math.max(0, r.remaining - r.lostList.length) : undefined);
      this.busy = false;
      b.setDisabled(false);
      if (!r) { msg.setText(t.recLoadFail); return; }
      msg.setText(t.recDone(r.restored, r.lostList.length, Math.max(0, r.remaining - r.lostList.length)));
      this.renderLost(lostBox, r.lostList);
    }));
  }

  /// 아카이브 무결성 점검 — blobs/ 는 git 밖이라 `git fsck` 가 봐 주지 않는다.
  /// 파일 이름이 곧 해시이므로 대조하면 손상이 드러난다. 손상된 것은 이름을 밝힌다.
  private addBlobCheck(el: HTMLElement, msg: HTMLElement) {
    new Setting(el)
      .setDesc(t.blobCheckDesc)
      .addButton((b) => b.setButtonText(t.blobCheck).onClick(async () => {
        b.setDisabled(true);
        const r = await this.plugin.verifyArchiveBlobs((d, tt) => msg.setText(t.blobCheckProgress(d, tt)));
        b.setDisabled(false);
        msg.setText(t.blobCheckDone(r.ok, r.bad.length));
      }));
  }

  /// 되살릴 수 없는 것을 **이름으로** 보여준다. 건수만 말하면 무엇을 잃었는지 알 수 없고,
  /// 사람은 그걸 알아야 다른 백업을 뒤질지 포기할지 정할 수 있다.
  private renderLost(el: HTMLElement, lost: LostItem[]) {
    el.empty();
    if (lost.length === 0) return;
    el.createEl("div", { text: t.recLostHead(lost.length), cls: "nanalstamp-pkg-warn" });
    el.createEl("div", { text: t.recLostWhy, cls: "setting-item-description" });
    const list = el.createDiv({ cls: "nanalstamp-pkg-preview" });
    list.style.maxHeight = "220px";
    list.style.overflowY = "auto";
    for (const it of lost) {
      const row = list.createDiv({ cls: "setting-item-description" });
      row.setText(`${it.name ?? t.recLostUnknown(it.seq)} · ${fmtDateTime(new Date(it.at * 1000))}`);
    }
    // 다른 기기에서 동기화됐거나 백업을 되돌렸다면 결과가 달라진다 — 그때만 누르면 된다.
    new Setting(el)
      .setDesc(t.recRetryAllDesc)
      .addButton((b) => b.setButtonText(t.recRetryAll).onClick(async () => {
        await this.plugin.clearUnrecoverable();
        void this.load();
      }));
  }
}
