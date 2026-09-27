/**
 * React Hook 顺序静态检查（npm run check:hooks）
 *
 * ── 为什么要有这道门禁 ────────────────────────────────────────────────
 * 真实事故（Stage 9.29，2026-09-28）：
 *   components/transfers/TransferOrderPanel.tsx 的 EmpSearch / StoreSearch，
 *   在「已选中」时**提前 return** 一段只读 JSX，可 return 之后还有 useEffect。
 *   用户一选中员工，本次渲染比上次少跑 2 个 Hook，React 直接抛
 *   "Rendered fewer hooks than expected" → 整页
 *   "Application error: a client-side exception has occurred"。
 *
 *   ⚠️ 这玩意儿 tsc / next build **一个字都不会报**，只有运行时点一下才炸，
 *   而且炸的是整页白屏，用户完全看不到原因。所以必须静态兜住。
 *
 * ── 判定规则 ──────────────────────────────────────────────────────────
 * 与 eslint-plugin-react-hooks 的 rules-of-hooks 核心一条等价：
 *   在同一个函数体里，若某条 return **之前已经有 Hook**，
 *   且它**后面还有属于同一函数的 Hook**，
 *   → 走这条分支时后面的 Hook 不会执行 → 报错。
 *
 * ── 实现 ──────────────────────────────────────────────────────────────
 * 1. clean()：把注释与字符串字面量替换成等长空格（保持下标对齐），
 *    否则字符串里的 `{` / `=> ` 会污染花括号配平。
 * 2. findFunctionBodies()：认出哪些 `{` 是**函数体**
 *    —— `=>` 之后紧跟的 `{`，以及 `function name(...)[: Type]` 之后的 `{`。
 *    「㈡」这里是关键：多行解构形参 `function F({\n a,\n b,\n}: {...}) {`
 *    中间夹了好几个花括号，必须跳过形参表和类型标注，否则会认错 body
 *    （这也是第一版脚本漏报的原因）。
 * 3. 一遍花括号栈给每个 Hook / return 找到**归属的最内层函数体**，
 *    这样 useEffect 里的 cleanup `return` 算内层箭头函数的，不会误报。
 * 4. 对每个函数体：hooks 位置排序，凡落在 (firstHook, lastHook) 之间的
 *    return 全部上报。
 *
 * 零第三方依赖，纯 Node，毫秒级。
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** 内置 Hook（含 React 18/19） */
const HOOK_RE =
  /\buse(State|Effect|LayoutEffect|InsertionEffect|Memo|Callback|Ref|Reducer|Context|Transition|DeferredValue|ImperativeHandle|DebugValue|SyncExternalStore|Optimistic|Id|ActionState|FormStatus)\s*</g;

/** 是否 index i 处是独立的单词（前面不是字母/数字/_/$/.，防止匹配到 myRef 之类） */
function isWordAt(s, i, word) {
  if (!s.startsWith(word, i)) return false;
  const before = s[i - 1];
  if (before && /[\w$.]/.test(before)) return false;
  const after = s[i + word.length];
  if (after && /[\w$]/.test(after)) return false;
  return true;
}

