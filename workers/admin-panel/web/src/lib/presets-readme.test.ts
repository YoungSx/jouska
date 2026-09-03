/**
 * 这个测试是仓库里唯一需要 node API 的浏览器侧文件（读宿主上的 README 做漂移
 * 守卫）。node 类型用 triple-slash 局部引入，不放宽整个 app 的 types。
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIMING_PRESETS } from '@jouska/timing-presets';

/**
 * README 漂移守卫。README 是手写 JSON 用户拿到预设数字的地方，TIMING_PRESETS
 * 是面板按钮的数字来源 —— 两份说的是同一组数。这条测试从常量反推出 README 表格
 * 应有的单元格文本，任何一边改了数字、另一边没跟上，这里当场报错。
 *
 * 放在 web 这边而不是库那边，是因为库的测试跑在 workerd 池里读不到宿主文件，
 * 而这里的 jsdom 能读；且别名 import 保证测的就是面板实际引的那份常量。
 */

/** `90000` → `90_000`，README 表格写数字的格式。 */
const withSeparators = (value: number): string => value.toLocaleString('en-US').replace(/,/g, '_');

describe('README 预设表', () => {
  it('和 TIMING_PRESETS 是同一组数字', () => {
    // 本文件在 web/src/lib 下，到仓库根要向上五层。
    const readme = readFileSync(
      path.resolve(import.meta.dirname, '../../../../../README.md'),
      'utf8',
    );
    for (const [name, preset] of Object.entries(TIMING_PRESETS)) {
      // README 单元格是一个代码跨度：`timeoutMs: 90_000, retries: 1`。
      const cell = Object.entries(preset)
        .map(([field, value]) => `${field}: ${withSeparators(value)}`)
        .join(', ');
      expect(readme, `预设 \`${name}\` 的 Fields 列`).toContain(`\`${cell}\``);
      expect(readme, `预设 \`${name}\` 的 Fields 列`).toContain(cell);
    }
  });
});
