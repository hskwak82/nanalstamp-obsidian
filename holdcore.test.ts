import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveLimit, overLimitAttachment, overQuota, sealHold, planThatFits, MB } from "./holdcore";

test("effectiveLimit: 팀 정책과 요금제 중 엄격한 쪽", () => {
  assert.deepEqual(effectiveLimit(200, 50), { limitMB: 50, byTeam: true });
  assert.deepEqual(effectiveLimit(200, 300), { limitMB: 200, byTeam: false });
  assert.deepEqual(effectiveLimit(200, null), { limitMB: 200, byTeam: false });
  assert.deepEqual(effectiveLimit(0, 50), { limitMB: 50, byTeam: true });   // 요금제 무제한 + 팀 제한
  assert.deepEqual(effectiveLimit(0, 0), { limitMB: 0, byTeam: false });    // 둘 다 무제한
});

test("overLimitAttachment: 넘는 것 중 가장 큰 것을 돌려준다", () => {
  const a = [
    { path: "a.png", size: 10 * MB },
    { path: "b.mp4", size: 340 * MB },
    { path: "c.zip", size: 210 * MB },
  ];
  assert.equal(overLimitAttachment(a, 200)?.path, "b.mp4");
  assert.equal(overLimitAttachment(a, 400), null);
  assert.equal(overLimitAttachment(a, 0), null, "상한 0 = 무제한");
});

test("overQuota: 쿼터 0(스토리지 미사용)은 언제나 통과", () => {
  assert.equal(overQuota(0, 0, 999 * MB), false);
  assert.equal(overQuota(9 * MB, 10 * MB, 2 * MB), true);
  assert.equal(overQuota(9 * MB, 10 * MB, 1 * MB), false);   // 딱 맞으면 통과
});

const NOTE = { path: "연구노트/실험.md", size: 4096, isNote: true };

test("sealHold: 첨부 하나가 넘으면 노트 전체가 보류된다", () => {
  const h = sealHold(NOTE, [{ path: "Attachments/영상.mp4", size: 340 * MB }], 200, false, null);
  assert.equal(h?.kind, "attach");
  assert.equal(h && h.kind === "attach" && h.path, "Attachments/영상.mp4");
});

test("sealHold: 상한 이내면 통과", () => {
  assert.equal(sealHold(NOTE, [{ path: "a.png", size: 3 * MB }], 200, false, null), null);
});

test("sealHold: 첨부 없는 노트는 언제나 통과(본문만으로는 상한과 무관)", () => {
  assert.equal(sealHold(NOTE, [], 25, false, null), null);
});

test("sealHold: 첨부 자신을 봉인할 때는 자기 크기로 판정", () => {
  const own = { path: "Attachments/영상.mp4", size: 340 * MB, isNote: false };
  const h = sealHold(own, [], 200, false, null);
  assert.equal(h?.kind, "attach");
  assert.equal(h && h.kind === "attach" && h.path, "Attachments/영상.mp4");
});

test("sealHold: 쿼터를 넘기면 보류 — 다만 스토리지를 쓰는 경우만", () => {
  const big = [{ path: "a.zip", size: 2 * MB }];
  const q = sealHold(NOTE, big, 200, false, { used: 9 * MB, quota: 10 * MB });
  assert.equal(q?.kind, "quota");
  // FREE(쿼터 0) 는 로컬 아카이브만 쓰므로 봉인을 막지 않는다
  assert.equal(sealHold(NOTE, big, 200, false, { used: 9 * MB, quota: 0 }), null);
});

test("sealHold: 첨부 상한이 쿼터보다 먼저 걸린다(고칠 수 있는 것부터 알린다)", () => {
  const h = sealHold(NOTE, [{ path: "big.mp4", size: 340 * MB }], 200, false, { used: 0, quota: 1 * MB });
  assert.equal(h?.kind, "attach");
});

const PLANS = [
  { code: "free", name: "Free", attachment_max_mb: 25, amount_krw: 0 },
  { code: "pro_lite_yearly", name: "Lite 연간", attachment_max_mb: 100, amount_krw: 9900 },
  { code: "pro_yearly", name: "Pro 연간", attachment_max_mb: 200, amount_krw: 29000 },
  { code: "pro_max_yearly", name: "Max 연간", attachment_max_mb: 300, amount_krw: 49000 },
];

test("planThatFits: 담을 수 있는 가장 싼 요금제", () => {
  assert.equal(planThatFits(PLANS, 250 * MB, 100)?.code, "pro_max_yearly");
  assert.equal(planThatFits(PLANS, 150 * MB, 100)?.code, "pro_yearly");
  assert.equal(planThatFits(PLANS, 60 * MB, 25)?.code, "pro_lite_yearly");
});

test("planThatFits: 상위 요금제로도 안 되면 null — 그 사실을 말해야 한다", () => {
  assert.equal(planThatFits(PLANS, 900 * MB, 100), null);
});

test("planThatFits: 이미 최상위면 null(더 올릴 곳이 없다)", () => {
  assert.equal(planThatFits(PLANS, 250 * MB, 300), null);
});
