// jsdom 环境 + RTL：显式注册 cleanup（vitest 默认不开 globals，RTL 无法自动注册），
// 否则上一个用例的 DOM 会漏进下一个，查询就会撞出"重复元素"。
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
