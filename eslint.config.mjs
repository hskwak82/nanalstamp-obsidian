// 스토어 자동 심사(obsidianmd 스캔) 자가 검증 전용 설정. 제품 빌드와 무관하다 —
// esbuild 는 이 파일을 보지 않는다. error 2규칙 = 심사 탈락 사유, warn = Scorecard 경고 미러.
import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    files: ["*.ts"],
    // 테스트 파일은 tsconfig 의 project 에 없어 타입 정보가 안 잡힌다 — 심사 대상도 아니다.
    ignores: ["main.js", "node_modules/**", ".testbuild/**", "*.test.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: "module",
      // no-unsupported-api 는 타입 정보를 요구한다(어느 클래스의 메서드인지 알아야 판정 가능).
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: {
      obsidianmd: obsidianmd.default ?? obsidianmd,
      "@typescript-eslint": tseslint,
    },
    rules: {
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/no-unsupported-api": "error",
      "obsidianmd/prefer-create-el": "warn",
      "obsidianmd/no-global-this": "warn",
      "obsidianmd/prefer-get-language": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^$" }],
    },
  },
];
