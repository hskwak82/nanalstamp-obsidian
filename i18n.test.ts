// i18n.test.ts — 번역 사전(STR·TPL)의 EN/KO 정합. main.ts에서 i18n.ts를 분리하며 신설(2026-07-26).
//
// 왜 필요한가: main.ts는 어떤 테스트도 거치지 않아, 한쪽 언어에만 키를 추가하면
// 반대 언어에서 `t.someKey`가 조용히 undefined가 되고(UI에 "undefined"가 찍힌다) tsc는 잡지 못한다
// — STR의 타입이 en/ko 두 객체의 union이라 어느 한쪽에만 있는 키도 통과하기 때문이다.
// 사전이 독립 모듈이 된 덕에 이제 이 회귀를 고정할 수 있다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STR, TPL, pickLang, setLang, t, tpl, Lang } from "./i18n";

type Dict = Record<string, unknown>;
const en = STR.en as unknown as Dict;
const ko = STR.ko as unknown as Dict;

test("STR: EN/KO 키 집합이 정확히 일치한다", () => {
  const ke = Object.keys(en).sort();
  const kk = Object.keys(ko).sort();
  assert.deepEqual(
    ke.filter((k) => !(k in ko)), [],
    "EN에만 있는 키 — KO 사용자에게 undefined가 노출된다",
  );
  assert.deepEqual(
    kk.filter((k) => !(k in en)), [],
    "KO에만 있는 키 — EN 사용자에게 undefined가 노출된다",
  );
  assert.deepEqual(ke, kk);
  // 분리 시점 실측 662키. 대량 손실(리팩터 사고)을 잡는 하한선이지 정확한 개수 고정이 아니다.
  assert.ok(ke.length >= 600, `사전 키가 비정상적으로 적다(${ke.length}) — 이동 중 손실 의심`);
});

test("STR: 키마다 EN/KO의 종류(문자열 vs 함수)가 같다", () => {
  const bad: string[] = [];
  for (const k of Object.keys(en)) {
    if (typeof en[k] !== typeof ko[k]) bad.push(`${k}: en=${typeof en[k]} ko=${typeof ko[k]}`);
  }
  assert.deepEqual(bad, []);
});

test("STR: 함수형 키의 인자 개수가 EN/KO에서 같다", () => {
  // 호출부는 한 곳인데 한쪽 언어만 인자를 덜 받으면 그 자리에 값이 안 박힌다.
  const bad: string[] = [];
  for (const k of Object.keys(en)) {
    const a = en[k], b = ko[k];
    if (typeof a === "function" && typeof b === "function" && a.length !== b.length) {
      bad.push(`${k}: en=${a.length} ko=${b.length}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("STR: 문자열 값은 비어 있지 않다", () => {
  const bad: string[] = [];
  for (const [lang, d] of [["en", en], ["ko", ko]] as const) {
    for (const k of Object.keys(d)) {
      if (d[k] === "") bad.push(`${lang}.${k}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("STR: 객체·배열 값도 EN/KO 구성이 대응한다", () => {
  // reason·dashWeekdays·taskPriLabel처럼 중첩된 값은 하위 키가 어긋나도 최상위 키 대조로는 안 잡힌다.
  const bad: string[] = [];
  for (const k of Object.keys(en)) {
    const a = en[k], b = ko[k];
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) continue;
    if (Array.isArray(a) !== Array.isArray(b)) { bad.push(`${k}: 배열 여부 불일치`); continue; }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) bad.push(`${k}: 길이 en=${a.length} ko=${b.length}`);
      continue;
    }
    const ka = Object.keys(a as Dict).sort(), kb = Object.keys(b as Dict).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) bad.push(`${k}: 하위 키 en=${ka} ko=${kb}`);
  }
  assert.deepEqual(bad, []);
});

test("TPL: EN/KO의 개발노트 카테고리 키와 필드 구성이 대응한다", () => {
  const ce = Object.keys(TPL.en.cats).sort();
  const ck = Object.keys(TPL.ko.cats).sort();
  assert.deepEqual(ce, ck);
  for (const c of ce) {
    assert.equal(
      TPL.en.cats[c].fields.length, TPL.ko.cats[c].fields.length,
      `${c}: 필드 수가 다르면 entryBlock이 언어별로 다른 서식을 만든다`,
    );
  }
  assert.equal(typeof TPL.en.title, "function");
  assert.equal(typeof TPL.ko.title, "function");
});

test("setLang: t/tpl이 실제로 교체되고 pickLang은 DOM 없이도 en으로 떨어진다", () => {
  // 모듈 최상단 `let t = STR[pickLang()]`이 import만으로 실행되므로 DOM 부재 방어가 전제다.
  assert.equal(pickLang(), "en");

  setLang("ko");
  assert.equal(t.langReload, STR.ko.langReload);
  assert.equal(tpl.title("2026-07-26"), TPL.ko.title("2026-07-26"));

  setLang("en");
  assert.equal(t.langReload, STR.en.langReload);
  assert.equal(tpl.title("2026-07-26"), TPL.en.title("2026-07-26"));

  // auto = 자동 감지(이 환경에선 en)
  setLang("auto");
  const lang: Lang = pickLang();
  assert.equal(t.langReload, STR[lang].langReload);
});

// EN 사전에 한국어가 섞이면 영어 사용자 화면에 그대로 한글이 뜬다. 사람 눈으로는 1,000키 중
// 두어 개를 놓치므로(2026-08-09 실측: statusHold·blobCheck 2건이 그렇게 남아 있었다) 기계로 고정한다.
test("EN 사전 값에 한글이 없다 — en UI에 한국어가 새는 회귀 방지(P-04)", () => {
  const hangul = /[ㄱ-ㆎ가-힣]/;
  // 함수형 키는 toString() 으로 본문까지 본다 — esbuild 번들이 주석을 제거하므로 함수 본문에
  // 한국어 주석이 남아 오탐을 내는 일은 없다는 전제다(주석이 남는 빌드로 바뀌면 이 전제도 깨진다).
  const bad = Object.entries(en).filter(([, v]) => hangul.test(typeof v === "string" ? v : String(v)));
  assert.deepEqual(bad.map(([k]) => k), [], "EN 값에 한글 포함 — 해당 키를 영어로 교체할 것");
});
