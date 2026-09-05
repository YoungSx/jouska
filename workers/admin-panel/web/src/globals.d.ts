/**
 * vite.config.ts 构建时用 `git describe` 算出、经 `define` 替换进包的构建身份。
 * 本地 dev 走同样路径（脚本在 git 仓库里跑），所以运行时永远有值；只有 git
 * 失败（浅克隆没 tag、源码包）时才会落成 'dev'。
 */
declare const __BUILD_ID__: string;
