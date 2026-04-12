# Wasabi LLM 字幕翻译器
[English](./README.md) | [中文]

一个端到端的视频字幕提取、处理与翻译流水线，基于大语言模型（LLM）API实现。

## 概述

本项目自动化完成字幕翻译的完整流程：

1. 从视频文件（MKV）中提取字幕流  
2. 解析字幕格式（SRT / ASS）  
3. 清洗与预处理字幕文本  
4. 批量发送文本至 LLM API 进行翻译  
5. 使用结构化 JSON 输出提高可靠性  
6. 在保留时间轴的前提下重建字幕  
7. 将翻译后的字幕重新封装回原视频  

该系统针对真实世界中杂乱的字幕数据与不稳定的 LLM 输出，提供稳健且可复现的处理方案。

---

## 演示

| 原始（英文） | 处理后（中文） |
| :---: | :---: |
| ![Original](./assets/Snipaste_2026-04-06_20-20-52.jpg) | ![Translated](./assets/Snipaste_2026-04-06_20-19-30.jpg) |

<p align="center">
  <b>图 1：</b> 展示 <i>Rush Hour (2001)</i> 的上下文感知翻译效果，对比标点与情绪表达的保留情况。
</p>

---

## 核心功能

- 多 LLM 提供商支持  
  通过统一 API 接口支持不同模型（Qwen、Gemini 等）

- 结构化输出约束  
  通过严格提示词与后处理，确保输出为合法 JSON  

- 批处理机制  
  根据文本长度与数量限制拆分字幕数据  

- 重试与容错机制  
  自动重试失败批次，应对 API 不稳定  

- 缓存机制  
  存储已完成翻译，避免重复调用 API  

- 字幕格式支持  
  - 支持 SRT 解析与重建  
  - 支持 ASS/SSA，并保留样式  

- 端到端自动化  
  从视频输入 → 翻译后视频输出  

---

## 工作流程

MKV → 提取 → 解析 → 清洗 → 分批 → LLM → 校验 → 重建 → 封装

---

## 依赖环境

- [Node.js](https://nodejs.org/) (v18+)  
- 已安装 ffmpeg / ffprobe  
- LLM API Key（Qwen、Gemini 等）  

---

## 安装

`npm install`  
`cp .env_example .env`  

在 `.env` 中填写 API Key。

---

## 使用方式

`node index.js <输入文件> [--to 目标语言] [--from 源语言]`

默认不传语言参数时，等价于：
`node index.js <输入文件> --to zh-CN`

**支持的输入格式：**
- 包含字幕的视频文件：`.mkv`
- 独立字幕文件：`.srt`、`.ass`、`.ssa`

**语言参数：**
- `--to`：目标语言（默认 `zh-CN`）
- `--from`：源语言（默认 `auto`，让模型自动判断）

**示例：**
```bash
# 视频文件 → 提取、翻译、重新封装
node index.js "My.Movie.1080p.mkv"

# 字幕文件 → 直接翻译
node index.js "english_subtitles.srt"
node index.js "subtitles.ass"

# 指定目标语言（例如日语）
node index.js "english_subtitles.srt" --to ja

# 法语 -> 俄语
node index.js "subtitles.ass" --from fr --to ru
```

**输出：**
- **视频输入 (.mkv)**: 
  - 翻译后的字幕文件：`output/<视频名>/<视频名>.<语言后缀>.srt`
  - 嵌入字幕的新视频：`output/<视频名>/<视频名>.zh.mkv`
  
- **字幕输入 (.srt/.ass)**: 
  - 翻译后的字幕文件：`output/<文件名>/<文件名>.<语言后缀>.srt` (或 `.ass`)

**文件组织结构：**
```
input/
  ├─ <文件名>/
  │  └─ <原始文件>  (处理后移到此位置)
output/
  ├─ <文件名>/
  │  ├─ <文件名>.<语言后缀>.srt  (翻译后的字幕)
  │  └─ <文件名>.zh.mkv  (重新封装的视频，仅限视频输入)
cache/
  └─ (任务完成后自动删除)
temp/
  └─ (任务完成后自动删除)
```  

---

## 技术要点

- 构建了完整的非结构化文本处理流水线  
- 处理不一致字幕格式的鲁棒逻辑  
- 使用严格 schema 控制 LLM 输出  
- 实现重试 + 缓存机制以支持大规模处理  
- 将 ffmpeg 等外部工具整合进自动化流程  

---

## 说明

- 面向真实世界中格式混乱的字幕文件设计  
- 优先保证可靠性与可复现性，而非一次性翻译效果  

---

## 致谢

本项目灵感来源于 [wasabi_epub](https://github.com/pony65536/wasabi_epub)。在其基础思想上，扩展至**多媒体字幕数据处理流水线**，并支持 MKV / ASS / SRT 与 FFmpeg 集成。
