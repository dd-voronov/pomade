// modules: core, tabs
// T-270 e2e — an app frame may write text to the clipboard and not read it (docs/HOST-API.md §5
// "Hosting behavior"). The hello fixture's Copy button writes `hello:<surface>:<route>` with
// `navigator.clipboard.writeText`; the system clipboard (read in the main process) holds it. A
// `navigator.clipboard.readText()` in the same frame is rejected. Covers a tab, a side panel
// and the overlay.

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import {
  expect,
  test,
  type ElectronApplication,
  type Frame,
  type Page,
} from "@playwright/test";

import { firstAppWindow, launchApp } from "./fixtures/app";
import {
  connectedFrame,
  HELLO_DIR,
  openHelloFromMenu,
} from "./fixtures/hello-app";
import { createFixtureWorkspace, type Fixture } from "./fixtures/workspace";

const SHOTS =
  process.env["POMADE_T270_SHOTS"] ||
  resolve(__dirname, "artifacts/app-clipboard");

test.describe("T-270 app frames write to the clipboard", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: Fixture;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace();
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR });
    page = await firstAppWindow(app);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.getByTestId(`project-${fixture.projects.alpha}`).click();
    await fs.mkdir(SHOTS, { recursive: true });
  });

  test.afterAll(async () => {
    await app?.close();
    await fixture?.cleanup();
  });

  const systemClipboard = () =>
    app.evaluate(({ clipboard }) => clipboard.readText());
  const clearClipboard = () =>
    app.evaluate(({ clipboard }) => clipboard.writeText(""));
  const copyResult = (frame: Frame) =>
    frame.evaluate(
      () =>
        window.__hello.copyResult,
    );
  const readAttempt = (frame: Frame) =>
    frame.evaluate(() =>
      navigator.clipboard.readText().then(
        (text) => `read:${text}`,
        (err: Error) => `rejected:${err.name}`,
      ),
    );

  /** Click `button` in the frame, check the write succeeded and a read is refused; returns what the system clipboard holds. */
  async function copyFrom(
    iframeTestId: string,
    button: string,
  ): Promise<string> {
    const frame = await connectedFrame(page.getByTestId(iframeTestId));
    // A frame takes pointer input only after the window has drawn it (HOST-API §5).
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
            ),
          ),
        ),
    );
    await clearClipboard();
    await frame.locator(button).click();
    await expect.poll(() => copyResult(frame)).toBe("copied");
    await expect.poll(systemClipboard).not.toBe("");
    expect(await readAttempt(frame)).toBe("rejected:NotAllowedError");
    await page.screenshot({ path: join(SHOTS, `${iframeTestId}.png`) });
    return systemClipboard();
  }

  test("a tab frame's Copy button puts its text on the system clipboard; reading is refused", async () => {
    await openHelloFromMenu(page);
    expect(await copyFrom("app-frame-hello", "#copy")).toBe("hello:tab:");
  });

  test("a side panel frame's Copy button does the same", async () => {
    await page.getByTestId("strip-app-hello-panel").click();
    expect(await copyFrom("panel-frame-app-hello-panel", "#copy")).toBe(
      "hello:panel:panel",
    );
  });

  test("the overlay frame's Copy button does the same", async () => {
    await page.keyboard.press("Meta+Shift+J");
    await expect(page.getByTestId("app-overlay")).toBeVisible();
    expect(await copyFrom("overlay-frame-hello", "#quick-add-copy")).toBe(
      "hello:overlay:quick-add",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app-overlay")).toHaveCount(0);
  });
});
