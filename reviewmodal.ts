// reviewmodal.ts — 내 점검 요청이 어떻게 됐는지 보는 화면.
//
// 왜 필요한가: 요청자는 점검함(웹)에 들어갈 권한이 없다. 지금까지는 요청하면 그걸로 끝이라
// 승인됐는지 반려됐는지 알 방법이 아예 없었다(2026-07-29 지적). 메일이 가긴 하지만,
// **고칠 노트를 열고 있는 자리**에서 바로 보이는 게 맞다.
import { App, Setting } from "obsidian";
import { NanalModal } from "./modalbase";
import { t } from "./i18n";
import type NanalStampPlugin from "./main";

export class ReviewResultModal extends NanalModal {
  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.reviewResultTitle });

    const items = this.plugin.reviewRejectedItems;
    if (!items.length) {
      contentEl.createEl("p", { text: t.reviewNoRejected, cls: "setting-item-description" });
      return;
    }

    contentEl.createEl("p", { text: t.reviewRejectedDesc(items.length) });
    for (const it of items) {
      const box = contentEl.createDiv({ cls: "nanalstamp-pkg-preview" });
      box.createEl("div", {
        text: it.title ? `${it.title} · ${it.seq}번 기록` : `${it.seq}번 기록`,
        cls: "setting-item-name",
      });
      // 사유는 점검자가 쓴 글이다 — 줄바꿈을 살려 그대로 보여준다.
      const p = box.createEl("div", { cls: "nanalstamp-review-comment" });
      p.setText(it.comment || t.reviewNoComment);
    }

    new Setting(contentEl)
      .setDesc(t.reviewFixHint)
      .addButton((b) => b.setButtonText(t.reviewOpenWeb).onClick(() => {
        this.close();
        this.plugin.openExternal("/review");
      }));
  }

  onClose() { this.contentEl.empty(); }
}

/// 점검 요청 — **무엇을 언제까지** 점검해 달라고 할지 고른다.
///
/// 노트 하나씩 요청하면 한 달에 100건이 쌓이고 점검자가 감당하지 못한다(2026-07-29).
/// 그래서 기간·과제로 묶어 한 번에 낸다. 이미 승인받은 기록은 서버가 알아서 뺀다 —
/// 사용자가 "무엇이 이미 점검됐는지" 기억하고 있을 필요가 없어야 한다.
export class ReviewRequestModal extends NanalModal {
  private days = 7;
  private projectId = "";
  private title = "";
  private note = "";
  private busy = false;

  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.reviewReqTitle });
    contentEl.createEl("p", { text: t.reviewReqDesc, cls: "setting-item-description" });

    new Setting(contentEl)
      .setName(t.reviewReqPeriod)
      .setDesc(t.reviewReqPeriodDesc)
      .addDropdown((dd) => {
        dd.addOption("7", t.reviewReqWeek);
        dd.addOption("30", t.reviewReqMonth);
        dd.addOption("90", t.reviewReqQuarter);
        dd.addOption("3650", t.reviewReqAll);
        dd.setValue(String(this.days));
        dd.onChange((v) => { this.days = Number(v); });
      });

    // 과제 범위 — 팀 과제가 있을 때만 보여준다(없는 선택지를 늘어놓지 않는다).
    const projects = this.plugin.teamProjects || [];
    if (projects.length) {
      new Setting(contentEl)
        .setName(t.reviewReqScope)
        .setDesc(t.reviewReqScopeDesc)
        .addDropdown((dd) => {
          dd.addOption("", t.reviewReqScopeAll);
          for (const p of projects) dd.addOption(p.id, p.name);
          dd.onChange((v) => { this.projectId = v; });
        });
    }

    new Setting(contentEl)
      .setName(t.reviewReqName)
      .setDesc(t.reviewReqNameDesc)
      .addText((tx) => tx.setPlaceholder(t.reviewReqNamePh).onChange((v) => { this.title = v; }));

    new Setting(contentEl)
      .setName(t.reviewReqNote)
      .addTextArea((ta) => ta.setPlaceholder(t.reviewReqNotePh).onChange((v) => { this.note = v; }));

    const msg = contentEl.createEl("p", { cls: "setting-item-description" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.reviewReqSend).setCta().onClick(async () => {
        if (this.busy) return;
        this.busy = true;
        msg.setText(t.reviewReqSending);
        const r = await this.plugin.sendReviewRequest(
          this.days, this.projectId || undefined, this.title, this.note);
        this.busy = false;
        if (r.ok) {
          msg.setText(t.reviewReqOk(r.count ?? 0));
          window.setTimeout(() => this.close(), 1400);
        } else {
          msg.setText(r.message || t.reviewReqFail);
        }
      }));
  }

  onClose() { this.contentEl.empty(); }
}
