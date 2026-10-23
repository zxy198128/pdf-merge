/*
 * 浏览器端到端测试（Node 22 + Chrome DevTools Protocol）
 * 真实流程：打开页面 → 注入两个 PDF 文件 → 等待解析 → 点击合并 → 校验结果面板与输出 PDF。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const CDP_PORT = 9223;
const PAGE_URL = "http://127.0.0.1:8777/index.html";
const FILE_A = path.join(__dirname, "out", "A.pdf");
const FILE_B = path.join(__dirname, "out", "B.pdf");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("等待超时: " + label);
    await sleep(200);
  }
}

async function main() {
  console.log("1) 启动 Chrome（无头 + 远程调试）…");
  const userDataDir = path.join(__dirname, "chrome-profile");
  const child = spawn(
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    [
      "--headless=new", "--disable-gpu",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1180,1400",
      "about:blank"
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();

  // 拿到调试目标
  const target = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch (e) { return null; }
  }, 20000, "Chrome 调试端口");
  console.log("   已连接:", target.id);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evalJs(expression, awaitPromise = false) {
    const r = await send("Runtime.evaluate", {
      expression, awaitPromise, returnByValue: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error("页面脚本错误: " + JSON.stringify(r.result.exceptionDetails.exception));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  await send("Page.enable");
  await send("Runtime.enable");

  console.log("2) 打开页面…");
  const loaded = new Promise((res) => {
    ws.addEventListener("message", (ev) => {
      if (JSON.parse(ev.data).method === "Page.loadEventFired") res();
    });
  });
  await send("Page.navigate", { url: PAGE_URL });
  await loaded;
  await sleep(600);

  const libOk = await evalJs("!!window.PDFLib && !!window.PDFMergeCore");
  console.log("   依赖加载:", libOk ? "OK" : "FAIL");
  if (!libOk) throw new Error("pdf-lib / merge.js 未加载");

  console.log("3) 注入测试文件（模拟用户选择文件）…");
  const root = await send("DOM.getDocument", { depth: 2 });
  const rootNode = root.result.root.nodeId;
  for (const [sel, file] of [["#fileA", FILE_A], ["#fileB", FILE_B]]) {
    const node = await send("DOM.querySelector", { nodeId: rootNode, selector: sel });
    await send("DOM.setFileInputFiles", {
      nodeId: node.result.nodeId,
      files: [file]
    });
  }

  console.log("4) 等待两个文件解析完成…");
  await waitFor(async () => {
    const st = await evalJs("document.getElementById('status').textContent");
    return st.includes("已就绪");
  }, 15000, "文件解析");
  console.log("   页面排布预览:", (await evalJs(
    "document.getElementById('previewLine').innerText.replace(/\\n/g,' | ')"
  )));

  console.log("5) 点击开始合并…");
  await evalJs("document.getElementById('mergeBtn').click()");
  await waitFor(async () => {
    const shown = await evalJs("document.getElementById('result').classList.contains('show')");
    return shown;
  }, 30000, "合并完成");
  await sleep(800);

  const stats = await evalJs("document.getElementById('resultStats').innerText");
  console.log("   结果面板:", stats);

  console.log("6) 校验合并输出的 PDF…");
  const check = await evalJs(`
    (async () => {
      const src = document.getElementById('previewFrame').src;
      const res = await fetch(src);
      const bytes = await res.arrayBuffer();
      const doc = await PDFLib.PDFDocument.load(bytes);
      return JSON.stringify({
        pages: doc.getPageCount(),
        widths: doc.getPages().map(p => Math.round(p.getWidth()))
      });
    })()
  `, true);
  const out = JSON.parse(check);
  console.log("   输出页数:", out.pages, " 页面宽度序列:", out.widths.join(","));

  const seqOk = JSON.stringify(out.widths) === JSON.stringify([300, 520, 320, 500, 340]);
  const statsOk = /共\s*5\s*页/.test(stats);
  const orderOk = /文件一 P1[\s\S]*文件二 P2[\s\S]*文件一 P2[\s\S]*文件二 P1/.test(
    await evalJs("document.getElementById('previewLine').innerText")
  );

  // 截图交替合并完成后的界面（更新 README 用的截图）
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(__dirname, "..", "docs", "screenshot-alternate.png"), Buffer.from(shot.result.data, "base64"));

  // ---- 顺序合并模式 ----
  console.log("7) 切换到「顺序合并」模式…");
  await evalJs("document.querySelector('input[name=mode][value=sequential]').click()");
  await waitFor(async () => {
    return !(await evalJs("document.getElementById('result').classList.contains('show')"));
  }, 5000, "结果面板收起");
  await sleep(300);

  const opHidden = await evalJs("document.getElementById('altOpts').style.display === 'none'");
  console.log("   交替专属选项已隐藏:", opHidden ? "OK" : "FAIL");
  console.log("   排布预览:", await evalJs(
    "document.getElementById('previewLine').innerText.replace(/\\n/g,' | ')"
  ));

  console.log("8) 顺序合并中…");
  await evalJs("document.getElementById('mergeBtn').click()");
  await waitFor(async () => {
    return await evalJs("document.getElementById('result').classList.contains('show')");
  }, 30000, "顺序合并完成");
  await sleep(800);

  const seqStats = await evalJs("document.getElementById('resultStats').innerText");
  const seqCheck = JSON.parse(await evalJs(`
    (async () => {
      const src = document.getElementById('previewFrame').src;
      const bytes = await (await fetch(src)).arrayBuffer();
      const doc = await PDFLib.PDFDocument.load(bytes);
      return JSON.stringify({
        pages: doc.getPageCount(),
        widths: doc.getPages().map(p => Math.round(p.getWidth()))
      });
    })()
  `, true));
  console.log("   结果面板:", seqStats);
  console.log("   输出页数:", seqCheck.pages, " 页面宽度序列:", seqCheck.widths.join(","));

  const seqModeOk = JSON.stringify(seqCheck.widths) === JSON.stringify([300, 320, 340, 500, 520]);
  const seqStatsOk = /共\s*5\s*页/.test(seqStats);
  const seqOrderOk = /文件一 P1[\s\S]*文件一 P2[\s\S]*文件一 P3[\s\S]*文件二 P1/.test(
    await evalJs("document.getElementById('previewLine').innerText")
  );

  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(__dirname, "..", "docs", "screenshot-sequential.png"), Buffer.from(shot2.result.data, "base64"));

  const allOk = seqOk && statsOk && orderOk && opHidden && seqModeOk && seqStatsOk && seqOrderOk;

  console.log("");
  console.log("交替合并（A1,B2,A2,B1,A3）:", seqOk && statsOk && orderOk ? "PASS" : "FAIL");
  console.log("顺序合并（A1,A2,A3,B1,B2）:", seqModeOk && seqStatsOk && seqOrderOk ? "PASS" : "FAIL");
  console.log(allOk ? "端到端测试全部通过 ✓" : "端到端测试失败 ✗");

  ws.close();
  try { execFileSync("taskkill", ["/F", "/IM", "chrome.exe", "/T"], { stdio: "ignore" }); } catch (e) {}
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E 失败:", err.message);
  try { execFileSync("taskkill", ["/F", "/IM", "chrome.exe", "/T"], { stdio: "ignore" }); } catch (e) {}
  process.exit(1);
});
