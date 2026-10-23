import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const fixture = fileURLToPath(new URL("fixture.mp4", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console error: ${message.text()}`);
});

function check(condition, message) {
  assert.ok(condition, message);
  console.log(`ok - ${message}`);
}

async function eventually(probe, message, timeout = 10_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (await probe()) return check(true, message);
  }
  assert.fail(message);
}

const canvas = () =>
  page.locator("#ref").evaluate((el) => {
    const { data } = el.getContext("2d").getImageData(0, 0, el.width, el.height);
    let visible = 0;
    let lit = 0;
    let lime = 0;
    const sample = [];
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = data.slice(i, i + 4);
      if (a > 0) visible++;
      if (a > 0 && r + g + b > 60) lit++;
      if (a > 0 && g > 200 && b < 80 && r < g) lime++;
      if (i % 256 === 0) sample.push(r, g, b);
    }
    return { pixels: data.length / 4, visible, lit, lime, sample };
  });
const blank = ({ pixels, lit }) => lit < pixels / 10;
const distance = (a, b) => a.sample.reduce((sum, v, i) => sum + Math.abs(v - b.sample[i]), 0) / a.sample.length;
const stageAspect = () =>
  page.locator("#stage").evaluate((el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height);
const style = (selector, property) => page.locator(selector).evaluate((el, p) => getComputedStyle(el)[p], property);
const stageMode = () => page.locator("#stage").getAttribute("data-mode");
const setSlider = (slider, value) =>
  slider.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);

const camera = page.getByRole("combobox", { name: "Camera" });
const opacity = page.getByRole("slider", { name: "Opacity" });
const frameSlider = page.getByRole("slider", { name: "Frame" });
const modeButton = (name) => page.getByRole("button", { name, exact: true });

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  await eventually(() => page.locator("#cam").evaluate((el) => el.videoWidth > 0), "camera video plays");
  await eventually(async () => (await camera.locator("option").count()) > 0, "camera select lists a device");
  check(!(await frameSlider.isVisible()), "frame slider is hidden before a video is picked");

  await page.getByLabel("Video").setInputFiles(fixture);
  await eventually(async () => !blank(await canvas()), "reference canvas shows frame 0 after picking a video");
  const frame0 = await canvas();
  check(Math.abs((await stageAspect()) / (16 / 9) - 1) < 0.01, "stage takes the 16:9 aspect of the reference");
  check(await frameSlider.isVisible(), "frame slider is visible once a video is loaded");

  await setSlider(frameSlider, "2");
  await eventually(async () => distance(await canvas(), frame0) > 5, "moving the frame slider to 2s redraws the canvas");
  const frame2 = await canvas();

  const expected = {
    Ghost: "ghost",
    Diff: "diff",
    Invert: "invert",
    Contrast: "contrast",
    Edges: "edges",
  };
  for (const [name, mode] of Object.entries(expected)) {
    await modeButton(name).click();
    check((await stageMode()) === mode, `${name} button sets #stage[data-mode=${mode}]`);
    if (mode === "diff") check((await style("#ref", "mixBlendMode")) === "difference", "diff blends the reference by difference");
    if (mode === "invert") check((await style("#ref", "filter")).includes("invert"), "invert filters the reference with invert");
    if (mode === "contrast") check((await style("#cam", "filter")).includes("grayscale"), "contrast puts a grayscale filter on the camera");
    if (mode === "edges") {
      const edges = await canvas();
      check(edges.visible < edges.pixels / 2, "edges leaves most of the canvas transparent");
      check(edges.lime > 0, "edges draws lime lines");
    }
  }

  await modeButton("Contrast").click();
  const before = await style("#ref", "opacity");
  await setSlider(opacity, "0.8");
  check(before === "0.5" && (await style("#ref", "opacity")) === "0.8", "opacity slider changes the reference opacity from 0.5 to 0.8");

  await eventually(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "service worker controls the page");

  await page.reload();
  await eventually(async () => !blank(await canvas()), "stored frame is restored after reload");
  const restored = await canvas();
  check(distance(restored, frame2) < distance(restored, frame0), "restored frame is the 2s frame saved on slider change");
  check(Math.abs((await stageAspect()) / (16 / 9) - 1) < 0.01, "restored stage keeps the 16:9 aspect");
  check((await stageMode()) === "contrast", "mode is restored after reload");
  check((await opacity.inputValue()) === "0.8" && (await style("#ref", "opacity")) === "0.8", "opacity is restored after reload");
  check(!(await frameSlider.isVisible()), "frame slider stays hidden with no video loaded");

  await context.setOffline(true);
  server.close();
  server.closeAllConnections();
  await page.reload();
  check((await page.title()) === "Reshoot", "app loads offline from the service worker cache");
  check((await page.getByRole("group", { name: "Overlay mode" }).getByRole("button").count()) === 5, "mode buttons render offline");
  await eventually(async () => !blank(await canvas()), "stored frame renders offline");

  assert.deepEqual(problems, [], "no page errors or console errors during the run");
  console.log("ok - no page errors or console errors during the run");
} finally {
  await browser.close();
  server.close();
}
