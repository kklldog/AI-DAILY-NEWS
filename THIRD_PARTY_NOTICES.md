# 第三方来源与许可

## baoyu-post-to-wechat

- 上游：[JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) 的 `skills/baoyu-post-to-wechat`。
- 本仓库位置：`.agents/skills/baoyu-post-to-wechat/`，包含脚本、测试和参考文档。
- 版权：Copyright (c) 2026 Jim Liu。
- 许可：MIT，完整原文见该目录的 [LICENSE](.agents/skills/baoyu-post-to-wechat/LICENSE)。
- 核实日期：2026-11-08。许可核实使用上游提交
  [`ca703c2d7c2c4399a1dc0cf82224f8551e05a96d`](https://github.com/JimLiu/baoyu-skills/blob/ca703c2d7c2c4399a1dc0cf82224f8551e05a96d/LICENSE)
  的许可证，Git blob SHA 为 `9f2cc0d74570c5841f02b639593d12a70dc7dc65`。

此目录是已有部署使用的**本地修改版**，不是上述上游提交的原样镜像。
随包 `SKILL.md` 声明版本为 `1.118.2`，但源码快照未包含上游 Git 历史，
无法据此确定最初派生的准确提交；上述 SHA 只标识已核实的许可来源。
本地版本包含公众号编辑器正文/标题隔离、图片上传和草稿保存确认，
以及返回首页时保留会话 token、无 token 错误页识别、作者长度预检等适配。
部署时请使用本仓库附带版本，不要直接替换成上游最新版。
本次整理保留这些改动及回归测试，不为上游代码另行指定许可。

## 包管理器依赖

两个脚本目录的 `package.json`、`package-lock.json` / `bun.lock` 记录运行依赖。
`node_modules` 不随源码发布；安装时由包管理器下载，各依赖继续适用其自己的许可证。
其中 `baoyu-md`、`baoyu-chrome-cdp` 也是独立安装的包，并非从第三个全局 skill 目录读取。
重新分发安装后的依赖时，须保留各包附带的许可证及声明。

本文件不将 baoyu 的 MIT 许可扩展到整个仓库；其他项目代码未在本次整理中新增授权条款。
