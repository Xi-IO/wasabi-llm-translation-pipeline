# Wasabi LLM Subtitle Translator
[English] | [中文](./README_ZH.md)

An end-to-end pipeline for extracting, processing, and translating subtitles from video files using LLM APIs.

## Overview

This project automates the full workflow of subtitle translation:

1. Extract subtitle streams from video files (MKV)  
2. Parse subtitle formats (SRT / ASS)  
3. Clean and preprocess subtitle text  
4. Batch and send text to LLM APIs for translation  
5. Enforce structured JSON outputs for reliability  
6. Rebuild translated subtitles while preserving timing  
7. Mux translated subtitles back into the original video  

The system is designed to handle real-world messy subtitle data and unstable LLM outputs in a robust and repeatable way.

---
## Demo

| Original (English) | Processed (Chinese) |
| :---: | :---: |
| ![Original](./assets/Snipaste_2026-04-06_20-20-52.png) | ![Translated](./assets/Snipaste_2026-04-06_20-19-30.png) |

<p align="center">
  <b>Figure 1:</b> Comparison showing context-aware translation of <i>Rush Hour (2001)</i>. Note the preservation of punctuation and emotional tone.
</p>

---

## Key Features

- Multi-provider LLM support  
  Supports different providers (Qwen, Gemini, etc.) through a unified API interface  

- Structured output enforcement  
  Uses strict prompting and post-processing to ensure valid JSON outputs  

- Batch processing  
  Splits subtitle data into manageable chunks based on size and count limits  

- Retry and fault tolerance  
  Automatically retries failed batches to handle API instability  

- Caching mechanism  
  Stores completed translations to avoid redundant API calls  

- Subtitle format support  
  - SRT parsing and reconstruction  
  - ASS/SSA parsing with style preservation  

- End-to-end automation  
  From video input → translated video output  

---

## Workflow

MKV → Extract → Parse → Clean → Batch → LLM → Validate → Rebuild → Mux

---

## Requirements

- [Node.js](https://nodejs.org/) (v18+)
- ffmpeg / ffprobe installed  
- LLM API key (Qwen, Gemini, etc.)  

---

## Setup

`npm install`  
`cp .env_example .env`  

Fill in your API key in `.env`.

---

## Usage

`node index.js <input_file>`

**Supported input formats:**
- Video files with subtitles: `.mkv`, `.mp4`, `.avi`, `.mov`, `.flv`
- Standalone subtitle files: `.srt`, `.ass`, `.ssa`

**Examples:**
```bash
# Video file → extract, translate, remux
node index.js "My.Movie.1080p.mkv"
node index.js "subtitles.mp4"

# Subtitle file → translate directly
node index.js "english_subtitles.srt"
node index.js "subtitles.ass"
```

**Output:**
- **Video input (.mkv/.mp4)**: 
  - Translated subtitle file: `output/<video_name>/<video_name>.zh.srt`
  - New video with embedded subtitles: `output/<video_name>/<video_name>.zh.mkv`
  
- **Subtitle input (.srt/.ass)**: 
  - Translated subtitle file: `output/<subtitle_name>/<subtitle_name>.zh.srt` (or `.zh.ass`)

**File Organization:**
```
input/
  ├─ <filename>/
  │  └─ <original_file>  (input files moved here after processing)
output/
  ├─ <filename>/
  │  ├─ <filename>.zh.srt  (translated subtitles)
  │  └─ <filename>.zh.mkv  (remuxed video, only for video input)
cache/
  └─ (auto-deleted after completion)
temp/
  └─ (auto-deleted after completion)
```

---

## Technical Highlights

- Designed a full data processing pipeline for unstructured text  
- Implemented robust handling of inconsistent subtitle formats  
- Controlled LLM outputs using strict schema constraints  
- Built retry + caching system for large-scale text processing  
- Integrated external tools (ffmpeg) into automated workflows  

---

## Notes

- Designed for real-world subtitle files with noisy formatting  
- Focused on reliability and reproducibility rather than one-off translation

---

## Credits
This project was inspired by [wasabi_epub](https://github.com/pony65536/wasabi_epub). I've adapted its core philosophy to the domain of **multimedia subtitle data pipelines**, extending the workflow to support MKV/ASS/SRT processing with FFmpeg integration.
