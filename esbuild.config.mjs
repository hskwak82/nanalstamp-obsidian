import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  charset: "utf8",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
});

// 포털(팀 관리자 화면)도 **같은 조립 로직**을 쓴다.
//
// 팀 제출 자료는 브라우저에서 만든다(관리자는 Obsidian 을 쓰지 않는다). 그때 사슬 검사 파일·
// 처분내역·zip 조립을 포털에 다시 구현하면 규칙이 두 곳이 되고, 언젠가 갈린다 — 처분내역에서
// 이미 겪은 함정이다. packagecore.ts 는 import 가 없는 순수 모듈이라 그대로 실어 쓸 수 있다.
const portalCore = {
  entryPoints: ["packagecore.ts"],
  bundle: true,
  format: "iife",
  globalName: "NPPackageCore",
  target: "es2020",
  platform: "browser",
  charset: "utf8",
  outfile: "../../server/portal/packagecore.js",
  sourcemap: false,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

if (production) {
  await context.rebuild();
  await context.dispose();
  // 포털 사본은 모노레포에서만 — 스토어 미러(공개 repo)에는 server/ 가 없다.
  const { existsSync } = await import("node:fs");
  if (existsSync("../../server/portal")) await esbuild.build(portalCore);
} else {
  await context.watch();
  console.log("[esbuild] watching… (main.ts → main.js)");
}
