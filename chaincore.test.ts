// 봉인 응답 검증 테스트 — 실행: npm test
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { entryPreimage, verifySealAck, CHAIN_ZERO } from "./chaincore";

const sha = async (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const UID = "u-1";

async function ack(over: Record<string, unknown> = {}) {
  const base = { seq: 3, file_hash: "a".repeat(64), path: "b".repeat(64),
                 prev_hash: "c".repeat(64), received_at: 1700000000 };
  const merged = { ...base, ...over } as any;
  merged.entry_hash = merged.entry_hash ?? await sha(entryPreimage(
    UID, merged.seq, merged.prev_hash, merged.file_hash, merged.path, merged.received_at));
  return merged;
}

test("정상 응답은 통과한다", async () => {
  const a = await ack();
  assert.deepStrictEqual(await verifySealAck(a, a.file_hash, UID, sha), { ok: true });
});

test("내가 보낸 해시와 다르면 실패 — 남의 기록을 내 것이라 할 수 없다", async () => {
  const a = await ack();
  assert.deepStrictEqual(await verifySealAck(a, "d".repeat(64), UID, sha),
    { ok: false, why: "sent-mismatch" });
});

test("고리가 그 내용으로 계산되지 않으면 실패 — 한 조각만 달라도 잡힌다", async () => {
  for (const over of [{ seq: 4 }, { path: "e".repeat(64) }, { prev_hash: "f".repeat(64) },
                      { received_at: 1700000001 }]) {
    const a = await ack();
    Object.assign(a, over);                       // entry_hash 는 그대로 두고 한 조각만 바꾼다
    const v = await verifySealAck(a, a.file_hash, UID, sha);
    assert.deepStrictEqual(v, { ok: false, why: "link-mismatch" }, JSON.stringify(over));
  }
});

test("계정 id 를 모르면 확인 불가 — 실패로 만들지 않는다", async () => {
  const a = await ack();
  assert.deepStrictEqual(await verifySealAck(a, a.file_hash, undefined, sha), { ok: null });
});

test("구서버가 필드를 안 주면 확인 불가 — 봉인을 되돌리지 않는다", async () => {
  const a = await ack();
  for (const k of ["entry_hash", "file_hash", "prev_hash", "path", "seq", "received_at"]) {
    const partial = { ...a }; delete (partial as any)[k];
    assert.deepStrictEqual(await verifySealAck(partial, a.file_hash, UID, sha), { ok: null }, k);
  }
});

test("첫 고리(prev=0)도 정상 검증된다", async () => {
  const a = await ack({ seq: 0, prev_hash: CHAIN_ZERO });
  assert.deepStrictEqual(await verifySealAck(a, a.file_hash, UID, sha), { ok: true });
});

test("계산식은 파이프로 이은 여섯 조각 — 순서가 곧 포맷이다", () => {
  assert.strictEqual(entryPreimage("u", 1, "p", "f", "x", 9), "u|1|p|f|x|9");
});
