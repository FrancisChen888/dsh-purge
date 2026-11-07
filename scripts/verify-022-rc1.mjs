#!/usr/bin/env node
/**
 * 0.2.2-rc.1 适配验证：把宿主里被 targetFiles 登记的文件复制到隔离副本，
 * 在副本上真打一遍补丁，核对
 *   1) 打之前没有 drifted，
 *   2) 打之后目标补丁全部 applied，
 *   3) 每个被改写的 .js 仍然语法合法（node --check，按 ESM 复制成 .mjs），
 *   4) marker 真的落在文件里。
 *
 * 真实宿主只读，不写一个字节。
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as core from "../lib/core.js";

const SRC_BASE =
  process.env.PURGE_VERIFY_SRC ||
  "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const TARGET_IDS = (process.env.PURGE_VERIFY_IDS || "14,40,54,60,62,67,74,76,88")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));

const work = await fsp.mkdtemp(path.join(os.tmpdir(), "purge-verify-"));
const dstBase = path.join(work, "aiBase");
await fsp.mkdir(dstBase, { recursive: true });

const files = await core.targetFiles(SRC_BASE);
const copyMap = new Map(); // 副本 -><- 原件
let copied = 0;
for (const val of Object.values(files)) {
  const list = Array.isArray(val) ? val : [val];
  for (const fp of list) {
    if (!fp || typeof fp !== "string") continue;
    if (!fp.startsWith(SRC_BASE + path.sep)) continue; // dshHome 下的用户文件不复制、不写
    const rel = path.relative(SRC_BASE, fp);
    const dst = path.join(dstBase, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(fp, dst);
    copyMap.set(dst, fp);
    copied += 1;
  }
}
console.log(`[setup] 副本 ${work} · 复制 ${copied} 个宿主文件`);

const before = await core.patchStatus(dstBase);
const driftedBefore = Object.entries(before).filter(([, v]) => v === "drifted");

const patches = core.ALL_PATCHES.filter((p) => {
  const keys = Array.isArray(p.file) ? p.file : [p.file];
  return !keys.includes("preset-unrestricted"); // 用户自造预设落在 dshHome，不在副本内
});

const report = await core.applyPatches(dstBase, patches, {
  preserveClientBundles: false,
  forApply: true,
});
// na / missing_file / skipped 是「这套布局本来没有这个文件」，不是适配失败。
const notApplied = report.filter((r) => ["pending", "unmatched", "drifted", "error"].includes(r.status));

const after = await core.patchStatus(dstBase);
const stillDrifted = Object.entries(after).filter(([, v]) => v === "drifted");
const targetState = Object.fromEntries(TARGET_IDS.map((id) => [id, after[id] ?? "?<no-key>" ]));

// 语法检查：把改过的 .js 当 ESM 复制成 .mjs 再 node --check
const syntaxErrors = [];
const parserRoot = path.join(work, "syntax");
for (const dst of copyMap.keys()) {
  if (!/\.(js|mjs)$/.test(dst)) continue;
  const target = dst.replace(/\.js$/, ".mjs");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(dst, target);
  try {
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
  } catch (error) {
    syntaxErrors.push([path.relative(dstBase, dst), String(error.stderr || error).split("\n").slice(0, 6).join(" | ")]);
  }
}

// marker 落地核对
const markerMiss = [];
for (const p of core.ALL_PATCHES) {
  const st = after[p.id];
  if (st !== "applied") continue;
  const keys = Array.isArray(p.file) ? p.file : [p.file];
  if (keys.includes("preset-unrestricted")) continue;
  const markers = Array.isArray(p.markers) ? p.markers : [];
  if (markers.length === 0 || p.optional !== true) continue;
  const fps = [];
  for (const key of keys) {
    const val = files[key];
    if (!val) continue;
    for (const fp of Array.isArray(val) ? val : [val]) {
      if (typeof fp === "string" && fp.startsWith(SRC_BASE + path.sep)) {
        fps.push(path.join(dstBase, path.relative(SRC_BASE, fp)));
      }
    }
  }
  const hit = fps.some((fp) => {
    try {
      const text = fs.readFileSync(fp, "utf8");
      return markers.some((m) => text.includes(m));
    } catch {
      return false;
    }
  });
  if (fps.length > 0 && !hit) markerMiss.push(`#${p.id} ${p.name}`);
}

console.log("\n[before] drifted:", JSON.stringify(driftedBefore.map(([id, s]) => `${id}=${s}`)));
console.log("[apply ] 非 applied/already 条目:", notApplied.length);
for (const row of notApplied.slice(0, 20)) console.log(`   ! #${row.patch_id} ${row.name} → ${row.status}`);
const stillPending = Object.entries(after).filter(([, v]) => v === "pending" || v === "unmatched");
console.log("[after ] drifted:", JSON.stringify(stillDrifted.map(([id]) => id)), "· pending:", stillPending.length, JSON.stringify(stillPending.map(([id]) => id)));
console.log("[target] 本次适配的补丁终态:", JSON.stringify(targetState));
console.log("[syntax] 语法报错:", syntaxErrors.length);
for (const [fp, err] of syntaxErrors.slice(0, 10)) console.log(`   ! ${fp}: ${err}`);
console.log("[marker] marker 未落地:", markerMiss.length, markerMiss.slice(0, 10).join(", "));

const ok =
  driftedBefore.length === 0 &&
  stillDrifted.length === 0 &&
  stillPending.length === 0 &&
  syntaxErrors.length === 0 &&
  markerMiss.length === 0 &&
  notApplied.length === 0 &&
  Object.values(targetState).every((v) => v === "applied" || v === "skipped" || v === "na");
console.log(`\n[verdict] ${ok ? "PASS" : "FAIL"}  (副本保留在 ${work})`);
process.exitCode = ok ? 0 : 1;
