/*
 * PDF 合并核心逻辑（两种模式）
 *   1) 交替合并：A1, B末, A2, B末-1 ...（文件一正序、文件二逆序，逐页交叉装订）
 *   2) 顺序合并：A1, A2, ... A末, B1, B2, ... B末（文件一全部页在前，文件二全部页在后）
 * 同一份代码同时供浏览器（<script>）和 Node 测试使用。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PDFMergeCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * 交替合并的页面计划。
   * keepRemainder = true  -> 较长文件的剩余页追加在末尾
   * keepRemainder = false -> 只合并到较短文件的页数（多余页丢弃）
   * reverseB     = true  -> 第二个文件从最后一页往前取（默认）
   */
  function buildPlan(countA, countB, keepRemainder, reverseB) {
    var total = keepRemainder
      ? Math.max(countA, countB)
      : Math.min(countA, countB);

    var reverse = reverseB !== false;
    var plan = [];

    for (var i = 0; i < total; i++) {
      if (i < countA) plan.push({ src: "A", index: i });
      // 第二个文件逆序：第 i 对使用它的倒数第 i+1 页
      if (i < countB) plan.push({ src: "B", index: reverse ? countB - 1 - i : i });
    }
    return plan;
  }

  /**
   * 顺序合并的页面计划：文件一全部页 → 文件二全部页。
   */
  function buildSequentialPlan(countA, countB) {
    var plan = [];
    var i;
    for (i = 0; i < countA; i++) plan.push({ src: "A", index: i });
    for (i = 0; i < countB; i++) plan.push({ src: "B", index: i });
    return plan;
  }

  function humanError(err, label) {
    var msg = String((err && err.message) || err || "未知错误");
    if (/encrypt/i.test(msg)) {
      return new Error(label + " 是加密 PDF，请先用阅读器去掉密码后再试。");
    }
    if (/No PDF header|Failed to parse|Invalid PDF structure|Expected instance of PDFDict/i.test(msg)) {
      return new Error(label + " 不是有效的 PDF 文件（文件可能已损坏）。");
    }
    return new Error(label + " 读取失败：" + msg);
  }

  async function loadDoc(PDFLib, bytes, label) {
    try {
      return await PDFLib.PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false
      });
    } catch (err) {
      throw humanError(err, label);
    }
  }

  async function loadPair(PDFLib, bytesA, bytesB) {
    var docA = await loadDoc(PDFLib, bytesA, "第一个文件");
    var docB = await loadDoc(PDFLib, bytesB, "第二个文件");

    var countA = docA.getPageCount();
    var countB = docB.getPageCount();
    if (!countA) throw new Error("第一个文件没有任何页面。");
    if (!countB) throw new Error("第二个文件没有任何页面。");

    return { docA: docA, docB: docB, countA: countA, countB: countB };
  }

  async function runMerge(PDFLib, pair, plan) {
    var out = await PDFLib.PDFDocument.create();

    // 批量复制，比逐页复制快很多；顺序由 plan 决定
    var pagesA = await out.copyPages(pair.docA, pair.docA.getPageIndices());
    var pagesB = await out.copyPages(pair.docB, pair.docB.getPageIndices());

    for (var i = 0; i < plan.length; i++) {
      var step = plan[i];
      out.addPage(step.src === "A" ? pagesA[step.index] : pagesB[step.index]);
    }

    out.setProducer("PDF 合并工具");
    out.setCreator("PDF 合并工具");

    var bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });

    return {
      bytes: bytes,
      totalPages: plan.length,
      countA: pair.countA,
      countB: pair.countB,
      plan: plan
    };
  }

  /**
   * 交替合并两个 PDF。
   * @returns {{bytes: Uint8Array, totalPages: number, countA: number, countB: number, plan: Array}}
   */
  async function mergeAlternating(PDFLib, bytesA, bytesB, options) {
    var opts = options || {};
    var keepRemainder = opts.keepRemainder !== false;
    var reverseB = opts.reverseB !== false;

    var pair = await loadPair(PDFLib, bytesA, bytesB);
    var plan = buildPlan(pair.countA, pair.countB, keepRemainder, reverseB);
    return runMerge(PDFLib, pair, plan);
  }

  /**
   * 顺序合并两个 PDF（文件一全部页在前，文件二全部页在后）。
   * @returns {{bytes: Uint8Array, totalPages: number, countA: number, countB: number, plan: Array}}
   */
  async function mergeSequential(PDFLib, bytesA, bytesB) {
    var pair = await loadPair(PDFLib, bytesA, bytesB);
    var plan = buildSequentialPlan(pair.countA, pair.countB);
    return runMerge(PDFLib, pair, plan);
  }

  return {
    buildPlan: buildPlan,
    buildSequentialPlan: buildSequentialPlan,
    mergeAlternating: mergeAlternating,
    mergeSequential: mergeSequential
  };
});
