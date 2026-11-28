import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventType, normalizeImages, eventsToMessages, Role } from "../src/kernel/events.ts";
import type { Event, Message } from "../src/kernel/events.ts";
import { estimateMessagesTokens } from "../src/models/base.ts";
import { toApiMessages } from "../src/models/openai-compat.ts";
import { MockProvider } from "../src/models/mock.ts";
import { createAgentOS } from "../src/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+8Z0VAAAAABJRU5ErkJggg==";

test("多模态载荷校验：合法 data/http 通过，非图片/超量/超大/注入被拒", () => {
  assert.equal(normalizeImages(undefined).length, 0);
  assert.equal(normalizeImages([{ url: PNG, name: "x.png" }]).length, 1);
  assert.equal(normalizeImages([{ url: "https://example.com/a.jpg" }])[0]!.url, "https://example.com/a.jpg");
  assert.throws(() => normalizeImages([{ url: "data:text/html;base64,PHNjcmlwdD4=" }]), /仅支持/);
  assert.throws(() => normalizeImages([{ url: "file:///etc/passwd" }]), /仅支持/);
  assert.throws(() => normalizeImages(Array.from({ length: 5 }, () => ({ url: PNG }))), /超过上限/);
  assert.throws(() => normalizeImages({ url: PNG }), /必须是数组/);
  assert.throws(() => normalizeImages([{ url: "x" }]), /必须是字符串|仅支持/);
});

test("事件流保留图片 → Message.images → OpenAI image_url wire 格式", () => {
  const e = { id: "e1", seq: 1, ts: new Date().toISOString(), sessionId: "s", turn: 1, step: 0, type: EventType.UserMessage, payload: { content: "这是什么", images: [{ url: PNG, mimeType: "image/png", name: "a.png" }] } } as Event;
  const msgs = eventsToMessages([e]);
  assert.equal(msgs[0]!.role, Role.User);
  assert.equal(msgs[0]!.images?.[0]!.name, "a.png");
  const api = toApiMessages(msgs)[0]!;
  assert.equal(api.role, "user");
  const parts = api.content as Array<Record<string, unknown>>;
  assert.equal(parts[0]!.type, "text");
  assert.equal(parts[0]!.text, "这是什么");
  assert.equal(parts[1]!.type, "image_url");
  assert.equal((parts[1]!.image_url as { url: string }).url, PNG);
  const plain = toApiMessages([{ role: Role.User, content: "纯文本" }])[0]!;
  assert.equal(typeof plain.content, "string", "无图片时保持旧格式，零回归");
});

test("token 估算计入图片，不按 data URL 字符数计费", () => {
  const withImg: Message = { role: Role.User, content: "hi", images: [{ url: PNG }, { url: PNG }] };
  const plain: Message = { role: Role.User, content: "hi" };
  assert.equal(estimateMessagesTokens([withImg]) - estimateMessagesTokens([plain]), 1536, "每张图固定 768 token");
});

test("真实 AgentOS + MockProvider：图片从 run 流到 provider 边界，被 scripted 回调看到", async () => {
  const root = mkdtempSync(join(tmpdir(), "mm-os-"));
  let seenImages = 0, seenText = "";
  const provider = new MockProvider({
    script: (req, idx) => {
      if (idx === 0) {
        const u = [...req.messages].reverse().find((m) => m.role === "user");
        seenImages = u?.images?.length ?? 0;
        seenText = u?.content ?? "";
      }
      return { content: idx === 0 ? "已收到图片" : "任务完成。", toolCalls: [] };
    },
  });
  const os = createAgentOS({ root, providerOverride: provider, autoApprove: true, plugins: [], config: { ...JSON.parse((await import("node:fs")).readFileSync(join(ROOT, "agentos.config.json"), "utf8")), storage: { dir: root }, permission: { workspace: join(root, "ws"), allowedPaths: [join(root, "ws")] } } as never });
  const s = os.createSession("standard");
  await os.run(s.id, "看图说话", { images: [{ url: PNG, mimeType: "image/png", name: "a.png" }] });
  assert.equal(seenImages, 1, "图片真实到达模型请求边界");
  assert.equal(seenText, "看图说话");
  const replayed = os.getSession(s.id)!.messages();
  assert.ok(replayed.some((m) => m.images?.some((im) => im.mimeType === "image/png")), "图片随只增事件流落盘，可白盒回放");
  await os.shutdown();
});

test("HTTP 级：/api/chat 接受图片并经 SSE 完成；非法图片 400", async () => {
  const root = mkdtempSync(join(tmpdir(), "mm-http-"));
  const provider = new MockProvider({ script: [{ content: "看到图片了", toolCalls: [] }] });
  const os = createAgentOS({ root, providerOverride: provider, autoApprove: true, plugins: [], config: { ...JSON.parse((await import("node:fs")).readFileSync(join(ROOT, "agentos.config.json"), "utf8")), storage: { dir: root }, permission: { workspace: join(root, "ws"), allowedPaths: [join(root, "ws")] } } as never });
  const { startServer } = await import("../src/interfaces/api.ts");
  const server = await startServer(os, { host: "127.0.0.1", port: 0, dataDir: join(root, "data") });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const bad = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", images: [{ url: "data:text/html;base64,PHNjcmlwdD4=" }] }) });
  assert.equal(bad.status, 400);

  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "描述图片", images: [{ url: PNG, mimeType: "image/png" }] }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("看到图片了"), "SSE 收到模型对图片的回答");
  server.close();
  await os.shutdown();
});