/** 跳过空白 */
function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** 从 `(` 处出发，返回匹配的 `)` 下标（从 from 必须是 `(`） */
function matchParen(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从 `{`/`(`/`[`/`<` 出发跳过一个完整的成对区间，返回结束下标之后一位 */
function skipBalanced(s, from) {
  const open = s[from];
  const close = { "{": "}", "(": ")", "[": "]", "<": ">" }[open];
  if (!close) return from + 1;
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

/** 清洗：注释与字符串 → 等长空格 */
function clean(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (src[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === q) {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
    } else i++;
  }
  return out.join("");
}

/**
 * 找出所有**函数体**的起始 `{` 下标。
 * 命中两类： `< arrow params > => {`   与   function name(params)[: Type] {
 */
function findFunctionBodies(s) {
  const bodies = new Set();
  let i = 0;
  while (i < s.length) {
    if (s[i] === "=" && s[i + 1] === ">") {
      let j = skipWs(s, i + 2);
      if (s[j] === "{") bodies.add(j);
      i += 2;
      continue;
    }
    if (isWordAt(s, i, "function")) {
      let j = i + "function".length;
      // 可选函数名 `function* foo` 等，一路找到形参表的 `(`
      const pOpen = s.indexOf("(", j);
      if (pOpen === -1) {
        i = j;
        continue;
      }
      const pClose = matchParen(s, pOpen);
      if (pClose === -1) {
        i = j;
        continue;
      }
      j = skipWs(s, pClose + 1);
      // 跳过类型标注（可能含 `<...>` `{...}` `(...)` 嵌套组合）
      while (j < s.length && s[j] === ":") {
        j = skipWs(s, j + 1);
        while (j < s.length && /[{(\[<]/.test(s[j])) j = skipWs(s, skipBalanced(s, j));
        j = skipWs(s, j);
      }
      if (s[j] === "{") bodies.add(j);
      i = pClose + 1;
      continue;
    }
    i++;
  }
  return bodies;
}

/** Hook 调用位置 */
function hookPositions(s) {
  const pos = [];
  const re = new RegExp(HOOK_RE.source.replace("<", "\\s*(?:<[^=]*)?\\("), "g");
  let m;
  while ((m = re.exec(s))) {
    if (isWordAt(s, m.index, m[0].trim())) pos.push(m.index);
  }
  return pos;
}

function returnPositions(s) {
  const pos = [];
  const re = /\breturn\b/g;
  let m;
  while ((m = re.exec(s))) pos.push(m.index);
  return pos;
}

function checkFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const cleaned = clean(src);
  const hooks = hookPositions(cleaned);
  if (hooks.length === 0) return [];

  const bodies = findFunctionBodies(cleaned);
  const returns = returnPositions(cleaned);

  // 一遍花括号栈：给每个位置标注「归属的最内层函数体」
  const stack = []; // { open:number, isFn:boolean }
  const ownerOf = new Map(); // token pos -> body open index
  const tokens = [...hooks.map((p) => ({ p, kind: "hook" })), ...returns.map((p) => ({ p, kind: "ret" }))]
    .sort((a, b) => a.p - b.p);

  const frameEnd = new Map(); // body open -> matching close index
  let ti = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === "{") {
      stack.push({ open: i, isFn: bodies.has(i) });
      continue;
    }
    if (c === "}") {
      const top = stack.pop();
      if (top && top.isFn) frameEnd.set(top.open, i);
      continue;
    }
    while (ti < tokens.length && tokens[ti].p === i) {
      // 归属 = 栈中最靠近栈顶的那个函数体
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].isFn) {
          ownerOf.set(i, stack[k].open);
          break;
        }
      }
      ti++;
    }
  }

  // 按函数体聚合
  const byBody = new Map();
  for (const t of tokens) {
    const owner = ownerOf.get(t.p);
    if (owner === undefined) continue;
    if (!byBody.has(owner)) byBody.set(owner, { hooks: [], rets: [] });
    byBody.get(owner)[t.kind === "hook" ? "hooks" : "rets"].push(t.p);
  }

  const issues = [];
  for (const [open, { hooks: hs, rets: rs }] of byBody) {
    if (!hs.length || !rs.length) continue;
    const first = Math.min(...hs);
    const last = Math.max(...hs);
    for (const r of rs) {
      if (r > first && r < last) {
        let line = 1;
        for (let k = 0; k < r; k++) if (cleaned[k] === "\n") line++;
        issues.push({ file, line });
      }
    }
  }
  return issues;
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".tsx") || e.name.endsWith(".jsx")) acc.push(p);
  }
  return acc;
}

const files = [...walk(path.join(ROOT, "components")), ...walk(path.join(ROOT, "app"))];
const issues = files.flatMap(checkFile);

console.log(`\n[check:hooks] 扫了 ${files.length} 个组件文件，检查 Hook 调用顺序…\n`);
if (issues.length === 0) {
  console.log("✅ 通过：没有「return 夹在 Hook 中间」的顺序问题。\n");
  process.exit(0);
}
console.log(
  `❌ 发现 ${issues.length} 处会导致 "Rendered fewer hooks than expected" 白屏崩溃：\n`
);
for (const it of issues) console.log(`   ${path.relative(ROOT, it.file)}:${it.line}`);
console.log(
  `\n修法：把提前 return 挪到所有 useState/useEffect/useRef/useMemo… 之后，\n` +
    `     保证每次渲染 Hook 都能无条件跑完（条件分支写在 Hook 里，而不是反过来）。\n`
);
process.exit(1);
