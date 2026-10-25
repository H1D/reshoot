import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const fixture = fileURLToPath(new URL("fixture.mp4", import.meta.url));
const u32 = (n) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(n);
  return bytes;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.isBuffer(type) ? type : Buffer.from(type), body]);
};
// The fixture keeps moov after mdat, as iPhone files do, so growing moov moves no sample data.
async function shotOn(lensModel, focal35) {
  const tags = {
    "com.apple.quicktime.camera.lens_model": lensModel,
    "com.apple.quicktime.camera.focal_length.35mm_equivalent": focal35,
  };
  const meta = box(
    "meta",
    box("hdlr", Buffer.alloc(8), Buffer.from("mdta"), Buffer.alloc(12)),
    box("keys", u32(0), u32(2), ...Object.keys(tags).map((key) => box("mdta", Buffer.from(key)))),
    box("ilst", ...Object.values(tags).map((value, i) => box(u32(i + 1), box("data", u32(1), u32(0), Buffer.from(value))))),
  );
  const video = await readFile(fixture);
  const type = (at) => video.toString("latin1", at + 4, at + 8);
  const next = (at) => at + video.readUInt32BE(at);
  let moov = 0;
  while (type(moov) !== "moov") moov = next(moov);
  let trak = moov + 8;
  while (type(trak) !== "trak") trak = next(trak);
  const buffer = Buffer.concat([video.subarray(0, next(trak)), meta, video.subarray(next(trak))]);
  buffer.writeUInt32BE(video.readUInt32BE(moov) + meta.length, moov);
  buffer.writeUInt32BE(video.readUInt32BE(trak) + meta.length, trak);
  return { name: "shot.mp4", mimeType: "video/mp4", buffer };
}
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
await context.addInitScript(() => {
  const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  window.seekCount = 0;
  window.seekedCount = 0;
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    ...currentTime,
    set(value) {
      window.seekCount++;
      this.addEventListener("seeked", () => window.seekedCount++, { once: true });
      currentTime.set.call(this, value);
    },
  });
});
const VIRTUAL = ["Back Dual Camera", "Back Dual Wide Camera", "Back Triple Camera"];
const deviceId = (label) => label.toLowerCase().replaceAll(" ", "-");
const iphoneCameras = ["Front Camera", "Back Camera", "Back Ultra Wide Camera", "Back Telephoto Camera", ...VIRTUAL].map((label) => ({
  kind: "videoinput",
  label,
  deviceId: deviceId(label),
  groupId: "",
}));
const matching = await browser.newContext({ viewport: { width: 390, height: 844 } });
await matching.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const feed = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    const ctx = feed.getContext("2d");
    (function paint() {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, feed.width, feed.height);
      if (window.camSource) ctx.drawImage(window.camSource, window.camShift ?? 0, 0);
      requestAnimationFrame(paint);
    })();
    return feed.captureStream(30);
  };
});
const iphone = await browser.newContext({ viewport: { width: 390, height: 844 } });
await iphone.addInitScript(
  ({ devices, virtualId }) => {
    const media = navigator.mediaDevices;
    const getUserMedia = media.getUserMedia.bind(media);
    window.requested = [];
    media.enumerateDevices = async () => devices;
    media.getUserMedia = async ({ video }) => {
      window.requested.push(video.deviceId?.exact ?? video.facingMode);
      const stream = await getUserMedia({ video: true });
      if (!video.deviceId) stream.getVideoTracks()[0].getSettings = () => ({ deviceId: virtualId });
      return stream;
    };
  },
  { devices: iphoneCameras, virtualId: deviceId("Back Triple Camera") },
);
// iOS refuses play() outside a tap in some states, Low Power Mode among them. This checks for a trusted click rather
// than navigator.userActivation, which Playwright's own evaluate calls set, setInputFiles included.
const lowPower = await browser.newContext({ viewport: { width: 390, height: 844 } });
await lowPower.addInitScript(() => {
  const play = HTMLMediaElement.prototype.play;
  window.refusedPlays = 0;
  HTMLMediaElement.prototype.play = function () {
    if (window.event?.isTrusted && window.event.type === "click") return play.call(this);
    window.refusedPlays++;
    return Promise.reject(new DOMException("play() needs a user gesture", "NotAllowedError"));
  };
});

const problems = [];
function watch(page) {
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()} at ${message.location().url}`);
  });
  return page;
}
const page = watch(await context.newPage());
const screenshot = (on, name) => process.env.SCREENSHOT_DIR && on.screenshot({ path: join(process.env.SCREENSHOT_DIR, name) });

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

const canvas = (on = page) =>
  on.locator("#ref").evaluate((el) => {
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
const timeText = (id) => page.locator(`#${id}`).textContent();
const stageMode = () => page.locator("#stage").getAttribute("data-mode");
const setSlider = (slider, value) =>
  slider.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);

