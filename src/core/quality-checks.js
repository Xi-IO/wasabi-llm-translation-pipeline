function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function detectDominantScript(text) {
  const sample = String(text || "");
  const counters = {
    latin: 0,
    cjk: 0,
    cyrillic: 0,
    arabic: 0,
  };

  for (const ch of sample) {
    if (/[A-Za-z]/.test(ch)) counters.latin += 1;
    else if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(ch)) counters.cjk += 1;
    else if (/[\u0400-\u04FF]/.test(ch)) counters.cyrillic += 1;
    else if (/[\u0600-\u06FF]/.test(ch)) counters.arabic += 1;
  }

  const winner = Object.entries(counters).sort((a, b) => b[1] - a[1])[0];
  if (!winner || winner[1] === 0) return null;
  return winner[0];
}

function scriptRatio(text, script) {
  if (!script) return 0;
  const raw = String(text || "");
  const letters = raw.match(/[\p{L}]/gu) || [];
  if (letters.length === 0) return 0;

  let hit = 0;
  for (const ch of letters) {
    if (script === "latin" && /[A-Za-z]/.test(ch)) hit += 1;
    else if (script === "cjk" && /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(ch)) hit += 1;
    else if (script === "cyrillic" && /[\u0400-\u04FF]/.test(ch)) hit += 1;
    else if (script === "arabic" && /[\u0600-\u06FF]/.test(ch)) hit += 1;
  }

  return hit / letters.length;
}

function tokenSimilarity(a, b) {
  const left = new Set(normalizeText(a).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const right = new Set(normalizeText(b).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }

  return (2 * overlap) / (left.size + right.size);
}

export function evaluateNodeQuality({ sourceText, translation }) {
  const src = normalizeText(sourceText);
  const out = normalizeText(translation);
  const reasons = [];

  if (!out) {
    reasons.push("empty-output");
    return { reasons, score: -100 };
  }

  if (src.length >= 20 && out.length <= Math.max(4, Math.floor(src.length * 0.1))) {
    reasons.push("near-empty-output");
  }

  const similarity = tokenSimilarity(src, out);
  if (src.length >= 30 && similarity >= 0.88) {
    reasons.push("abnormal-source-similarity");
  }

  if (/[\p{L}\p{N}]{3,}\s*[（(][^）)\n]{1,30}[）)]/u.test(out)) {
    reasons.push("inline-glossary-artifact");
  }

  const sourceScript = detectDominantScript(src);
  if (sourceScript) {
    const residue = scriptRatio(out, sourceScript);
    const nonSourceScript = ["latin", "cjk", "cyrillic", "arabic"]
      .filter((script) => script !== sourceScript)
      .some((script) => scriptRatio(out, script) >= 0.2);
    if (out.length >= 40 && residue >= 0.35 && nonSourceScript) {
      reasons.push("source-language-residue");
    }
  }

  return {
    reasons,
    score: -reasons.length * 10 - similarity,
  };
}

export function isSuspiciousQuality(result) {
  return (result?.reasons || []).length > 0;
}
