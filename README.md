# ST-ChatSlimmer / 聊天瘦身

SillyTavern 第三方扩展，用来**手动**缩小臃肿的聊天文件，缓解长对话在移动端浏览器上保存/解析时崩溃、卡顿的问题。

与 [ST-SwipeCleaner](https://github.com/yoolieer/ST-SwipeCleaner) 互补：SwipeCleaner 负责清理 `swipes`，本插件负责它覆盖不到的两块体积大头——**思维链(reasoning)** 与 **隐藏楼层正文**。

## 功能

- **① 剥离思维链（reasoning）**：删除较早楼层 `extra.reasoning` 及相关字段（`reasoning_duration` / `reasoning_signature` / `reasoning_type`），同时清理 `swipe_info[].extra` 中的同类字段。保留最近 N 层不动，N 可配置（默认 10）。
- **② 删除隐藏楼层**：把 `keepFloors` 之外、被 `/hide` 隐藏（`is_system === true`）的楼层整楼删除。保留最近 N 层，N 可配置（默认 10）。可选保护开场白（楼层 #0）。
- **预览优先**：面板实时显示受影响的楼层范围、数量与预计释放体积。
- **手动触发**：所有删除仅在点击按钮后执行，并有二次确认；不会自动运行。

## 安装

SillyTavern → Extensions → Install Extension，填入仓库地址；或手动放到：

```
SillyTavern/data/<user>/extensions/ST-ChatSlimmer/
```

重载 SillyTavern 后，点扩展菜单（魔杖图标）里的「聊天瘦身」打开面板。

## 使用

1. 打开「聊天瘦身」面板，查看当前总楼层。
2. 设置「保留最近 N 层」，面板会即时显示将处理的楼层范围与预计释放体积。
3. 点击对应按钮执行，确认后写入并保存。

## 安全说明

- 删除隐藏楼层会从存档**永久移除**这些楼层，无法在 app 内撤销。**执行前请先备份聊天文件**。
- 前文记忆若依赖世界书 + 变量系统，删除隐藏历史不影响 AI 上下文（隐藏楼层本就不进 prompt）；当前变量状态保存在最近楼层上，不受影响。
- 若使用「总结(Summary)」类插件且其按楼层索引记录进度，删楼会使索引偏移，请自行评估。

## 结构

- `core.js`：纯逻辑（计划计算、字段剥离、体积估算），不依赖 ST/DOM。
- `index.js`：ST 集成层（菜单按钮、弹窗 UI、保存与重载）。
- `style.css` / `manifest.json`
