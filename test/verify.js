/*
 * 核心合并逻辑验证脚本（Node）
 * 生成两个测试 PDF，每页宽度不同，合并后读回页面宽度来核对顺序。
 * 规则：文件一正序 + 文件二逆序 交替。
 */
const fs = require("fs");
const path = require("path");
const PDFLib = require("../pdf-lib.min.js");
const Core = require("../merge.js");

async function makePdf(label, count, baseWidth, filePath) {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < count; i++) {
    // 每页宽度 = baseWidth + i*20，借此在合并结果里识别来源与序号
    const page = doc.addPage([baseWidth + i * 20, 400]);
    page.drawText(`${label}${i + 1}`, {
      x: 40,
      y: 340,
      size: 36,
      color: PDFLib.rgb(0.15, 0.2, 0.35)
    });
    page.drawText(`width=${baseWidth + i * 20}`, {
      x: 40,
      y: 300,
      size: 12,
      color: PDFLib.rgb(0.45, 0.5, 0.6)
    });
  }
  const bytes = await doc.save();
  fs.writeFileSync(filePath, bytes);
  return bytes;
}

function widths(doc) {
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      实际: [${actual.join(", ")}]`);
  if (!ok) console.log(`      期望: [${expected.join(", ")}]`);
  return ok;
}

(async () => {
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const bytesA = await makePdf("A", 3, 300, path.join(outDir, "A.pdf"));
  const bytesB = await makePdf("B", 2, 500, path.join(outDir, "B.pdf"));

  const docA = await PDFLib.PDFDocument.load(bytesA);
  const docB = await PDFLib.PDFDocument.load(bytesB);
  console.log(`测试文件: A.pdf ${docA.getPageCount()} 页, B.pdf ${docB.getPageCount()} 页\n`);

  let allOk = true;

  // 1) 文件二逆序 + 剩余页追加到末尾
  const appendRes = await Core.mergeAlternating(PDFLib, bytesA, bytesB, { keepRemainder: true, reverseB: true });
  fs.writeFileSync(path.join(outDir, "merged-append.pdf"), appendRes.bytes);
  const appendDoc = await PDFLib.PDFDocument.load(appendRes.bytes);
  console.log("用例 1：文件二逆序，剩余页追加到末尾");
  allOk &= eq(widths(appendDoc), [300, 520, 320, 500, 340], "页面顺序 A1,B2,A2,B1,A3");
  console.log("");

  // 2) 文件二逆序 + 只合并到较短文件为止
  const trimRes = await Core.mergeAlternating(PDFLib, bytesA, bytesB, { keepRemainder: false, reverseB: true });
  fs.writeFileSync(path.join(outDir, "merged-trim.pdf"), trimRes.bytes);
  const trimDoc = await PDFLib.PDFDocument.load(trimRes.bytes);
  console.log("用例 2：文件二逆序，只合并到较短文件为止");
  allOk &= eq(widths(trimDoc), [300, 520, 320, 500], "页面顺序 A1,B2,A2,B1");
  console.log("");

  // 3) 页数相同（3 对 3）
  const bytesC = await makePdf("C", 3, 600, path.join(outDir, "C.pdf"));
  const evenRes = await Core.mergeAlternating(PDFLib, bytesA, bytesC, { keepRemainder: true, reverseB: true });
  const evenDoc = await PDFLib.PDFDocument.load(evenRes.bytes);
  console.log("用例 3：页数相同（3 对 3），文件二逆序");
  allOk &= eq(widths(evenDoc), [300, 640, 320, 620, 340, 600], "页面顺序 A1,C3,A2,C2,A3,C1");
  console.log("");

  // 4) 顺序合并（文件一全部页在前，文件二全部页在后）
  const seqRes = await Core.mergeSequential(PDFLib, bytesA, bytesB);
  fs.writeFileSync(path.join(outDir, "merged-sequential.pdf"), seqRes.bytes);
  const seqDoc = await PDFLib.PDFDocument.load(seqRes.bytes);
  console.log("用例 4：顺序合并（文件一在前，文件二在后）");
  allOk &= eq(widths(seqDoc), [300, 320, 340, 500, 520], "页面顺序 A1,A2,A3,B1,B2");
  allOk &= eq([seqDoc.getPageCount()], [5], "总页数 = 3 + 2");
  console.log("");

  // 5) 顺序合并（文件二页数更多）
  const seqRes2 = await Core.mergeSequential(PDFLib, bytesB, bytesA);
  const seqDoc2 = await PDFLib.PDFDocument.load(seqRes2.bytes);
  console.log("用例 5：顺序合并（文件二页数更多）");
  allOk &= eq(widths(seqDoc2), [500, 520, 300, 320, 340], "页面顺序 B1,B2,A1,A2,A3");
  console.log("");

  // 6) 关闭逆序，应回到正序交替
  const plainRes = await Core.mergeAlternating(PDFLib, bytesA, bytesB, { keepRemainder: true, reverseB: false });
  const plainDoc = await PDFLib.PDFDocument.load(plainRes.bytes);
  console.log("用例 6：交替合并关闭逆序开关（对照）");
  allOk &= eq(widths(plainDoc), [300, 500, 320, 520, 340], "页面顺序 A1,B1,A2,B2,A3");
  console.log("");

  // 7) 非 PDF 输入
  console.log("用例 7：非 PDF 输入应报错");
  let threw = false;
  try {
    await Core.mergeAlternating(PDFLib, Buffer.from("not a pdf"), bytesB, {});
  } catch (err) {
    threw = true;
    console.log("PASS  抛出友好提示: " + err.message);
  }
  if (!threw) console.log("FAIL  没有抛出错误");
  allOk &= threw;

  console.log("\n" + (allOk ? "全部用例通过 ✓" : "存在失败用例 ✗"));
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error("测试脚本异常:", err);
  process.exit(1);
});
