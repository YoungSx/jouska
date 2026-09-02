// jsdom 环境 + RTL：显式注册 cleanup（vitest 默认不开 globals，RTL 无法自动注册），
// 否则上一个用例的 DOM 会漏进下一个，查询就会撞出"重复元素"。
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

/*
 * jsdom 缺的两个浏览器 API，补成最小可用的形状。
 *
 * 两个都是应用外壳（App + ThemeProvider）挂载时就会碰到的：ThemeProvider 读
 * prefers-color-scheme 决定 system 主题解析成什么，头部导航等字体加载完再量一次
 * 溢出（Geist 是变量字体，加载前后 Tab 宽度不一样）。缺了它们，effect 里会抛
 * TypeError，而渲染期抛出的异常会让 React 卸载整棵树 —— 测试拿到一片空白 DOM，
 * 报错却指向 App，看起来像组件写错了。真实浏览器里两个 API 都在，所以这是测试
 * 环境的欠缺，不该由产品代码去兜。
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (document.fonts === undefined) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
}