const flipButton = (on) => on.getByRole("button", { name: "Flip camera" });
const lensRow = (on) => on.getByRole("group", { name: "Lens" });
const opacity = page.getByRole("slider", { name: "Opacity" });
const frameSlider = page.getByRole("slider", { name: "Frame" });
const modeButton = (name) => page.getByRole("button", { name, exact: true });

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  check((await stageMode()) === "edges", "a fresh install starts in Edges mode");
  const modeNames = [...(await page.getByRole("group", { name: "Overlay mode" }).ariaSnapshot()).matchAll(/button "([^"]+)"/g)];
  check(modeNames.map(([, name]) => name).join() === "Ghost,Contrast,Edges", "the modes are exactly Ghost, Contrast and Edges");
  await modeButton("Ghost").click();

  await eventually(() => page.locator("#cam").evaluate((el) => el.videoWidth > 0), "camera video plays");
  check(!(await frameSlider.isVisible()), "frame slider is hidden before a video is picked");

  await page.getByLabel("Video").setInputFiles({ name: "broken.mp4", mimeType: "video/mp4", buffer: Buffer.from("not a video") });
  await eventually(() => page.locator("#badVideo").isVisible(), "an undecodable video shows an error instead of failing silently");
  check(!(await frameSlider.isVisible()), "frame slider stays hidden after an undecodable video");

  await page.getByLabel("Video").setInputFiles(fixture);
  check(!(await page.locator("#badVideo").isVisible()), "picking a good video clears the error");
  await eventually(async () => !blank(await canvas()), "reference canvas shows frame 0 after picking a video");
  check(Math.abs((await stageAspect()) / (16 / 9) - 1) < 0.01, "stage takes the 16:9 aspect of the reference");
  check(await frameSlider.isVisible(), "frame slider is visible once a video is loaded");
  check((await timeText("now")) === "0:00.00", "the current time reads 0:00.00 once a video is loaded");
  check((await timeText("total")) === "0:03.00", "the duration reads 0:03.00 for the 3 s fixture");

  // Chrome can present frame 1 before the load pauses, so the 0s baseline comes from a seek, as the drag's does.
  await setSlider(frameSlider, "0");
  await eventually(() => page.evaluate(() => window.seekedCount > 0), "a seek to 0s completes");
  const frame0 = await canvas();
  check(
    !(await flipButton(page).isVisible()) && !(await lensRow(page).isVisible()),
    "a single camera with non-iOS labels shows no flip button and no lens pills",
  );

  await setSlider(frameSlider, "2");
  await eventually(async () => distance(await canvas(), frame0) > 5, "moving the frame slider to 2s redraws the canvas");
  const frame2 = await canvas();
  check((await timeText("now")) === "0:02.00", "the current time follows the slider to 0:02.00");
  check((await frameSlider.getAttribute("aria-valuetext")) === "0:02.00", "the slider announces 0:02.00 to screen readers");
  await screenshot(page, "reshoot-timestamps.png");

  const seeksBefore = await page.evaluate(() => window.seekCount);
  await frameSlider.evaluate((el) => {
    for (let i = 19; i >= 0; i--) {
      el.value = i / 10;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await eventually(async () => distance(await canvas(), frame0) < 1, "a fast 20-step drag back to 0s ends on frame 0");
  const seeks = (await page.evaluate(() => window.seekCount)) - seeksBefore;
  check(seeks <= 2, `the fast drag coalesces into at most 2 seeks (issued ${seeks})`);
  await setSlider(frameSlider, "2");
  await eventually(async () => distance(await canvas(), frame2) < 1, "moving back to 2s shows the 2s frame again");

  const expected = {
    Ghost: "ghost",
    Contrast: "contrast",
    Edges: "edges",
  };
  for (const [name, mode] of Object.entries(expected)) {
    await modeButton(name).click();
    check((await stageMode()) === mode, `${name} button sets #stage[data-mode=${mode}]`);
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

  await page.waitForTimeout(400);
  await page.reload();
  await eventually(async () => !blank(await canvas()), "stored frame is restored after reload");
  const restored = await canvas();
  check(distance(restored, frame2) < distance(restored, frame0), "restored frame is the last frame shown (2s)");
  check(Math.abs((await stageAspect()) / (16 / 9) - 1) < 0.01, "restored stage keeps the 16:9 aspect");
  check((await stageMode()) === "contrast", "mode is restored after reload");
  check((await opacity.inputValue()) === "0.8" && (await style("#ref", "opacity")) === "0.8", "opacity is restored after reload");
  check(!(await frameSlider.isVisible()), "frame slider stays hidden with no video loaded");

  const ios = watch(await iphone.newPage());
  const requested = () => ios.evaluate(() => window.requested.join());
  const activeLens = (name) => lensRow(ios).getByRole("button", { name, exact: true, pressed: true }).isVisible();
  const thumbMatchesReference = () =>
    ios.evaluate(() => {
      const look = (el) => {
        const ctx = Object.assign(document.createElement("canvas"), { width: 16, height: 9 }).getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(el, 0, 0, 16, 9);
        return ctx.getImageData(0, 0, 16, 9).data;
      };
      const thumb = look(document.getElementById("thumb"));
      const reference = look(document.getElementById("ref"));
      const lit = reference.filter((v, i) => i % 4 !== 3 && v > 20).length;
      const diff = thumb.reduce((sum, v, i) => sum + Math.abs(v - reference[i]), 0) / thumb.length;
      return lit > reference.length / 8 && diff < 1.2;
    });
  await ios.goto(`http://127.0.0.1:${server.address().port}/`);
  await eventually(() => activeLens("1×"), "a first boot on a virtual iPhone camera ends on the Back Camera with 1× active");
  check((await requested()) === "environment,back-camera", "the virtual camera from environment is replaced exactly once by Back Camera");
  check((await lensRow(ios).getByRole("button").allTextContents()).join() === ".5,1,5", "the lens pills are .5, 1 and 5 in that order");
  const dom = await ios.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll("script").forEach((script) => script.remove());
    return body.outerHTML;
  });
  check(VIRTUAL.every((label) => !dom.includes(label) && !dom.includes(deviceId(label))), "no virtual multi-lens camera appears in the page");

  await lensRow(ios).getByRole("button", { name: ".5" }).click();
  await eventually(
    async () => (await requested()).endsWith(",back-ultra-wide-camera") && (await activeLens(".5×")),
    "tapping .5 opens Back Ultra Wide Camera and shows .5× active",
  );
  await flipButton(ios).click();
  await eventually(
    async () => (await requested()).endsWith(",front-camera") && !(await lensRow(ios).isVisible()),
    "flip opens Front Camera and hides the lens pills",
  );
  await flipButton(ios).click();
  await eventually(
    async () => (await requested()).endsWith("front-camera,back-ultra-wide-camera") && (await activeLens(".5×")),
    "flipping back opens the last back lens, Back Ultra Wide Camera",
  );

  await ios.reload();
  await eventually(() => activeLens(".5×"), "after reload .5× is active");
  check((await requested()) === "back-ultra-wide-camera", "after reload Back Ultra Wide Camera is the only camera requested");

  check(!(await ios.locator("#thumb").isVisible()), "the thumbnail shows the placeholder while no reference exists");
  await ios.getByRole("button", { name: "Ghost", exact: true }).click();
  await ios.getByLabel("Video").setInputFiles(fixture);
  await eventually(thumbMatchesReference, "the thumbnail shows the reference frame after a video is picked");
  check(await ios.locator("#thumb").isVisible(), "the thumbnail replaces the placeholder");

  const zoom = () => ios.locator("#cam").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  await ios.getByLabel("Video").setInputFiles(await shotOn("iPhone back triple camera 6.765mm f/1.78", "28"));
  await eventually(
    async () => (await requested()).endsWith(",back-camera") && (await activeLens("1.2×")),
    "a video shot at 28 mm opens Back Camera and shows 1.2× active",
  );
  check(Math.abs((await zoom()) - 28 / 24) < 0.01, "the camera view is zoomed by 28/24 to match the shot");
  await screenshot(ios, "reshoot-lens-zoom.png");

  await ios.locator("#stage").evaluate((stage) => {
    const fire = (type, pointerId, clientX) =>
      stage.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY: 300, bubbles: true }));
    fire("pointerdown", 1, 150);
    fire("pointerdown", 2, 200);
    fire("pointermove", 2, 250);
    fire("pointerup", 1, 150);
    fire("pointerup", 2, 250);
  });
  await eventually(() => activeLens("2.3×"), "pinching two fingers to twice their distance doubles the zoom to 2.3×");
  check(Math.abs((await zoom()) - 56 / 24) < 0.01, "the camera view follows the pinch");
  await ios.reload();
  await eventually(() => activeLens("2.3×"), "the zoom is restored after reload");

  await ios.getByLabel("Video").setInputFiles(await shotOn("iPhone front camera 2.69mm f/1.9", "24"));
  await eventually(
    async () => (await requested()).endsWith(",front-camera") && !(await lensRow(ios).isVisible()),
    "a video from the front camera opens Front Camera",
  );
  check(Math.abs((await zoom()) - 1) < 0.01, "a 24 mm front camera video leaves the view unzoomed");

  const live = watch(await matching.newPage());
  const cameraFrames = (count) =>
    live.locator("#cam").evaluate(
      (el, n) =>
        new Promise((resolve) => {
          const tick = () => (--n ? el.requestVideoFrameCallback(tick) : resolve());
          el.requestVideoFrameCallback(tick);
        }),
      count,
    );
  const limeAfterFrames = async () => {
    await cameraFrames(10);
    return (await canvas(live)).lime;
  };
  await live.goto(`http://127.0.0.1:${server.address().port}/`);
  await live.evaluate(() => localStorage.setItem("reshoot", JSON.stringify({ mode: "diff" })));
  await live.reload();
  check((await live.locator("#stage").getAttribute("data-mode")) === "edges", "a stored mode that no longer exists falls back to Edges");
  await live.getByLabel("Video").setInputFiles(fixture);
  await live.getByRole("button", { name: "Ghost", exact: true }).click();
  await eventually(async () => !blank(await canvas(live)), "the matching camera page shows frame 0 in Ghost");
  await live.evaluate(() => {
    const ref = document.getElementById("ref");
    window.frame0 = Object.assign(document.createElement("canvas"), { width: ref.width, height: ref.height });
    window.frame0.getContext("2d").drawImage(ref, 0, 0);
  });
  await live.getByRole("button", { name: "Edges", exact: true }).click();
  const all = await limeAfterFrames();
  await live.evaluate(() => (window.camSource = window.frame0));
  const matched = await limeAfterFrames();
  await screenshot(live, "reshoot-edges-matched.png");
  await live.evaluate(() => (window.camShift = 24));
  const shifted = await limeAfterFrames();
  await screenshot(live, "reshoot-edges-shifted.png");
  check(matched < shifted / 10, `a camera lined up with the reference hides the lines (${matched} lime px vs ${shifted} shifted)`);
  check(shifted > all / 4, `a camera 24 px off shows the lines again (${shifted} lime px, ${all} with a black camera)`);

  const lowPowerPage = watch(await lowPower.newPage());
  const tapToShow = lowPowerPage.getByRole("button", { name: "Tap to show the video" });
  const lowPowerSlider = lowPowerPage.getByRole("slider", { name: "Frame" });
  const storedFrame = () => lowPowerPage.evaluate(() => localStorage.getItem("reshoot-frame"));
  await lowPowerPage.goto(`http://127.0.0.1:${server.address().port}/`);
  await lowPowerPage.getByLabel("Video").setInputFiles(await shotOn("iPhone back triple camera 6.765mm f/1.78", "28"));
  await lowPowerPage.waitForTimeout(1000);
  check((await lowPowerPage.evaluate(() => window.refusedPlays)) > 0, "picking a video without a tap gets play() refused");
  check((await storedFrame()) === null, "a refused play saves no frame");
  check(await tapToShow.isVisible(), "a refused play asks for a tap to show the video");
  const lowPowerZoom = await lowPowerPage.locator("#cam").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  check(Math.abs(lowPowerZoom - 28 / 24) < 0.01, `the shot's zoom is matched before the tap (zoom ${lowPowerZoom})`);
  check(!(await lowPowerSlider.isVisible()), "the frame slider stays hidden while the video is not shown");
  await screenshot(lowPowerPage, "reshoot-tap-prompt.png");
  await tapToShow.click();
  check(!(await tapToShow.isVisible()), "the tap prompt goes away once tapped");
  await lowPowerPage.getByRole("button", { name: "Ghost", exact: true }).click();
  await eventually(async () => !blank(await canvas(lowPowerPage)), "the tap shows the reference frame");
  check(await lowPowerSlider.isVisible(), "the frame slider shows after the tap");
  check(await lowPowerPage.locator("#thumb").isVisible(), "the thumbnail shows after the tap");
  await eventually(async () => (await storedFrame()) !== null, "the frame shown after the tap is saved");
  await lowPowerPage.getByLabel("Video").setInputFiles({ name: "again.mp4", mimeType: "video/mp4", buffer: await readFile(fixture) });
  await eventually(() => tapToShow.isVisible(), "picking another video without a tap asks for a tap again");
  check(!(await lowPowerSlider.isVisible()), "the previous video's frame slider hides until the new video shows");

  await context.setOffline(true);
  server.close();
  server.closeAllConnections();
  const offline = await page.reload().catch(() => null);
  check(offline?.ok() && (await page.title()) === "Reshoot", "app loads offline from the service worker cache");
  check((await page.getByRole("group", { name: "Overlay mode" }).getByRole("button").count()) === 3, "mode buttons render offline");
  await eventually(async () => !blank(await canvas()), "stored frame renders offline");

  assert.deepEqual(problems, [], "no page errors or console errors during the run");
  console.log("ok - no page errors or console errors during the run");
} finally {
  await browser.close();
  server.close();
}
